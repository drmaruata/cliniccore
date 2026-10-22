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
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  PUBLISHABLE_KEY,
  SUPABASE_URL,
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

dbDescribe("the platform console's RPC surface over HTTP", () => {
  let accessToken = "";
  const probeUserIds: string[] = [];

  beforeAll(async () => {
    // A REAL signed-in user, and not a platform administrator - the probe helper
    // creates a plain account, so `profiles.is_platform_admin` is false.
    const probe = await createProbeSession();
    probeUserIds.push(probe.userId);
    accessToken = String(decodeCookie(probe.cookie).access_token ?? "");
  });

  afterAll(async () => {
    await deleteProbeUsers(probeUserIds);
  });

  it("answers an empty directory to a signed-in user who is not a platform administrator", async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/tenant_directory`, {
      method: "POST",
      headers: {
        apikey: PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: "{}",
    });
    // 200, and an EMPTY directory: the function's own gate holds over the real
    // transport, with the real JWT, and not only in the impersonated transaction.
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toEqual([]);
  });
});
