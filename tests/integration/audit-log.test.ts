// @vitest-environment node
import { afterAll, expect, it } from "vitest";

import { dbDescribe, beginSession, closePool, expectRejection } from "./helpers/database";

/*
 * Task 8 - private.write_audit, exercised as real sessions.
 *
 * Same impersonation trick as the onboarding test: `set local role authenticated`
 * plus `set_config('request.jwt.claim.sub', ...)` is what PostgREST does with a
 * user's JWT, and both are transaction-local, so every case rolls back.
 *
 * These are the assertions that matter most in this table. write_audit is
 * SECURITY DEFINER owned by postgres with relforcerowsecurity = false on every
 * table, so it bypasses RLS entirely and Task 9's policies are NOT a backstop for
 * it. A missing membership check here let any authenticated user of the SaaS
 * fabricate rows in another tenant's trail.
 *
 * Every refusal has a positive control beside it. A guard that refused everything
 * would satisfy each failure case on its own, which is exactly how the earlier
 * rehearsal produced a false all-clear.
 */

afterAll(async () => {
  await closePool();
});

const ORG_A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ORG_B = "40ba1f42-e4f0-4a0c-9f2b-9f7c1a3d5e01";
const TENANT = "9b2d4f10-3c8a-4b2e-9f0f-1a2b3c4d5e6f";
const OPERATOR = "1d3c5b7a-9e2f-4d6c-8b0a-2c4e6f8a0b1c";

const OWN_MISMATCH = /may only be written for your own organization/;
const NOT_PLATFORM_ADMIN = /or by a platform administrator/;
const FREE_TEXT = /clinical free text/;
const TOO_LONG = /exceeds 128 bytes/;
const TOO_BIG = /exceeds 8 KiB/;

/** Two tenants - one suspended - plus a platform operator, all rolled back later. */
async function stage() {
  const session = await beginSession();

  await session.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'tenant@example.test', '{"full_name":"Tenant"}'),
       ($2, 'operator@example.test', '{"full_name":"Operator"}')`,
    [TENANT, OPERATOR],
  );
  await session.query(
    `insert into public.organizations (id, name, slug, status) values
       ($1, 'Org A', 'audit-a', 'suspended'),
       ($2, 'Org B', 'audit-b', 'active')`,
    [ORG_A, ORG_B],
  );
  await session.query(
    `insert into public.organization_memberships (organization_id, user_id, status)
     values ($1, $2, 'active')`,
    [ORG_B, TENANT],
  );

  // is_platform_admin is settable only by the service role - the guard trigger
  // refuses everyone else - so flipping it here mirrors that constraint rather
  // than bypassing it.
  await session.query("set local role service_role");
  await session.query(`update public.profiles set is_platform_admin = true where id = $1`, [
    OPERATOR,
  ]);
  await session.query("reset role");

  return session;
}

/** Become `userId` for the rest of the transaction. */
async function become(session: Awaited<ReturnType<typeof beginSession>>, userId: string) {
  await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await session.query("set local role authenticated");
}

const write = (
  session: Awaited<ReturnType<typeof beginSession>>,
  orgId: string,
  metadata = "{}",
  action = "patient.read",
  resourceType = "patient",
) =>
  session.query(`select public.write_audit($1::uuid, $2, $3, gen_random_uuid(), $4::jsonb)`, [
    orgId,
    action,
    resourceType,
    metadata,
  ]);

dbDescribe("write_audit", () => {
  it("records the calling user and the metadata verbatim for an active organization", async () => {
    const session = await stage();
    try {
      await become(session, TENANT);
      await write(
        session,
        ORG_B,
        '{"field":"last_name","before":"a","after":"b","changed":["sex"]}',
      );
      await session.resetRole();

      const rows = await session.query<{
        action: string;
        actor: string;
        metadata: Record<string, unknown>;
      }>(
        `select action, actor_user_id::text as actor, metadata
           from public.audit_logs where organization_id = $1::uuid`,
        [ORG_B],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("patient.read");
      expect(rows[0]?.actor).toBe(TENANT);
      expect(rows[0]?.metadata).toEqual({
        field: "last_name",
        before: "a",
        after: "b",
        changed: ["sex"],
      });
    } finally {
      await session.rollback();
    }
  });

  it("refuses another tenant's trail, active or suspended", async () => {
    const session = await stage();
    try {
      await become(session, TENANT);
      // ORG_B is active and the caller IS a member; ORG_A is suspended and they
      // are not. Both must be refused, because the caller is not the operator.
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, 'exported all patients', 'organization', null, '{"ok":1}')`,
        [ORG_A],
        OWN_MISMATCH,
      );
      // Positive control: their own active organization still works.
      await write(session, ORG_B);
      await session.resetRole();
      expect(
        Number(
          (
            await session.query<{ n: string }>(
              `select count(*)::text as n from public.audit_logs where organization_id = $1`,
              [ORG_B],
            )
          )[0]?.n,
        ),
      ).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("lets a platform administrator record a suspension they just performed", async () => {
    // The org-strict guard alone had no writer for this event, which is exactly
    // the case the trail exists to record.
    const session = await stage();
    try {
      await become(session, OPERATOR);
      await write(
        session,
        ORG_A,
        '{"reason":"nonpayment"}',
        "organization.suspended",
        "organization",
      );
      await session.resetRole();
      const rows = await session.query<{ action: string }>(
        `select action from public.audit_logs where organization_id = $1::uuid`,
        [ORG_A],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("organization.suspended");
    } finally {
      await session.rollback();
    }
  });

  it("refuses a platform-scoped event to anyone who is not a platform administrator", async () => {
    const session = await stage();
    try {
      await become(session, TENANT);
      await expectRejection(
        session,
        `select public.write_audit(null, 'platform.tenants.manage', 'organization', null, '{}')`,
        [],
        NOT_PLATFORM_ADMIN,
      );
      // Positive control: the same operator may write the platform-scoped row.
      await session.resetRole();
      await become(session, OPERATOR);
      await session.query(
        `select public.write_audit(null, 'platform.tenants.manage', 'organization', null, '{}')`,
      );
      await session.resetRole();
      expect(
        Number(
          (
            await session.query<{ n: string }>(
              `select count(*)::text as n from public.audit_logs where organization_id is null`,
            )
          )[0]?.n,
        ),
      ).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses clinical free text at any depth, including inside arrays", async () => {
    const session = await stage();
    try {
      await become(session, TENANT);
      // Nested object.
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, 'x', 'y', null, '{"diff":{"before":{"note":"free text"}}}'::jsonb)`,
        [ORG_B],
        FREE_TEXT,
      );
      // Inside an ARRAY - the case a jsonpath wildcard silently skipped.
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, 'x', 'y', null, '{"items":[{"CONTENT":"free text"}]}'::jsonb)`,
        [ORG_B],
        FREE_TEXT,
      );
      // Buried 33 levels down - the case the old `depth < 32` bound let through.
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, 'x', 'y', null,
           (repeat('{"x":', 35) || '{"note":"buried"}' || repeat('}', 35))::jsonb)`,
        [ORG_B],
        FREE_TEXT,
      );
      // Positive control: the same depth with an approved key is accepted, so the
      // refusals above are the screen working rather than everything failing.
      await session.query(
        `select public.write_audit($1::uuid, 'x', 'y', null,
           (repeat('{"x":', 35) || '{"safe":"buried"}' || repeat('}', 35))::jsonb)`,
        [ORG_B],
      );
      await session.resetRole();
      expect(
        Number(
          (
            await session.query<{ n: string }>(
              `select count(*)::text as n from public.audit_logs where organization_id = $1`,
              [ORG_B],
            )
          )[0]?.n,
        ),
      ).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a PROSE VALUE under an innocent key, which is what a key-name screen cannot see", async () => {
    // THE CLOSURE. The old screen was a KEY-NAME blocklist, so a key that did not happen
    // to be on the list carried anything it liked. The harm is in the PROSE, not in the
    // key name - a misspelling does not leak because it is misspelled, it leaks because it
    // carries a sentence. So the value is screened: a string value with whitespace in it
    // is refused whatever the key is called.
    const session = await stage();
    try {
      await become(session, TENANT);
      for (const metadata of [
        `{"code":"patient complains of chest pain since Monday"}`,
        `{"summary":"ok"}`,
        `{"narrative":"ok"}`,
        `{"summry":"short but prose"}`,
        `{" note ":"short but prose"}`,
      ]) {
        await expectRejection(
          session,
          `select public.write_audit($1::uuid, 'x', 'y', null, $2::jsonb)`,
          [ORG_B, metadata],
          /audit metadata rejected/,
        );
      }
    } finally {
      await session.rollback();
    }
  });

  it("accepts identifier-shaped values under keys that are not on the list", async () => {
    // The positive control, and the reason the rule is a VALUE rule: a key nobody listed,
    // carrying a token, is fine. Without this the screen could be satisfied by refusing
    // everything, which is not a screen.
    const session = await stage();
    try {
      await become(session, TENANT);
      await session.query(
        `select public.write_audit($1::uuid, 'x', 'y', null, '{"code":"ok"}'::jsonb)`,
        [ORG_B],
      );
      await session.query(
        `select public.write_audit($1::uuid, 'x', 'y', null, '{"whatever":"42"}'::jsonb)`,
        [ORG_B],
      );
    } finally {
      await session.rollback();
    }
  });

  it("bounds the metadata and the columns the screen cannot police", async () => {
    const session = await stage();
    try {
      await become(session, TENANT);
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, repeat('a', 200), 'organization', null, '{}')`,
        [ORG_B],
        TOO_LONG,
      );
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, 'ok', repeat('r', 100), null, '{}')`,
        [ORG_B],
        TOO_LONG,
      );
      await expectRejection(
        session,
        `select public.write_audit($1::uuid, 'ok', 'y', null, jsonb_build_object('blob', repeat('x', 9000)))`,
        [ORG_B],
        TOO_BIG,
      );
    } finally {
      await session.rollback();
    }
  });
});
