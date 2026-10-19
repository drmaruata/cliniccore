/**
 * Positive existence assertions for the seeded platform role.
 *
 * WHY THIS FILE EXISTS. Every other test that mentions `platform_super_admin` asserts it
 * is ABSENT from something - absent from organization-scoped reads, absent from the
 * generated seed for tenants. Those assertions are all trivially satisfied when the row is
 * MISSING, which is not a hypothetical: a test cleanup sweep deleted the seeded role and
 * its four grants, and nothing anywhere failed - the database had drifted from what its
 * own migrations describe and the only tests that mentioned the row kept passing.
 *
 * That is the general lesson this file exists to enforce: a seeded row that no test
 * requires to EXIST can disappear silently. One positive assertion closes it permanently.
 *
 * Read-only. Runs inside a rolled-back transaction like every other database suite, and
 * unlike them it asserts about rows the migrations own rather than rows this file creates.
 */
import { expect, it } from "vitest";

import { beginSession, dbDescribe } from "./helpers/database";

dbDescribe("the platform seed", () => {
  it("exists with its four platform grants", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{ role: string; grants: string; permissions: string }>(
        `select
           (select count(*) from public.roles
             where organization_id is null and key = 'platform_super_admin') as role,
           (select count(*) from public.role_permissions rp
             join public.roles r on r.id = rp.role_id
            where r.organization_id is null and r.key = 'platform_super_admin') as grants,
           (select count(*) from public.permissions) as permissions`,
      );
      const row = rows[0];
      expect(Number(row?.role), "the seeded platform role must EXIST").toBe(1);
      expect(Number(row?.grants), "and carry exactly its four platform grants").toBe(4);
      expect(Number(row?.permissions)).toBe(21);
    } finally {
      await session.rollback();
    }
  });

  it("matches the keys the registry declares, so a drifted seed is caught by name", async () => {
    // Counting to 4 would pass with the WRONG four. The registry is the authority on what
    // the platform role may hold, so the assertion is on names.
    const { PERMISSIONS } = await import("../../lib/permissions/registry");
    const expected = PERMISSIONS.filter((p) => p.key.startsWith("platform."))
      .map((p) => p.key)
      .sort();

    const session = await beginSession();
    try {
      const rows = await session.query<{ key: string }>(
        `select rp.permission_key as key
           from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
          where r.organization_id is null and r.key = 'platform_super_admin'
          order by rp.permission_key`,
      );
      expect(rows.map((r) => r.key)).toEqual(expected);
    } finally {
      await session.rollback();
    }
  });
});
