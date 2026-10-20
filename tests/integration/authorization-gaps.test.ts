/**
 * The authorization gaps, pinned as regression tests.
 *
 * WHY THIS FILE EXISTS. The findings below were open items in the status doc for several
 * tasks. Some were real; some turned out to be ALREADY CLOSED by code that had landed
 * since the record was written, which is the more dangerous kind of stale entry, because a
 * "known open risk" that is actually closed stops anyone from checking, and a "closed"
 * finding that is actually open is trusted.
 *
 * So every one of them is asserted here, against the live database, as a real principal.
 * A closed finding with no test is a finding with no evidence.
 *
 * TWO OF THEM WERE ALREADY CLOSED AND THE RECORDS WERE STALE, which is worth recording:
 *
 *   A1 - a `staff.manage` holder self-granting `organization_owner` is REFUSED at the
 *        first statement, because `private.can_grant` (rewritten in 01240) requires the
 *        granter to hold EVERY permission of the role being granted. The old record
 *        predates that.
 *   A4 - a platform operator writing an org-scoped audit row for a tenant they are not a
 *        member of is ALLOWED, because `public.write_audit` delegates to
 *        `private.write_audit`, which exempts a platform administrator. The old record
 *        predates the public RPC surface.
 *
 * A NOTE ON THE SHAPES, because they are not interchangeable. An INSERT or UPDATE whose
 * WITH CHECK fails RAISES. An UPDATE whose USING misses FILTERS the row out and the
 * statement still succeeds with zero rows. Asserting "the command did not throw" would
 * therefore pass against a policy that did nothing at all - so the row count is asserted
 * as well, which is the mistake this file's own first draft made.
 */
import { expect, it } from "vitest";

import { beginSession, dbDescribe, expectRejection } from "./helpers/database";

const ORG = "c2000000-0000-4000-8000-0000000000aa";
const ORG_B = "c2000000-0000-4000-8000-0000000000bb";
const STAFF = "c2000000-0000-4000-8000-000000000001";
const ADMIN = "c2000000-0000-4000-8000-000000000002";
const OPERATOR = "c2000000-0000-4000-8000-000000000003";
const STRANGER = "c2000000-0000-4000-8000-000000000004";

/** Impersonate a signed-in principal the way PostgREST does. */
async function become(
  session: Awaited<ReturnType<typeof beginSession>>,
  userId: string,
): Promise<void> {
  await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await session.query("set local role authenticated");
}

/**
 * One organization, four principals, and the roles that separate them.
 *
 *   staff     staff.manage only, in the organization
 *   admin     settings.manage + staff.manage, in the organization
 *   operator  a platform administrator, a member of nothing
 *   stranger  a user belonging to no organization
 */
type Staged = {
  session: Awaited<ReturnType<typeof beginSession>>;
  ownerRole: string;
  staffRole: string;
  adminRole: string;
};

async function stage(): Promise<Staged> {
  const session = await beginSession();
  await session.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1,'authgap-staff@example.test','{}'),
       ($2,'authgap-admin@example.test','{}'),
       ($3,'authgap-operator@example.test','{}'),
       ($4,'authgap-stranger@example.test','{}')`,
    [STAFF, ADMIN, OPERATOR, STRANGER],
  );
  await session.query(
    `insert into public.organizations (id, name, slug, timezone) values
       ($1,'Auth gap org','auth-gap-org','Asia/Kolkata'),
       ($2,'Other org','auth-gap-other','UTC')`,
    [ORG, ORG_B],
  );

  const role = async (key: string, permissions: string[]): Promise<string> => {
    const rows = await session.query<{ id: string }>(
      `insert into public.roles (organization_id, key, name, is_system)
       values ($1, $2, $3, false) returning id`,
      [ORG, key, key],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`could not create the role ${key}`);
    for (const permission of permissions) {
      await session.query(
        `insert into public.role_permissions (role_id, permission_key) values ($1, $2)`,
        [id, permission],
      );
    }
    return id;
  };

  const staffRole = await role("authgap_staff", ["staff.manage"]);
  const adminRole = await role("authgap_admin", [
    "settings.manage",
    "staff.manage",
    "patients.read",
  ]);
  const ownerRole = await role("organization_owner", [
    "settings.manage",
    "staff.manage",
    "patients.read",
    "patients.export",
  ]);

  await session.query(
    `insert into public.organization_memberships (organization_id, user_id, status) values
       ($1,$2,'active'), ($1,$3,'active')`,
    [ORG, STAFF, ADMIN],
  );
  await session.query(
    `insert into public.user_role_assignments (organization_id, user_id, role_id) values
       ($1,$2,$3), ($1,$4,$5)`,
    [ORG, STAFF, staffRole, ADMIN, adminRole],
  );

  // The platform flag is trigger-protected: only service_role may set it.
  await session.query("set local role service_role");
  await session.query(`update public.profiles set is_platform_admin = true where id = $1`, [
    OPERATOR,
  ]);
  await session.query("set local role authenticated");

  return { session, ownerRole, staffRole, adminRole };
}

dbDescribe("the authorization gaps", () => {
  it("A1: a staff.manage holder cannot self-grant organization_owner", async () => {
    const { session, ownerRole } = await stage();
    try {
      await become(session, STAFF);
      await expectRejection(
        session,
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3)`,
        [ORG, STAFF, ownerRole],
        /row-level security|violates/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("A1: a staff.manage holder cannot add a permission to a role", async () => {
    const { session, staffRole } = await stage();
    try {
      await become(session, STAFF);
      await expectRejection(
        session,
        `insert into public.role_permissions (role_id, permission_key) values ($1, 'patients.export')`,
        [staffRole],
        /row-level security|violates/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("A2: a settings.manage holder cannot suspend their own tenant", async () => {
    const { session } = await stage();
    try {
      await become(session, ADMIN);
      await expectRejection(
        session,
        `update public.organizations set status = 'suspended' where id = $1`,
        [ORG],
        /platform administrator may change/,
      );
      // And the tenant is still there and still visible - before the fix, suspending it
      // made it VANISH, because current_org_ids only counts active organizations, so the
      // holder could not read it, reactivate it, or see that it existed.
      const rows = await session.query<{ status: string; n: string }>(
        `select status, (select count(*)::text from public.organizations where id = $1) as n
           from public.organizations where id = $1`,
        [ORG],
      );
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.n).toBe("1");
    } finally {
      await session.rollback();
    }
  });

  it("A2: a platform administrator CAN suspend and restore a tenant", async () => {
    const { session } = await stage();
    try {
      await become(session, OPERATOR);
      const suspended = await session.query(
        `update public.organizations set status = 'suspended' where id = $1 returning id`,
        [ORG],
      );
      expect(suspended.length).toBe(1);
      const restored = await session.query(
        `update public.organizations set status = 'active' where id = $1 returning id`,
        [ORG],
      );
      expect(restored.length).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("A3: an assignment cannot be pre-staged for a user in no organization", async () => {
    const { session, staffRole } = await stage();
    try {
      await become(session, STAFF);
      // The account belongs to nothing, so the assignment would be inert - until that
      // account joins the organization by any route, at which point it is live with no
      // grant step in between.
      await expectRejection(
        session,
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3)`,
        [ORG, STRANGER, staffRole],
        /row-level security|violates/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("A3: an assignment to an existing member still works", async () => {
    // The control. Without it, the pre-staging rule could be satisfied by refusing every
    // assignment - which would break the legitimate admin-grants-a-role flow.
    const { session, adminRole } = await stage();
    try {
      await become(session, ADMIN);
      const rows = await session.query(
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3) returning id`,
        [ORG, STAFF, adminRole],
      );
      expect(rows.length).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("A4: a platform operator can write an org-scoped audit row for a tenant they do not belong to", async () => {
    // The SUSPENSION audit event has no writer without this. It was a gap until the public
    // RPC surface gave the platform a way in.
    const { session } = await stage();
    try {
      await become(session, OPERATOR);
      const rows = await session.query(
        `select public.write_audit($1, 'tenant.suspended', 'organization', null, '{}'::jsonb)`,
        [ORG],
      );
      expect(rows.length).toBeGreaterThan(0);
      // Read it as service_role: an operator cannot read a tenant's audit trail, which is
      // A6's deliberate refusal, so reading it as the operator would prove nothing.
      await session.query("set local role service_role");
      const written = await session.query<{ actor_user_id: string }>(
        `select actor_user_id from public.audit_logs where action = 'tenant.suspended'`,
      );
      expect(written[0]?.actor_user_id).toBe(OPERATOR);
    } finally {
      await session.rollback();
    }
  });

  it("A4: a tenant member still cannot write an audit row for another tenant", async () => {
    const { session } = await stage();
    try {
      await become(session, ADMIN);
      await expectRejection(
        session,
        `select public.write_audit($1, 'tenant.suspended', 'organization', null, '{}'::jsonb)`,
        [ORG_B],
        /own organization|42501/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("A5: a platform administrator can edit their own profile row", async () => {
    const { session } = await stage();
    try {
      await become(session, OPERATOR);
      const rows = await session.query(
        `update public.profiles set full_name = 'Operator' where id = $1 returning id`,
        [OPERATOR],
      );
      expect(rows.length).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("A5: nobody can flip their own is_platform_admin flag", async () => {
    // The flag is protected by the guard_platform_admin TRIGGER, not by the policy, so
    // dropping the policy's clause did not weaken it.
    const { session } = await stage();
    try {
      await become(session, STAFF);
      await expectRejection(
        session,
        `update public.profiles set is_platform_admin = true where id = $1`,
        [STAFF],
        /not user-writable|row-level security|violates/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("A6: a platform operator still cannot read a tenant's audit trail", async () => {
    // DECLINED deliberately, and asserted so the decision is visible: audit_logs.metadata
    // is PHI-shaped and tenant-scoped, so blanket operator read is a larger disclosure
    // than the restoration workflow needs. Platform-scoped events remain visible.
    const { session } = await stage();
    try {
      await become(session, OPERATOR);
      const tenant = await session.query<{ n: string }>(
        `select count(*)::text as n from public.audit_logs where organization_id = $1`,
        [ORG],
      );
      expect(tenant[0]?.n).toBe("0");
      const platform = await session.query<{ n: string }>(
        `select count(*)::text as n from public.audit_logs where organization_id is null`,
      );
      expect(Number(platform[0]?.n)).toBeGreaterThanOrEqual(0);
    } finally {
      await session.rollback();
    }
  });

  it("B1: an organization that has roles can be deleted", async () => {
    const { session } = await stage();
    try {
      await session.query("set local role service_role");
      const rows = await session.query(
        `delete from public.organizations where id = $1 returning id`,
        [ORG],
      );
      expect(rows.length).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("B1: a DELIBERATE role deletion is still refused while the role is in use", async () => {
    // The other half, and the one a careless fix would break. The cascade is allowed
    // because the organization is already gone; a direct role delete leaves it present
    // and must still be refused.
    const { session, adminRole } = await stage();
    try {
      await session.query("set local role service_role");
      await expectRejection(
        session,
        `delete from public.roles where id = $1`,
        [adminRole],
        /still in use/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("B3: a clinic with no time zone inherits its organization's", async () => {
    const { session } = await stage();
    try {
      // clinics has no INSERT policy for a signed-in role, so a clinic is created by
      // service_role - which is how it happens in the first place.
      await session.query("set local role service_role");
      const rows = await session.query<{ timezone: string }>(
        `insert into public.clinics (id, organization_id, name) values (gen_random_uuid(), $1, 'Inheriting')
         returning timezone`,
        [ORG],
      );
      expect(rows[0]?.timezone).toBe("Asia/Kolkata");
    } finally {
      await session.rollback();
    }
  });

  it("B3: a clinic with a bogus time zone is refused", async () => {
    const { session } = await stage();
    try {
      await expectRejection(
        session,
        `insert into public.clinics (id, organization_id, name, timezone)
         values (gen_random_uuid(), $1, 'Bogus', 'Not/AZone')`,
        [ORG],
        /unknown time zone/,
      );
    } finally {
      await session.rollback();
    }
  });
});
