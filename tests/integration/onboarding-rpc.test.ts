// @vitest-environment node
import { afterAll, expect, it } from "vitest";

import { ROLES } from "@/lib/permissions/registry";

import { dbDescribe, beginSession, closePool } from "./helpers/database";

/*
 * Task 8 - the onboarding RPC, exercised as a real tenant session.
 *
 * No HTTP is involved. `set local role authenticated` plus
 * `set_config('request.jwt.claim.sub', ...)` is exactly what PostgREST does with a
 * user's JWT, and both are transaction-local, so the whole test rolls back and
 * leaves nothing behind. That matters here more than usual: the rows it creates
 * are tenant-shaped.
 *
 * The expected grant count is computed from the registry rather than written as a
 * literal. That is the point of the file: onboarding-seed.test.ts proves the
 * MIGRATION FILE matches lib/permissions/registry.ts, and this proves the
 * DATABASE does - which is a different failure, and the one that reached this
 * project twice.
 */

afterAll(async () => {
  await closePool();
});

const ORG_ROLES = ROLES.filter((role) => !role.isPlatform);
const EXPECTED_ORG_GRANTS = ORG_ROLES.reduce((total, role) => total + role.permissions.length, 0);

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER_EMAIL = "onboarding-rpc-probe@example.test";

/** Insert an auth user as the owner, then become that user for the rest of the test. */
async function actAsFreshUser(): Promise<{ session: Awaited<ReturnType<typeof beginSession>> }> {
  const session = await beginSession();
  await session.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"full_name":"Probe"}')`,
    [USER_ID, USER_EMAIL],
  );
  await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [USER_ID]);
  await session.query("set local role authenticated");
  return { session };
}

dbDescribe("create_organization_with_owner", () => {
  it("bootstraps one organization, one active membership, one clinic and the full role matrix", async () => {
    const { session } = await actAsFreshUser();
    try {
      const created = await session.query<{ org: string }>(
        `select public.create_organization_with_owner('Probe Org', 'probe-org', 'Probe Clinic') as org`,
      );
      const orgId = created[0]?.org;
      expect(orgId).toMatch(/^[0-9a-f-]{36}$/);

      // Back to the owner to count: RLS would otherwise return nothing.
      await session.resetRole();

      // SCOPED TO THE ORGANIZATION THIS CALL CREATED, not global counts.
      //
      // MEASURED: these were `select count(*) from public.organizations` and friends, and
      // they passed only because no other test wrote an organization concurrently. Task 13
      // added a second integration suite that creates and deletes organizations, and this
      // test then failed roughly one full-suite run in two - a flake in someone else's
      // test, caused by an assertion that depended on state it does not own.
      //
      // Scoping every count to `orgId` makes it correct regardless of what else is running,
      // which is the only property an assertion about "the RPC bootstraps one X" can have.
      const counts = await session.query<{
        orgs: string;
        memberships: string;
        active_memberships: string;
        clinics: string;
        org_roles: string;
        org_grants: string;
        assignments: string;
      }>(
        `select (select count(*) from public.organizations where id = $1) as orgs,
                (select count(*) from public.organization_memberships where organization_id = $1) as memberships,
                (select count(*) from public.organization_memberships
                   where organization_id = $1 and status = 'active') as active_memberships,
                (select count(*) from public.clinics where organization_id = $1) as clinics,
                (select count(*) from public.roles where organization_id = $1) as org_roles,
                (select count(*) from public.role_permissions rp
                   join public.roles r on r.id = rp.role_id
                  where r.organization_id = $1) as org_grants,
                (select count(*) from public.user_role_assignments where organization_id = $1) as assignments`,
        [orgId],
      );
      const row = counts[0];
      expect(Number(row?.orgs)).toBe(1);
      expect(Number(row?.memberships)).toBe(1);
      expect(Number(row?.active_memberships)).toBe(1);
      expect(Number(row?.clinics)).toBe(1);
      expect(Number(row?.org_roles)).toBe(ORG_ROLES.length);
      expect(Number(row?.org_grants)).toBe(EXPECTED_ORG_GRANTS);
      expect(Number(row?.assignments)).toBe(1);

      const owner = await session.query<{ role_key: string; clinic_scoped: boolean }>(
        `select r.key as role_key, a.clinic_id is not null as clinic_scoped
           from public.user_role_assignments a
           join public.roles r on r.id = a.role_id
          where a.organization_id = $1`,
        [orgId],
      );
      // Org-wide: an owner administers the organization, not one clinic.
      expect(owner[0]?.role_key).toBe("organization_owner");
      expect(owner[0]?.clinic_scoped).toBe(false);

      // The platform role must never be seeded per tenant.
      const leaked = await session.query<{ n: string }>(
        `select count(*)::text as n from public.roles where organization_id is not null and key = 'platform_super_admin'`,
      );
      expect(Number(leaked[0]?.n)).toBe(0);
    } finally {
      await session.rollback();
    }
  });

  it("gives the new owner real tenant authority and no platform authority", async () => {
    const { session } = await actAsFreshUser();
    try {
      const created = await session.query<{ org: string }>(
        `select public.create_organization_with_owner('Probe Org 2', 'probe-org-2', 'Clinic') as org`,
      );
      const orgId = created[0]?.org as string;

      const checks = await session.query<Record<string, boolean>>(
        `select
           (select private.can($1::uuid, 'patients.read', null)) as can_read_patients,
           (select private.can($1::uuid, 'appointments.manage', null)) as can_manage_appointments,
           (select private.can($1::uuid, 'platform.tenants.manage', null)) as can_manage_platform,
           (select private.is_member($1::uuid)) as is_member,
           (select count(*) from private.clinic_ids($1::uuid)) as clinic_count`,
        [orgId],
      );
      expect(checks[0]?.can_read_patients).toBe(true);
      expect(checks[0]?.can_manage_appointments).toBe(true);
      // The owner is not a platform operator, and the guard refuses the platform
      // matrix even through a platform role.
      expect(checks[0]?.can_manage_platform).toBe(false);
      expect(checks[0]?.is_member).toBe(true);
      // No clinic_memberships row was created, so the all-active-clinics fallback
      // gives them the one clinic they own.
      expect(Number(checks[0]?.clinic_count)).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a second organization with the same slug", async () => {
    const { session } = await actAsFreshUser();
    try {
      await session.query(
        `select public.create_organization_with_owner('First', 'duplicate-slug', 'Clinic')`,
      );
      await expect(
        session.query(
          `select public.create_organization_with_owner('Second', 'duplicate-slug', 'C2')`,
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const session = await beginSession();
    try {
      // No set_config: auth.uid() is NULL, which is exactly what PostgREST gives
      // an anon request.
      await session.query("set local role authenticated");
      await expect(
        session.query(`select public.create_organization_with_owner('X', 'x-slug', 'C')`),
      ).rejects.toThrow(/onboarding requires an authenticated user/);
    } finally {
      await session.rollback();
    }
  });
});
