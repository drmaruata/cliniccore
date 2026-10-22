// @vitest-environment node
/*
 * The platform console's database access: the predicate, the refusal, and the count.
 *
 * WHY THIS FILE EXISTS AND WHY IT NEEDS THE DATABASE. The E2E spec proves the ROUTE -
 * a clinic owner is refused and an operator is not. This file proves the two facts the
 * route rests on, at the level they are decided:
 *
 *   1. `public.tenant_directory()` refuses a caller who is not a platform
 *      administrator, by returning no rows.
 *   2. The member count in that directory is NOT available to an ordinary read of the
 *      memberships table - not even to a platform administrator.
 *
 * The second is the reason the directory is a definer, and it is measured here rather
 * than asserted: `organization_memberships_select`'s row filter is
 * `private.is_member(organization_id)`, so a principal who belongs to no tenant sees no
 * membership rows at all. MEASURED: a platform administrator reads ZERO membership rows
 * for a tenant with one member, while the directory reports that member as 1. A future
 * refactor that took the count from an ordinary read would silently report zero for
 * every tenant, and this assertion is what would notice.
 *
 * THE PRINCIPAL IS IMPERSONATED, NOT MOCKED. `set local role authenticated` plus
 * `select set_config('request.jwt.claim.sub', …, true)` is what PostgREST builds from a
 * JWT, and both are transaction-local - so the rollback leaves nothing behind.
 *
 * AND THE REAL TRANSPORT TOO, FOR THE REFUSAL. The impersonated call above proves the
 * FUNCTION refuses; the second suite proves the RPC SURFACE refuses, over real HTTPS
 * with a real signed-in user's JWT. The E2E cannot reach that path - the interface
 * never issues the call for an unauthorised caller, because the route has already
 * 404'd - so nothing else covers it.
 *
 * AND THAT SUITE HAS A POSITIVE CONTROL BESIDE THE REFUSAL, WHICH IT DID NOT HAVE
 * ONCE. The first version asserted only that a non-administrator receives an empty
 * directory - and the database held no organization at all, so an UNGUARDED
 * `tenant_directory` would have answered `[]` too. The assertion proved the transport
 * and not the refusal. Three things fix that, and all three are needed:
 *
 *   1. the predicate is asserted over the SAME token, so the test knows which
 *      principal it is talking about without looking at the directory's contents;
 *   2. ONE ORGANIZATION IS SEEDED and kept, so an empty directory means REFUSED
 *      rather than "there was nothing there";
 *   3. an ADMINISTRATOR'S TOKEN is asked for the same directory and must receive that
 *      row, so the pair can only pass if the guard is what separates them.
 *
 * MEASURED: with the `where (select private.is_platform_admin())` clause removed from
 * the function (by a temporary correction, never by editing an applied migration), the
 * non-administrator's assertion FAILS - it receives the seeded row - and the
 * administrator's still passes.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  admin,
  createProbeSession,
  decodeCookie,
  deleteProbeUsers,
} from "../helpers/auth-session-fixture";
import { beginSession, dbDescribe } from "./helpers/database";

const OPERATOR = "eeeeeeee-5555-4555-8555-eeeeeeee0001";
const MEMBER = "eeeeeeee-5555-4555-8555-eeeeeeee0002";
const ORG_ID = "eeeeeeee-5555-4555-8555-eeeeeeee0003";

/** A type alias, not an interface: the query helper's generic wants an index signature. */
type DirectoryRow = {
  name: string;
  status: string;
  member_count: number;
};

dbDescribe("the platform console's database access", () => {
  it("refuses the directory to a non-administrator, and counts the members of a tenant for one", async () => {
    const session = await beginSession();
    try {
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
           ($1, 'console-operator@example.test', now(), '{}'),
           ($2, 'console-member@example.test', now(), '{}')`,
        [OPERATOR, MEMBER],
      );
      await session.query(
        `insert into public.organizations (id, name, slug, status) values
           ($1, 'Console tenant', 'console-tenant', 'active')`,
        [ORG_ID],
      );
      await session.query(
        `insert into public.organization_memberships (organization_id, user_id, status)
         values ($1, $2, 'active')`,
        [ORG_ID, MEMBER],
      );

      // The operator: a signed-in principal who belongs to no tenant.
      await session.query("set local role authenticated");
      await session.query("select set_config('request.jwt.claim.sub', $1, true)", [OPERATOR]);

      const [predicate] = await session.query<{ admin: boolean }>(
        `select public.is_platform_admin() as admin`,
      );
      expect(predicate?.admin).toBe(false);

      const refused = await session.query<DirectoryRow>(
        `select name, status, member_count from public.tenant_directory()`,
      );
      expect(
        refused,
        "the directory must be empty for a caller who is not an administrator",
      ).toEqual([]);

      // Promote the operator the only way the schema allows: as the service role.
      await session.query("reset role");
      await session.query("set local role service_role");
      await session.query(`update public.profiles set is_platform_admin = true where id = $1`, [
        OPERATOR,
      ]);
      await session.query("reset role");
      await session.query("set local role authenticated");
      await session.query("select set_config('request.jwt.claim.sub', $1, true)", [OPERATOR]);

      const [promoted] = await session.query<{ admin: boolean }>(
        `select public.is_platform_admin() as admin`,
      );
      expect(promoted?.admin).toBe(true);

      // The memberships an ordinary read would have counted.
      const visible = await session.query<{ id: string }>(
        `select id from public.organization_memberships`,
      );
      expect(
        visible.length,
        "a platform administrator belongs to no tenant, so the memberships policy hides every row from them",
      ).toBe(0);

      // And the directory, which counts them anyway. Scoped to THIS tenant: the suite
      // runs its files in parallel, so another file's tenant may be in the directory at
      // the same time, and the assertion is about this one.
      const directory = await session.query<DirectoryRow>(
        `select name, status, member_count from public.tenant_directory()`,
      );
      expect(directory.filter((row) => row.name === "Console tenant")).toEqual([
        { name: "Console tenant", status: "active", member_count: 1 },
      ]);
    } finally {
      await session.rollback();
    }
  });
});

/** The tenant the HTTP suite seeds, so that an empty directory means REFUSED. */
const HTTP_TENANT_NAME = "Console HTTP Tenant";

dbDescribe("the platform console's RPC surface over HTTP", () => {
  let nonAdminToken = "";
  let adminToken = "";
  const probeUserIds: string[] = [];
  const seededOrgIds: string[] = [];

  const rpc = async (fn: string, token: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    return { status: response.status, body: await response.text() };
  };

  beforeAll(async () => {
    // A REAL signed-in user who is not a platform administrator: the probe helper
    // creates a plain account, so `profiles.is_platform_admin` is false.
    const plain = await createProbeSession();
    probeUserIds.push(plain.userId);
    nonAdminToken = String(decodeCookie(plain.cookie).access_token ?? "");

    // A SECOND real account, promoted through the service role - the only door into
    // the flag. The JWT does not carry it: the predicate reads the PROFILE, so the
    // token issued before the promotion is the token used after it.
    const administrator = await createProbeSession();
    probeUserIds.push(administrator.userId);
    adminToken = String(decodeCookie(administrator.cookie).access_token ?? "");

    const { error: flagError } = await admin()
      .from("profiles")
      .update({ is_platform_admin: true })
      .eq("id", administrator.userId);
    if (flagError) {
      throw new Error(`could not promote the probe administrator: ${flagError.message}`);
    }

    // AND A TENANT TO LOOK AT. Without it the directory is empty for everybody, and
    // "empty" would prove nothing about the refusal.
    const slug = `console-http-${Date.now()}-${process.pid}`;
    const { data: org, error: orgError } = await admin()
      .from("organizations")
      .insert({ name: HTTP_TENANT_NAME, slug })
      .select("id")
      .single();
    if (orgError || !org) {
      throw new Error(`could not seed the tenant: ${orgError?.message}`);
    }
    seededOrgIds.push(org.id);
  });

  afterAll(async () => {
    // The tenant first: it is the parent of everything else.
    for (const id of seededOrgIds) {
      await admin().from("organization_memberships").delete().eq("organization_id", id);
      await admin().from("clinics").delete().eq("organization_id", id);
      await admin().from("organizations").delete().eq("id", id);
    }
    await deleteProbeUsers(probeUserIds);
  });

  it("refuses the directory to a signed-in user who is not a platform administrator", async () => {
    // THE PRECONDITION, which does not depend on the directory's contents: this
    // principal is not a platform administrator.
    const predicate = await rpc("is_platform_admin", nonAdminToken);
    expect(predicate.status, predicate.body).toBe(200);
    expect(JSON.parse(predicate.body)).toBe(false);

    // And the refusal, with a tenant in the database to refuse.
    const response = await rpc("tenant_directory", nonAdminToken);
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it("answers the same directory to an administrator", async () => {
    // THE POSITIVE CONTROL BESIDE THE REFUSAL. The same function, the same tenant and
    // the same transport - and this principal IS a platform administrator.
    const predicate = await rpc("is_platform_admin", adminToken);
    expect(predicate.status, predicate.body).toBe(200);
    expect(JSON.parse(predicate.body)).toBe(true);

    const response = await rpc("tenant_directory", adminToken);
    expect(response.status, response.body).toBe(200);
    const rows = JSON.parse(response.body) as Array<{
      name: string;
      status: string;
      member_count: number;
    }>;
    // Scoped to THIS tenant: the suite runs its files in parallel, so another file's
    // tenant may be in the directory at the same time.
    expect(rows.filter((row) => row.name === HTTP_TENANT_NAME)).toEqual([
      { name: HTTP_TENANT_NAME, status: "active", member_count: 0 },
    ]);
  });
});
