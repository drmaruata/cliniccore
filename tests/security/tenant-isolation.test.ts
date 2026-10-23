// @vitest-environment node
/**
 * Two organizations, two principals, and a mutation harness that proves each assertion
 * can fail.
 *
 * THE INVARIANT UNDER TEST. A member of one tenant cannot see, change, remove or
 * reference a single row of another, on any of the eleven tenant-owned tables, through
 * any of the three write paths, or through the storage object name that carries the
 * tenant instead of a foreign key.
 *
 * WHY THE PRINCIPALS ARE REAL CLIENTS. The suite's value is that it measures what a
 * tenant principal can reach, so the measurement cannot be made by the service role,
 * which bypasses row-level security. Each principal is a real account signed in over its
 * own cookie jar carrying only its own JWT - never one shared admin account.
 *
 * WHY `role_permissions` IS CHECKED THROUGH ITS ROLE. MEASURED: the table has no
 * `organization_id` column at all - it hangs off a role, and the role carries the
 * organization - so "every visible row must be A's own" is asked as "every visible row's
 * role must be one of A's own roles", which is the same invariant through the join the
 * policies themselves use. An assertion on a column that does not exist measures
 * nothing, which is what the first version of this suite did.
 *
 * WHY EVERY REFUSAL CARRIES A POSITIVE CONTROL. A policy set that refuses everything
 * passes every refusal-only assertion, and three of the eleven tables have no row unless
 * the tenant writes one, so the fixture seeds one of everything through the same client.
 *
 * WHY THE MUTATION HALF IS A SEPARATE, ROLLED-BACK TRANSACTION. Dropping or loosening a
 * policy takes a database-wide AccessExclusiveLock, so it cannot be committed while
 * other suites run, and it cannot be done from a client at all - PostgREST exposes the
 * public schema and no DDL. The second half therefore runs on a direct connection inside
 * a transaction it always rolls back, impersonating the same two principals with the
 * same `set local role` + JWT-claim reproduction PostgREST uses. See mutation-harness.ts
 * for why the order of apply / verify / fail / restore / pass is the harness's job, and
 * why refusals are mutated by LOOSENING while select policies are mutated by DROPPING.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AUTH_COOKIE,
  admin,
  clientOverJar,
  createProbeSession,
  deleteProbeUsers,
} from "../helpers/auth-session-fixture";
import { dbDescribe, expectRejection } from "../integration/helpers/database";
import { destroyTwoOrganizations, seedTwoOrganizations, type TwoTenants } from "./fixtures";
import {
  mutationReport,
  openHarness,
  renderMutationReport,
  type MutationHarness,
} from "./mutation-harness";

/**
 * Every tenant-owned table, the column its tenant scope is reachable through, and its
 * primary key.
 *
 * `role_permissions` is the one without an organization column - its tenant scope is
 * reachable through `role_id` - and its primary key is (role_id, permission_key), so "by
 * primary key" is asked per column. `organizations` is its own tenant root, so its scope
 * column is its id.
 */
const TENANT_TABLES: Array<{ table: string; tenant: string; key: string[] }> = [
  { table: "patients", tenant: "organization_id", key: ["id"] },
  { table: "patient_identifiers", tenant: "organization_id", key: ["id"] },
  { table: "clinics", tenant: "organization_id", key: ["id"] },
  { table: "clinic_memberships", tenant: "organization_id", key: ["id"] },
  { table: "organization_memberships", tenant: "organization_id", key: ["id"] },
  { table: "roles", tenant: "organization_id", key: ["id"] },
  { table: "role_permissions", tenant: "role_id", key: ["role_id", "permission_key"] },
  { table: "user_role_assignments", tenant: "organization_id", key: ["id"] },
  { table: "invitations", tenant: "organization_id", key: ["id"] },
  { table: "audit_logs", tenant: "organization_id", key: ["id"] },
  { table: "organizations", tenant: "id", key: ["id"] },
];

/** Tables with an UPDATE policy the tenant's own administrator can pass. */
const UPDATABLE = [
  "patients",
  "patient_identifiers",
  "clinics",
  "clinic_memberships",
  "organization_memberships",
  "roles",
  "user_role_assignments",
  "invitations",
  "organizations",
  "role_permissions",
];

/** Tables with a DELETE policy. The rest filter every delete, which is also a refusal. */
const DELETABLE = [
  "patients",
  "patient_identifiers",
  "clinic_memberships",
  "roles",
  "user_role_assignments",
  "invitations",
  "role_permissions",
];

/** Tables whose UPDATE policy is mutation-verified. MEASURED: all ten exist; `organizations_update` was restored by `01880`. */
const UPDATE_MUTATIONS = [
  "patients",
  "patient_identifiers",
  "clinics",
  "clinic_memberships",
  "organization_memberships",
  "roles",
  "user_role_assignments",
  "invitations",
  "role_permissions",
  "organizations",
];

/**
 * Tables whose DELETE policy is mutation-verified. `roles` is absent ON PURPOSE:
 * MEASURED, `private.role_in_use` counts `role_permissions` grants, so every seeded role
 * is "in use" and `guard_role_delete` refuses it for the role's OWN tenant as much as
 * for a stranger - the cross-tenant delete is refused by a layer that is not tenant
 * logic at all, and loosening the policy cannot make the assertion move.
 */
const DELETE_MUTATIONS = [
  "patients",
  "patient_identifiers",
  "clinic_memberships",
  "user_role_assignments",
  "invitations",
  "role_permissions",
];

/**
 * A harmless column to try to change per table, so an UPDATE has something to write if
 * the policy lets it through. Every value is one the tenant's own row could legally
 * hold: `revoked` is in the membership status CHECK (MEASURED) and `patients.read` is a
 * real permission key, so a leaked write succeeds instead of dying on an unrelated
 * constraint - which is the failure the assertion is looking for.
 */
const UPDATE_SAMPLES: Record<string, Record<string, unknown>> = {
  patients: { last_name: "Cross-tenant write" },
  patient_identifiers: { value: "cross-tenant-value" },
  clinics: { name: "Cross-tenant rename" },
  organization_memberships: { status: "revoked" },
  roles: { name: "Cross-tenant rename" },
  user_role_assignments: { clinic_id: null },
  invitations: { email: "cross-tenant@example.test" },
  organizations: { name: "Cross-tenant rename" },
  role_permissions: { permission_key: "patients.read" },
};

/**
 * The column a no-op UPDATE writes in the mutation half (`set x = x`), so the statement
 * is a real update that can never violate a CHECK, a foreign key or an identity guard -
 * the only break it can produce is the one being mutated for.
 */
const NOOP_COLUMN: Record<string, string> = {
  patients: "last_name",
  patient_identifiers: "value",
  clinics: "name",
  clinic_memberships: "clinic_id",
  organization_memberships: "status",
  roles: "name",
  user_role_assignments: "clinic_id",
  invitations: "email",
  role_permissions: "permission_key",
  organizations: "name",
};

const BUCKET = "patient-documents";

let seeded: TwoTenants | undefined;

function fixture(): TwoTenants {
  if (seeded === undefined) throw new Error("the two-tenant fixture was not seeded");
  return seeded;
}

/** One of the two tenants, for the tenant-scope lookups. */
function tenantOf(side: "a" | "b") {
  return side === "a" ? fixture().orgA : fixture().orgB;
}

/** The value of a table's tenant-scope column for one side's tenant. */
function scopeValue(side: "a" | "b", tenantColumn: string): string {
  const org = tenantOf(side);
  if (tenantColumn === "id") return org.organizationId;
  if (tenantColumn === "role_id") return org.adminRoleId;
  return org.organizationId;
}

/** A query builder already narrowed to one primary key, on whichever client is given. */
function keyed(client: SupabaseClient, table: string, row: Record<string, string>) {
  let query = client.from(table).select();
  for (const column of specOf(table).key) {
    query = query.eq(column, row[column] ?? "");
  }
  return query;
}

/** The table's spec, or a thrown error - the lists in this file are literals. */
function specOf(table: string): { table: string; tenant: string; key: string[] } {
  const spec = TENANT_TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`unknown table ${table}`);
  return spec;
}

/** The first column of a table's primary key, for the single-key update/delete filters. */
function firstKeyOf(table: string): string {
  const key = specOf(table).key[0];
  if (key === undefined) throw new Error(`${table} has no key columns`);
  return key;
}

/** One side's own row in a table, read by the service role - setup, never measurement. */
async function rowOfTenant(side: "a" | "b", table: string): Promise<Record<string, string>> {
  const spec = specOf(table);
  const { data, error } = await admin()
    .from(table)
    .select(spec.key.join(", "))
    .eq(spec.tenant, scopeValue(side, spec.tenant))
    .limit(1);
  if (error)
    throw new Error(`could not read tenant ${side.toUpperCase()}'s ${table} row: ${error.message}`);
  const row = data?.[0];
  if (!row) throw new Error(`tenant ${side.toUpperCase()} has no ${table} row to try to reach`);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]));
}

dbDescribe("tenant isolation across two organizations", () => {
  beforeAll(async () => {
    seeded = await seedTwoOrganizations();
  });

  afterAll(async () => {
    if (seeded !== undefined) await destroyTwoOrganizations(seeded);
  });

  describe("a member of one tenant can read only its own rows", () => {
    it("selects zero of the other tenant's rows, in every tenant-owned table", async () => {
      const { orgA, orgB, clientA } = fixture();
      const roleReply = await clientA.from("roles").select("id");
      if (roleReply.error)
        throw new Error(`A could not read its own roles: ${roleReply.error.message}`);
      const ownRoleIds = new Set((roleReply.data ?? []).map((row) => String(row.id)));
      expect(ownRoleIds.size, "A must have roles for the role_permissions check").toBeGreaterThan(
        0,
      );

      for (const { table, tenant } of TENANT_TABLES) {
        const { data, error } = await clientA.from(table).select();
        if (error) throw new Error(`A could not select ${table}: ${error.message}`);

        const rows = data ?? [];
        // The positive control. A table with no row of A's own is indistinguishable
        // from a policy that refuses everyone, and the refusal proves nothing.
        expect(
          rows.length,
          `${table}: A must see a row of its own for the refusal to mean anything`,
        ).toBeGreaterThan(0);
        for (const row of rows) {
          if (table === "role_permissions") {
            // No organization column here (MEASURED): the row is A's if its ROLE is.
            expect(
              ownRoleIds.has(String(row.role_id)),
              `${table}: every visible row's role must be A's own`,
            ).toBe(true);
          } else {
            expect(row[tenant], `${table}: a row of tenant B must never appear`).not.toBe(
              orgB.organizationId,
            );
            expect(row[tenant], `${table}: every visible row must be A's own`).toBe(
              orgA.organizationId,
            );
          }
        }
      }
    }, 60_000);

    it("returns nothing when asked for the other tenant's row by primary key", async () => {
      const { clientA } = fixture();
      for (const { table } of TENANT_TABLES) {
        const { data, error } = await keyed(clientA, table, await rowOfTenant("b", table));
        if (error) throw new Error(`A could not select ${table} by key: ${error.message}`);
        expect(
          data ?? [],
          `${table}: the other tenant's row must be invisible by its primary key`,
        ).toEqual([]);
      }
    }, 60_000);

    it("sees its own row by primary key, so the lookup above is not simply always empty", async () => {
      const { clientA } = fixture();
      for (const { table } of TENANT_TABLES) {
        const { data, error } = await keyed(clientA, table, await rowOfTenant("a", table));
        if (error) throw new Error(`A could not select its own ${table} row: ${error.message}`);
        expect(
          data ?? [],
          `${table}: A must be able to find its own row by primary key`,
        ).toHaveLength(1);
      }
    }, 60_000);
  });

  describe("a member of one tenant cannot change another tenant's rows", () => {
    it("updates zero rows when it targets the other tenant's row", async () => {
      const { orgA, orgB, clientA } = fixture();
      for (const table of UPDATABLE) {
        const before = await rowOfTenant("b", table);
        const sample =
          table === "clinic_memberships"
            ? // `clinic_id` is NOT NULL (MEASURED), so the leaked write must name a real
              // clinic - B's own, which is exactly the row's current value.
              { clinic_id: orgB.clinicId }
            : (UPDATE_SAMPLES[table] ?? {});
        const { data, error } = await clientA
          .from(table)
          .update(sample)
          .eq(firstKeyOf(table), String(Object.values(before)[0] ?? ""))
          .select();
        // A filtered UPDATE is not an error: RLS removes the row from the row set, so
        // the statement succeeds and affects zero rows. Asserting a throw would be the
        // wrong shape and would pass against a policy set that filtered nothing.
        if (error) throw new Error(`A's update on ${table} raised: ${error.message}`);
        expect(data ?? [], `${table}: the other tenant's row must be filtered out`).toEqual([]);

        // And the row is genuinely unchanged, not merely unreported.
        const after = await rowOfTenant("b", table);
        expect(after, `${table}: the other tenant's row must not have changed`).toEqual(before);
      }

      // Positive control: the same write on A's OWN patient succeeds. Without it a
      // policy that refused every update would pass every refusal above.
      const own = await clientA
        .from("patients")
        .update({ last_name: "Own rename" })
        .eq("id", orgA.patientId)
        .select("id");
      expect(
        own.error,
        `A must be able to update its own patient: ${own.error?.message}`,
      ).toBeNull();
      expect(own.data ?? []).toHaveLength(1);
    }, 120_000);

    it("deletes zero rows when it targets the other tenant's row", async () => {
      const { clientA } = fixture();
      for (const table of DELETABLE) {
        const before = await rowOfTenant("b", table);
        const { data, error } = await clientA
          .from(table)
          .delete()
          .eq(firstKeyOf(table), String(Object.values(before)[0] ?? ""))
          .select();
        if (error) throw new Error(`A's delete on ${table} raised: ${error.message}`);
        expect(data ?? [], `${table}: the other tenant's row must be filtered out`).toEqual([]);

        const after = await rowOfTenant("b", table);
        expect(after, `${table}: the other tenant's row must still exist`).toEqual(before);
      }

      // Positive control on a row that exists to be deleted, because deleting a row of
      // the fixture's own would change what every later assertion reads.
      const created = await clientA
        .from("patients")
        .insert({
          organization_id: fixture().orgA.organizationId,
          clinic_id: fixture().orgA.clinicId,
          mrn: "DELETE-CONTROL",
          last_name: "Control",
        })
        .select("id");
      expect(
        created.error,
        `A must be able to create its own patient: ${created.error?.message}`,
      ).toBeNull();
      const removed = await clientA
        .from("patients")
        .delete()
        .eq("id", created.data?.[0]?.id)
        .select("id");
      expect(
        removed.error,
        `A must be able to delete its own patient: ${removed.error?.message}`,
      ).toBeNull();
      expect(removed.data ?? []).toHaveLength(1);
    }, 120_000);

    it("cannot write a row that references the other tenant's clinic, by policy or by foreign key", async () => {
      const { orgA, orgB, clientA } = fixture();
      const { data, error } = await clientA.from("patients").insert({
        organization_id: orgA.organizationId,
        clinic_id: orgB.clinicId,
        mrn: "CROSS-TENANT",
        last_name: "Cross-tenant",
      });
      // TWO independent layers refuse this, and the assertion accepts either. The policy
      // fires first because `private.clinic_ids` returns only the caller's own clinics;
      // the composite foreign key `patients (organization_id, clinic_id) -> clinics
      // (organization_id, id)` refuses it independently, which the mutation half proves
      // by loosening the policy and watching the foreign key refuse instead.
      expect(error, "a cross-tenant clinic reference must be refused").not.toBeNull();
      expect(data ?? null).toBeNull();

      // Positive control: the same insert into A's own clinic is accepted. Without it,
      // a policy that refused every insert would pass this assertion.
      const own = await clientA.from("patients").insert({
        organization_id: orgA.organizationId,
        clinic_id: orgA.clinicId,
        mrn: "CROSS-TENANT-CONTROL",
        last_name: "Control",
      });
      expect(
        own.error,
        `A must be able to create a patient in its own tenant: ${own.error?.message}`,
      ).toBeNull();
    }, 60_000);
  });

  describe("a member of one tenant cannot raise its own access", () => {
    it("cannot grant itself a role of the other tenant", async () => {
      const { orgA, orgB, clientA, userA } = fixture();

      // The role is B's, the organization is A's, and the target is the caller.
      const crossRole = await clientA.from("user_role_assignments").insert({
        organization_id: orgA.organizationId,
        user_id: userA,
        role_id: orgB.adminRoleId,
      });
      expect(crossRole.error, "a role of another tenant must not be grantable").not.toBeNull();

      // And the same attempt written into the OTHER organization, where `current_org_ids`
      // does not contain it at all.
      const crossTenant = await clientA.from("user_role_assignments").insert({
        organization_id: orgB.organizationId,
        user_id: userA,
        role_id: orgB.adminRoleId,
      });
      expect(
        crossTenant.error,
        "an assignment in another tenant must not be grantable",
      ).not.toBeNull();

      // Positive control: a role of A's own tenant that A does not currently hold is
      // grantable to A. A ceiling that refused every role would pass both refusals.
      const allowed = await clientA
        .from("user_role_assignments")
        .insert({ organization_id: orgA.organizationId, user_id: userA, role_id: orgA.adminRoleId })
        .select("id");
      expect(
        allowed.error,
        `granting one of its own tenant's roles must be allowed: ${allowed.error?.message}`,
      ).toBeNull();
      expect(allowed.data ?? []).toHaveLength(1);

      // And the UPDATE path, which is the one that once carried the escalation: an
      // existing assignment moved to another tenant's role.
      const moved = await clientA
        .from("user_role_assignments")
        .update({ role_id: orgB.adminRoleId })
        .eq("organization_id", orgA.organizationId)
        .eq("user_id", userA)
        .select("id");
      // Two refusal shapes: a failed WITH CHECK RAISES and a missed USING FILTERS to
      // zero rows, so "it threw" and "the row count is zero" are BOTH a refusal here.
      const refused = moved.error !== null || (moved.data ?? []).length === 0;
      expect(refused).toBe(true);
    }, 60_000);

    it("cannot reach the platform console's directory, and an operator can", async () => {
      const { orgA, orgB, clientA } = fixture();
      const operator = await createProbeSession();
      try {
        // The predicate first: this principal is not an administrator, so the refusal
        // below is attributable to the guard rather than to an empty database.
        const predicate = await rpcReturning<boolean>(clientA, "is_platform_admin");
        expect(predicate, "tenant A's principal must not be a platform administrator").toBe(false);

        const directory = await rpcReturning<Array<Record<string, unknown>>>(
          clientA,
          "tenant_directory",
        );
        // Two tenants exist, so an empty directory means REFUSED and not "nothing there".
        expect(directory).toEqual([]);

        // Positive control: a real operator sees both tenants, so the empty answer above
        // was the guard and not the transport or an empty table.
        await admin()
          .from("profiles")
          .update({ is_platform_admin: true })
          .eq("id", operator.userId);
        const operatorClient = clientOverJar({
          [AUTH_COOKIE]: { name: AUTH_COOKIE, value: operator.cookie },
        }).client;
        const allowed = await rpcReturning<Array<Record<string, unknown>>>(
          operatorClient,
          "tenant_directory",
        );
        expect(allowed, "an operator must see the tenant directory").toEqual(
          expect.arrayContaining([
            // MEASURED: the directory returns the organization's NAME, not its slug.
            expect.objectContaining({ name: orgA.name, status: "active" }),
            expect.objectContaining({ name: orgB.name, status: "active" }),
          ]),
        );
      } finally {
        await admin()
          .from("profiles")
          .update({ is_platform_admin: false })
          .eq("id", operator.userId);
        await deleteProbeUsers([operator.userId]);
      }
    }, 60_000);

    it("cannot read the other tenant's storage objects", async () => {
      const { orgA, orgB, clientA } = fixture();

      const own = await clientA.storage.from(BUCKET).list(orgA.organizationId);
      if (own.error) throw new Error(`A could not list its own prefix: ${own.error.message}`);
      expect(own.data ?? [], "A must see its own document").toHaveLength(1);

      // The organization directory of the other tenant.
      const otherOrg = await clientA.storage.from(BUCKET).list(orgB.organizationId);
      expect(otherOrg.error ?? null).toBeNull();
      expect(otherOrg.data ?? [], "the other tenant's organization prefix must be empty").toEqual(
        [],
      );

      // And the clinic directory inside it, which is where the object actually lives.
      const otherClinic = await clientA.storage
        .from(BUCKET)
        .list(`${orgB.organizationId}/${orgB.clinicId}`);
      expect(otherClinic.data ?? [], "the other tenant's clinic prefix must be empty").toEqual([]);

      // The object NAME itself, which is the only thing carrying this tenant's boundary:
      // a text path cannot hold the composite foreign key every other reference uses.
      const signed = await clientA.storage.from(BUCKET).createSignedUrl(orgB.storageName, 60);
      expect(
        signed.error,
        "a signed URL for the other tenant's object must be refused",
      ).not.toBeNull();

      // Positive control: A's own object signs.
      const ownSigned = await clientA.storage.from(BUCKET).createSignedUrl(orgA.storageName, 60);
      expect(
        ownSigned.error,
        `A must be able to sign its own object: ${ownSigned.error?.message}`,
      ).toBeNull();
    }, 60_000);
  });

  describe("the cross-tenant uniqueness rule", () => {
    it("lets one account hold a membership in two organizations, and only one in each", async () => {
      const { orgA, orgB } = fixture();
      const newcomer = await createProbeSession();
      try {
        // Staged through the service role: `organization_memberships` INSERT is closed by
        // policy on purpose, so the only way to give an account a membership in two
        // organizations is the setup path. The measurement below is the principal's.
        await admin().from("organization_memberships").insert({
          organization_id: orgA.organizationId,
          user_id: newcomer.userId,
          status: "active",
        });

        const client = clientOverJar({
          [AUTH_COOKIE]: { name: AUTH_COOKIE, value: newcomer.cookie },
        }).client;

        // The legitimate cross-tenant case: one account, two memberships. The counts are
        // scoped to the newcomer's OWN rows because the membership SELECT policy is
        // `is_member(organization_id)` - MEASURED: any member sees the organization's
        // whole directory, so an unfiltered count measures the directory, not the
        // newcomer, and already reads 2 before the second organization is added.
        const seen = await client
          .from("organization_memberships")
          .select("organization_id")
          .eq("user_id", newcomer.userId);
        expect(
          seen.error,
          `the newcomer must see its memberships: ${seen.error?.message}`,
        ).toBeNull();
        expect(seen.data ?? []).toHaveLength(1);

        await admin().from("organization_memberships").insert({
          organization_id: orgB.organizationId,
          user_id: newcomer.userId,
          status: "active",
        });

        const both = await client
          .from("organization_memberships")
          .select("organization_id")
          .eq("user_id", newcomer.userId);
        expect(
          both.data ?? [],
          "the same account must be able to hold a membership in two organizations",
        ).toHaveLength(2);
        expect(
          new Set((both.data ?? []).map((row) => row.organization_id)).size,
          "the two memberships must be in two DIFFERENT organizations",
        ).toBe(2);

        // And a SECOND membership in the same organization is refused by the composite
        // unique key, not silently appended.
        const duplicate = await admin().from("organization_memberships").insert({
          organization_id: orgA.organizationId,
          user_id: newcomer.userId,
          status: "active",
        });
        expect(duplicate.error, "one membership per organization per account").not.toBeNull();
      } finally {
        await admin().from("organization_memberships").delete().eq("user_id", newcomer.userId);
        await deleteProbeUsers([newcomer.userId]);
      }
    }, 60_000);
  });

  describe("mutation verification", () => {
    let harness: MutationHarness;

    beforeAll(async () => {
      harness = await openHarness();
    });

    afterAll(async () => {
      await harness.rollback();
      // The report is this task's evidence, so it is written where the controller can
      // read it on every run: vitest's console interception swallows afterAll output in
      // this setup, and a report file inside the repository would be a scratch file.
      // The OS temp dir is outside the tree and the file overwrites itself per run.
      await writeFile(
        join(tmpdir(), "tenant-isolation-mutation-report.txt"),
        renderMutationReport(),
        "utf8",
      );
    });

    /*
     * THE ASSERTION BODIES. Each one is the isolation assertion the first half of this
     * file makes, restated impersonated on the harness's connection, so a mutation that
     * breaks the isolation assertion is demonstrated to break it - not merely to break a
     * different test that happens to run.
     */

    const readAsA = async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> => {
      await harness.become(fixture().userA);
      return harness.owned.query<T>(sql, params);
    };

    /** The same select-side invariant as the client half, through whichever column reaches the tenant. */
    const assertSeesOnlyOwn = async (table: string): Promise<void> => {
      const { orgA, orgB } = fixture();
      const spec = TENANT_TABLES.find((t) => t.table === table)!;
      if (table === "role_permissions") {
        const ownRoleIds = new Set(
          (await readAsA<{ id: string }>(`select id from public.roles`)).map((row) =>
            String(row.id),
          ),
        );
        const rows = await readAsA<{ role_id: string }>(
          `select role_id from public.role_permissions`,
        );
        expect(rows.length, "role_permissions: A must see its own rows").toBeGreaterThan(0);
        for (const row of rows) {
          expect(
            ownRoleIds.has(String(row.role_id)),
            "role_permissions: every visible row's role must be A's own",
          ).toBe(true);
        }
        return;
      }
      const rows = await readAsA<Record<string, unknown>>(`select * from public.${table}`);
      expect(rows.length, `${table}: A must see its own rows`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row[spec.tenant], `${table}: every visible row must be A's own`).toBe(
          orgA.organizationId,
        );
        expect(row[spec.tenant], `${table}: no visible row may be tenant B's`).not.toBe(
          orgB.organizationId,
        );
      }
    };

    it("proves the select policies are load-bearing for every tenant-owned table", async () => {
      for (const { table } of TENANT_TABLES) {
        const policy = `${table}_select`;
        await harness.mutationBreaks(
          `dropping ${policy} breaks the "${table}" isolation assertion`,
          () => harness.dropPolicy(table, policy),
          async () => {
            const left = await harness.readPolicies(table, policy);
            expect(left, `the catalogue must no longer list ${policy}`).toEqual([]);
          },
          () => assertSeesOnlyOwn(table),
        );
      }

      // And the isolation assertion catches an actual LEAK, not only a missing policy.
      // A permissive policy is the other half: dropping one makes the table invisible
      // (which only the positive control notices), while loosening it makes the other
      // tenant's rows visible (which the refusal notices).
      await harness.mutationBreaks(
        "loosening patients_select to `using (true)` leaks tenant B's patients",
        () => harness.openPolicy("patients", "patients_select"),
        async () => {
          const [row] = await harness.readPolicies("patients", "patients_select");
          expect(row?.qual, "the policy must now be permissive").toBe("true");
        },
        async () => {
          const rows = await readAsA<{ mrn: string }>(
            `select mrn from public.patients order by mrn`,
          );
          // A must see only its own patients. With the leak it sees B's too.
          const mrns = rows.map((row) => row.mrn);
          expect(mrns).toContain("ISO-A-1");
          expect(mrns, "tenant B's patient must not be visible").not.toContain("ISO-B-1");
        },
      );
    }, 300_000);

    it("proves the update and delete policies are load-bearing", async () => {
      /*
       * MEASURED, WITH THE QUERY PLAN: an UPDATE's row scan carries the SELECT policy's
       * qual - PostgreSQL filters the rows an UPDATE or DELETE can reach through the
       * SELECT policy as well as the command policy's own USING - so loosening the
       * command policy alone leaves the cross-tenant statement filtered and the
       * assertion cannot move. The mutation therefore loosens the SELECT policy and the
       * command policy TOGETHER, and what it proves is that the refusal holds as long
       * as EITHER is intact: a deleted or permissive update policy cannot leak another
       * tenant's rows while the select policy still stands.
       */
      for (const table of UPDATE_MUTATIONS) {
        const policy = `${table}_update`;
        const select = `${table}_select`;
        const noop = NOOP_COLUMN[table]!;
        const tenant = TENANT_TABLES.find((t) => t.table === table)!;
        await harness.mutationBreaks(
          `loosening ${select} and ${policy} lets a cross-tenant update through`,
          async () => {
            const opened = await harness.openPolicy(table, select);
            const loosened = await harness.openPolicy(table, policy);
            return `${opened}; ${loosened}`;
          },
          async () => {
            const [sel] = await harness.readPolicies(table, select);
            expect(sel?.qual, `${select}.qual must now be permissive`).toBe("true");
            const [row] = await harness.readPolicies(table, policy);
            expect(row, `${policy} must still exist, loosened`).toBeDefined();
            if (row?.qual !== null)
              expect(row?.qual, `${policy}.qual must now be permissive`).toBe("true");
            if (row?.with_check !== null) {
              expect(row?.with_check, `${policy}.with_check must now be permissive`).toBe("true");
            }
          },
          async () => {
            const touched = await readAsA(
              `update public.${table} set ${noop} = ${noop} where ${tenant.tenant} = $1 returning 1 as touched`,
              [scopeValue("b", tenant.tenant)],
            );
            expect(touched, `${table}: a cross-tenant update must touch nothing`).toEqual([]);
            // The control that the loosening did not simply refuse everyone: A's own
            // rows are still updatable, which only a loosened (superset) policy set
            // guarantees - a DELETED policy would fail here, which is what makes the
            // refusal half and the control half a pair.
            const ownTouched = await readAsA(
              `update public.${table} set ${noop} = ${noop} where ${tenant.tenant} = $1 returning 1 as touched`,
              [scopeValue("a", tenant.tenant)],
            );
            expect(ownTouched.length, `${table}: A must still update its own rows`).toBeGreaterThan(
              0,
            );
          },
        );
      }

      for (const table of DELETE_MUTATIONS) {
        const policy = `${table}_delete`;
        const select = `${table}_select`;
        const tenant = TENANT_TABLES.find((t) => t.table === table)!;
        await harness.mutationBreaks(
          `loosening ${select} and ${policy} lets a cross-tenant delete reach tenant B's ${table} row`,
          async () => {
            const opened = await harness.openPolicy(table, select);
            const loosened = await harness.openPolicy(table, policy);
            return `${opened}; ${loosened}`;
          },
          async () => {
            const [sel] = await harness.readPolicies(table, select);
            expect(sel?.qual, `${select}.qual must now be permissive`).toBe("true");
            const [row] = await harness.readPolicies(table, policy);
            expect(row?.qual, `${policy}.qual must now be permissive`).toBe("true");
          },
          async () => {
            const rows = await readAsA(
              `delete from public.${table} where ${tenant.tenant} = $1 returning 1 as touched`,
              [scopeValue("b", tenant.tenant)],
            );
            expect(rows, `${table}: a cross-tenant delete must touch nothing`).toEqual([]);
          },
        );
      }
    }, 300_000);

    it("proves the composite foreign key refuses a cross-tenant reference behind the policy", async () => {
      const { orgA, orgB } = fixture();

      // The mutation LOOSENS the insert policy instead of dropping it, which is what
      // isolates the foreign key: under the shipped policy the with-check refuses first
      // (`private.clinic_ids` does not contain B's clinic) so the failure is RLS; with
      // the policy loosened the SAME insert is refused by the composite key instead.
      // The break - an FK message where RLS used to be - is the proof that the key is
      // an independent second layer and not merely the first refusal wearing a hat.
      await harness.mutationBreaks(
        "loosening patients_write exposes the composite foreign key as the second layer",
        () => harness.openPolicy("patients", "patients_write"),
        async () => {
          const [row] = await harness.readPolicies("patients", "patients_write");
          expect(row?.with_check, "the insert policy must now accept anything").toBe("true");
        },
        async () => {
          await harness.become(orgA.userId);
          await expectRejection(
            harness.owned,
            `insert into public.patients (organization_id, clinic_id, mrn, last_name)
             values ($1, $2, 'CROSS-TENANT', 'Cross-tenant')`,
            [orgA.organizationId, orgB.clinicId],
            /row-level security/i,
          );
        },
      );

      // And the live, committed policy is back to its shipped form once the mutation's
      // transaction has rolled back - the catalogue, read on the harness's own session.
      const [shipped] = await harness.readPolicies("patients", "patients_write");
      expect(shipped?.with_check, "the live policy must be back to its shipped form").not.toBe(
        "true",
      );
    }, 60_000);

    it("proves the grant ceiling is load-bearing, together with its trigger", async () => {
      const { orgA, orgB, userA } = fixture();

      // The cross-tenant grant is refused by TWO layers: the RLS with-check and the
      // `guard_role_org_scope` BEFORE trigger, which fires before the with-check is even
      // evaluated (MEASURED - the shipped refusal carries the trigger's message). So the
      // mutation removes BOTH, and the break is the assignment actually being written.
      await harness.mutationBreaks(
        "loosening the write policy AND disabling the guard lets a cross-tenant role be granted",
        async () => {
          const opened = await harness.openPolicy(
            "user_role_assignments",
            "user_role_assignments_write",
          );
          const disabled = await harness.disableTrigger(
            "user_role_assignments",
            "guard_role_org_scope",
          );
          return `${opened}; ${disabled}`;
        },
        async () => {
          const [row] = await harness.readPolicies(
            "user_role_assignments",
            "user_role_assignments_write",
          );
          expect(row?.with_check, "the write policy must now accept anything").toBe("true");
          const [trigger] = await harness.owned.query<{ tgenabled: string }>(
            `select t.tgenabled::text as tgenabled
               from pg_catalog.pg_trigger t
               join pg_catalog.pg_class c on c.oid = t.tgrelid
              where c.relname = 'user_role_assignments' and t.tgname = 'guard_role_org_scope'`,
          );
          expect(trigger?.tgenabled, "the guard trigger must be disabled").toBe("D");
        },
        async () => {
          // Shipped, either layer refuses (the trigger fires first, so the message is
          // usually its own) - the matcher accepts both. With both layers gone the
          // insert succeeds, which is the break this mutation is looking for.
          await harness.become(userA);
          await expectRejection(
            harness.owned,
            `insert into public.user_role_assignments (organization_id, user_id, role_id)
             values ($1, $2, $3)`,
            [orgA.organizationId, userA, orgB.adminRoleId],
            /row-level security|belongs to another organization/i,
          );
        },
      );
    }, 60_000);

    it("proves the platform gate is load-bearing", async () => {
      const UNGUARDED = `create or replace function public.tenant_directory()
        returns table (name text, status text, member_count integer)
        language sql
        stable
        security definer
        set search_path = ''
        as $fn$
          select o.name, o.status,
                 (select count(*)::integer from public.organization_memberships m
                   where m.organization_id = o.id)
            from public.organizations o
        $fn$;`;

      await harness.mutationBreaks(
        "removing the platform guard from tenant_directory hands tenant A the console",
        () => harness.replaceFunction("tenant_directory", UNGUARDED),
        async () => {
          await harness.become(fixture().userA);
          const rows = await harness.owned.query<Record<string, unknown>>(
            `select * from public.tenant_directory()`,
          );
          // The mutation is PROVED by the guard being gone: tenant A now sees rows.
          expect(rows.length, "without the guard every tenant is visible").toBeGreaterThan(0);
        },
        async () => {
          const rows = await readAsA<Record<string, unknown>>(
            `select * from public.tenant_directory()`,
          );
          expect(rows, "tenant A must not reach the platform directory").toEqual([]);
        },
      );
    }, 60_000);

    it("proves the storage policies are load-bearing", async () => {
      const { orgA, orgB } = fixture();

      await harness.mutationBreaks(
        "dropping patient_documents_select takes A's own objects away too",
        () => harness.dropPolicy("storage.objects", "patient_documents_select"),
        async () => {
          const left = await harness.readPolicies("storage.objects", "patient_documents_select");
          expect(left, "the catalogue must no longer list the storage select policy").toEqual([]);
        },
        async () => {
          // The control is what catches this mutation: a dropped policy hides EVERYTHING,
          // A's own object included, while the cross-tenant half of the assertion would
          // pass against an empty answer for the wrong reason.
          const own = await readAsA<{ name: string }>(
            `select name from storage.objects where name like $1`,
            [`${orgA.organizationId}/%`],
          );
          expect(own, "A must still see its own object").toHaveLength(1);
          const cross = await readAsA<{ name: string }>(
            `select name from storage.objects where name like $1`,
            [`${orgB.organizationId}/%`],
          );
          expect(cross, "tenant B's objects must be invisible").toEqual([]);
        },
      );
    }, 60_000);

    it("proves the membership unique key is the composite pair and not the account alone", async () => {
      const { orgA, orgB, userA } = fixture();
      const CONSTRAINT = "organization_memberships_organization_id_user_id_key";

      await harness.mutationBreaks(
        `narrowing ${CONSTRAINT} to user_id alone makes two organizations impossible`,
        () => harness.narrowMembershipUniqueness(),
        async () => {
          const cols = await harness.owned.query<{ cols: string }>(
            `select (select string_agg(a.attname, ',' order by a.attnum)
                      from pg_catalog.pg_attribute a
                     where a.attrelid = con.conrelid and a.attnum = any(con.conkey)) as cols
               from pg_catalog.pg_constraint con
               join pg_catalog.pg_class c on c.oid = con.conrelid
               join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'organization_memberships'
                and con.conname = $1`,
            [CONSTRAINT],
          );
          expect(cols[0]?.cols, "the constraint must now be the account alone").toBe("user_id");
        },
        async () => {
          await harness.resetRole();
          // The legitimate case: the same account in the OTHER organization. Under the
          // narrowed constraint this is refused, which is why the assertion fails - and
          // why a suite that only asserted the duplicate refusal would still pass.
          await harness.owned.query(
            `insert into public.organization_memberships (organization_id, user_id, status)
             values ($1, $2, 'active')`,
            [orgB.organizationId, userA],
          );
          // And the duplicate in the same organization, which must still be refused.
          await expectRejection(
            harness.owned,
            `insert into public.organization_memberships (organization_id, user_id, status)
             values ($1, $2, 'active')`,
            [orgA.organizationId, userA],
            /duplicate key|unique/i,
          );
        },
      );

      // The live, committed constraint is the pair again once the mutation's transaction
      // has rolled back - read on the harness's own session, which never impersonated.
      const cols = await harness.owned.query<{ cols: string }>(
        `select (select string_agg(a.attname, ',' order by a.attnum)
                  from pg_catalog.pg_attribute a
                 where a.attrelid = con.conrelid and a.attnum = any(con.conkey)) as cols
           from pg_catalog.pg_constraint con
           join pg_catalog.pg_class c on c.oid = con.conrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'organization_memberships'
            and con.conname = $1`,
        [CONSTRAINT],
      );
      expect(cols[0]?.cols, "the live constraint must be the pair").toBe("organization_id,user_id");
    }, 60_000);

    it("records every mutation it applied, so the report is the evidence it claims to be", async () => {
      // The harness already THROWS if a mutation fails to break its assertion or fails to
      // restore; this pins the LEDGER, so a mutation that applied, broke and restored but
      // never recorded cannot pass silently. 33 = the 11 select drops, the patients leak,
      // 10 update pairs, 6 delete pairs, the composite foreign key, the grant ceiling
      // with its trigger, the platform guard, the storage policy and the unique key.
      expect(mutationReport).toHaveLength(33);
      // Every row must carry how the mutation was catalogued and how it broke - "applied"
      // is the descriptor for a mutation that returned nothing, which none here may.
      expect(mutationReport.every((row) => row.cataloguedAs !== "applied")).toBe(true);
      expect(mutationReport.every((row) => row.brokeWith !== "")).toBe(true);
    }, 30_000);
  });
});

/** An RPC that returns one scalar, asserted rather than cast. */
async function rpcReturning<T>(client: SupabaseClient, fn: string): Promise<T> {
  const { data, error } = await client.rpc(fn);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}
