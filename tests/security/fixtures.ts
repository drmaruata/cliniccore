// @vitest-environment node
/**
 * Two genuinely separate tenants, each held by its own real signed-in Supabase client.
 *
 * WHY REAL CLIENTS AND NOT AN ADMIN ACCOUNT. The whole point of an isolation suite is
 * to measure what a tenant principal can reach. A suite that seeds and measures through
 * the service role measures the superuser, which bypasses row-level security by
 * definition, and would pass against a database with no policies at all. So: two real
 * accounts created through the public signup endpoint, each signed in over its own
 * in-memory cookie jar, and every read and write below is issued by that client with
 * that client's own JWT.
 *
 * WHY THE ORGANIZATIONS ARE CREATED THROUGH THE PUBLIC RPC.
 * `public.create_organization_with_owner` is the only path that can bootstrap a tenant,
 * so it is the only fixture that is what the product actually produces: the seeded role
 * set, the composite foreign keys, the owner's org-wide assignment and the first clinic.
 * A hand-seeded tenant is a state no code path reaches, which is how a suite comes to
 * assert something about a database that cannot exist.
 *
 * WHY THE STORAGE ROW IS WRITTEN BY THE OWNER. The storage object's tenancy is carried
 * by its NAME, so a row whose `owner_id` is not the tenant's own principal measures
 * nothing about the boundary. The row is written as the table owner with the tenant's
 * own user id in `owner_id` because a direct insert is the shape
 * `tests/security/storage-policies.test.ts` already uses, and the MEASUREMENT is still
 * a read through the tenant's own client - the storage API's own behaviour in setting
 * `owner_id` is not what this file is about, and a row that fails to seed would fail
 * every assertion below for a reason unconnected to isolation.
 *
 * WHY THE CLEANUP IS PART OF THIS FILE. The live project's pristine state is 0
 * organizations, 0 audit rows, 0 auth users. `audit_logs` and `tenant_creation_events`
 * carry no foreign keys, so they survive the accounts and the organizations that made
 * them - and a storage deletion writes an audit row of its own, so the storage rows go
 * first. Children before parents, then a re-count that throws: a cleanup that fails
 * silently leaves the database dirty and the suite green.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import {
  AUTH_COOKIE,
  admin,
  clientOverJar,
  createProbeSession,
  createdProbeUserIds,
  deleteProbeUsers,
} from "../helpers/auth-session-fixture";
import { getPool, query } from "../integration/helpers/database";

/** The bucket that carries a clinic segment, so a cross-tenant prefix is meaningful. */
const BUCKET = "patient-documents";

/** A tenant and the one principal who owns it. */
export interface Tenant {
  userId: string;
  organizationId: string;
  name: string;
  slug: string;
  clinicId: string;
  /** The membership row the onboarding RPC wrote for the owner. */
  membershipId: string;
  /** A role of this tenant the owner may grant, used for the invitation seed. */
  adminRoleId: string;
  patientId: string;
  /** The storage object this tenant owns, named by its own org/clinic prefix. */
  storageName: string;
}

export interface TwoTenants {
  orgA: Tenant;
  orgB: Tenant;
  /** Repeated as plain ids so the plan's return shape reads exactly as written. */
  userA: string;
  userB: string;
  clientA: SupabaseClient;
  clientB: SupabaseClient;
}

/**
 * Two tenants, two users, two clients.
 *
 * The signups are sequential on purpose. Supabase rate-limits public signup per window
 * and the limit is per PROJECT, so the two calls share it; running them in parallel
 * would halve each one's retry budget for no gain.
 */
export async function seedTwoOrganizations(): Promise<TwoTenants> {
  const probeA = await createProbeSession();
  const probeB = await createProbeSession();

  const clientA = clientOverJar({
    [AUTH_COOKIE]: { name: AUTH_COOKIE, value: probeA.cookie },
  }).client;
  const clientB = clientOverJar({
    [AUTH_COOKIE]: { name: AUTH_COOKIE, value: probeB.cookie },
  }).client;

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const orgA = await createTenant(clientA, probeA.userId, "a", suffix);
  const orgB = await createTenant(clientB, probeB.userId, "b", suffix);

  return { orgA, orgB, userA: probeA.userId, userB: probeB.userId, clientA, clientB };
}

async function createTenant(
  client: SupabaseClient,
  userId: string,
  side: "a" | "b",
  suffix: string,
): Promise<Tenant> {
  const label = side.toUpperCase();
  const name = `Isolation Tenant ${label}`;
  const slug = `iso-${side}-${suffix}`;

  const { data: organizationId, error: orgError } = await client.rpc(
    "create_organization_with_owner",
    {
      p_name: name,
      p_slug: slug,
      p_clinic_name: `Isolation Clinic ${label}`,
      p_timezone: "Asia/Kolkata",
    },
  );
  if (orgError || typeof organizationId !== "string") {
    throw new Error(`tenant ${label} could not be created: ${orgError?.message ?? "no id"}`);
  }

  // The clinic is read back through the SAME client: the clinics policy scopes it to the
  // caller's own organization, so this read is both how the id is learned and a first
  // measurement that the tenant boundary holds.
  const { data: clinics, error: clinicError } = await client.from("clinics").select("id").limit(1);
  const ownClinic = clinics?.[0];
  if (clinicError || ownClinic === undefined) {
    throw new Error(`tenant ${label} could not read its own clinic: ${clinicError?.message}`);
  }
  const clinicId = String(ownClinic.id);

  const { data: patient, error: patientError } = await client
    .from("patients")
    .insert({
      organization_id: organizationId,
      clinic_id: clinicId,
      mrn: `ISO-${label}-1`,
      last_name: `Isolation ${label}`,
    })
    .select("id")
    .single();
  if (patientError || patient === null) {
    throw new Error(`tenant ${label} could not create a patient: ${patientError?.message}`);
  }
  const patientId = String(patient.id);

  // THE REST OF THE TENANT'S OWN TABLES, seeded through the same client so each one is
  // a real RLS-governed write - which doubles as this file's positive control set. A
  // table with no row of the tenant's own is indistinguishable from a table with no
  // readable policy, so "A sees no B rows" would pass against a policy that refused
  // everyone.
  const { data: memberships, error: membershipError } = await client
    .from("organization_memberships")
    .select("id")
    .limit(1);
  const { data: roles, error: roleError } = await client
    .from("roles")
    .select("id")
    .eq("key", "organization_admin")
    .limit(1);
  const ownMembership = memberships?.[0];
  const ownRole = roles?.[0];
  if (membershipError || roleError || ownMembership === undefined || ownRole === undefined) {
    throw new Error(`tenant ${label} could not read its own membership and admin role`);
  }
  const membershipId = String(ownMembership.id);
  const adminRoleId = String(ownRole.id);

  const { error: identifierError } = await client.from("patient_identifiers").insert({
    organization_id: organizationId,
    patient_id: patientId,
    kind: "mrn_alt",
    value: `ISO-${label}-ALT`,
  });
  if (identifierError) {
    throw new Error(`tenant ${label} could not attach an identifier: ${identifierError.message}`);
  }

  // The invitation names a role of THIS tenant and the caller as its inviter, because
  // all three of those are clauses the INSERT policy checks.
  const tokenHash = createHash("sha256").update(`iso-${side}-${suffix}`).digest("hex");
  const { error: invitationError } = await client.from("invitations").insert({
    organization_id: organizationId,
    email: `invitee-${side}-${suffix}@example.test`,
    role_id: adminRoleId,
    token_hash: tokenHash,
    invited_by: userId,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    clinic_ids: [],
  });
  if (invitationError) {
    throw new Error(`tenant ${label} could not issue an invitation: ${invitationError.message}`);
  }

  const { error: clinicMembershipError } = await client.from("clinic_memberships").insert({
    organization_id: organizationId,
    membership_id: membershipId,
    clinic_id: clinicId,
  });
  if (clinicMembershipError) {
    throw new Error(
      `tenant ${label} could not scope a clinic membership: ${clinicMembershipError.message}`,
    );
  }

  // `audit_logs` has no INSERT policy and the write is revoked from `authenticated`, so
  // the product's own RPC is the only way a tenant can append to its trail.
  const { error: auditError } = await client.rpc("write_audit", {
    p_org_id: organizationId,
    p_action: "patient.read",
    p_resource_type: "patient",
    p_resource_id: patientId,
    p_metadata: { mrn: `ISO-${label}-1` },
  });
  if (auditError) {
    throw new Error(`tenant ${label} could not write its audit row: ${auditError.message}`);
  }

  const storageName = `${organizationId}/${clinicId}/report.pdf`;
  await query(
    `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
     values (gen_random_uuid(), $1, $2, $3, false, false)`,
    [BUCKET, storageName, userId],
  );

  return {
    userId,
    organizationId,
    name,
    slug,
    clinicId,
    membershipId,
    adminRoleId,
    patientId,
    storageName,
  };
}

/**
 * Remove both tenants from the live project, in the order their foreign keys demand.
 *
 * STORAGE FIRST, and not for tidiness: deleting a storage object fires an AFTER DELETE
 * trigger that writes the organization's own audit row, so storage has to go before the
 * trail is cleared or the cleanup refills the trail it is clearing.
 *
 * THE COMPLETE RUN. Both tenants exist, so both are destroyed through the shared
 * `destroyTenants` path.
 */
export async function destroyTwoOrganizations(tenants: TwoTenants): Promise<void> {
  await destroyTenants(
    [tenants.orgA.organizationId, tenants.orgB.organizationId],
    [tenants.orgA.userId, tenants.orgB.userId],
  );
}

/**
 * Remove whatever a HALF-FINISHED seed managed to create.
 *
 * WHY THIS EXISTS. `seedTwoOrganizations` creates tenant A, then tenant B - if the
 * second signup is rate-limited or the second RPC refuses, the throw leaves `seeded`
 * undefined and the suite's `afterAll` cleans NOTHING: two probe users and tenant A
 * leak into the live project, which is exactly the failure Task 16 recorded. The auth
 * fixture registers every probe user it created in `createdProbeUserIds` precisely
 * because "a beforeAll that throws never returns", so the tenants are rediscovered
 * from the accounts' own memberships and destroyed through the same path as a
 * finished run.
 */
export async function destroyPartialSeed(): Promise<void> {
  const userIds = [...createdProbeUserIds];
  if (userIds.length === 0) return;
  const client = admin();
  const { data: memberships, error } = await client
    .from("organization_memberships")
    .select("organization_id")
    .in("user_id", userIds);
  if (error) throw new Error(`cleanup could not find the partial seed: ${error.message}`);
  const orgIds = [...new Set((memberships ?? []).map((row) => String(row.organization_id)))];
  await destroyTenants(orgIds, userIds);
}

/**
 * The destroy path both callers share: storage first, children before parents, the
 * accounts before the residue report that counts them.
 */
async function destroyTenants(orgIds: string[], userIds: string[]): Promise<void> {
  const client = admin();

  await purgeStorageObjects(orgIds);

  for (const orgId of orgIds) {
    // Assignments before the roles they reference, then the parents. Identifiers go
    // BEFORE patients because `patient_identifiers_patient_fkey` is ON DELETE RESTRICT -
    // deleting a patient that still has identifiers raises, and the roles are NOT deleted
    // by hand at all: `private.guard_role_delete` refuses a deliberate delete of a role
    // that is still in use, but returns early once the role's organization no longer
    // exists, which is exactly the cascade of the organization delete below.
    await client.from("user_role_assignments").delete().eq("organization_id", orgId);
    await client.from("patient_identifiers").delete().eq("organization_id", orgId);
    await client.from("patients").delete().eq("organization_id", orgId);
    await client.from("clinic_memberships").delete().eq("organization_id", orgId);
    await client.from("organization_memberships").delete().eq("organization_id", orgId);
    await client.from("invitations").delete().eq("organization_id", orgId);
    await client.from("organizations").delete().eq("id", orgId);
    await client.from("audit_logs").delete().eq("organization_id", orgId);
  }

  for (const userId of userIds) {
    // The creation ledger has no foreign keys, so nothing cascades it away.
    const { error: ledgerError } = await client
      .from("tenant_creation_events")
      .delete()
      .eq("user_id", userId);
    if (ledgerError) {
      throw new Error(`cleanup could not clear the creation ledger: ${ledgerError.message}`);
    }
  }

  // The accounts before the residue report, because the report counts auth.users too -
  // in the other order it would always name the very users it is about to delete. Only
  // their own ids: vitest runs test files serially now, but the check stays scoped so a
  // neighbour's probe user can never fail this caller's cleanup.
  const remaining = await deleteProbeUsers(userIds);
  if (remaining.length > 0) {
    throw new Error(`cleanup left auth users behind: ${remaining.join(", ")}`);
  }

  const residue = await residueReport(orgIds, userIds);
  if (residue.length > 0) {
    throw new Error(`cleanup left rows behind: ${residue.join("; ")}`);
  }
}

/**
 * Delete the storage rows directly, which `storage.protect_delete()` forbids unless the
 * GUC is set.
 *
 * ONE CHECKED-OUT CLIENT FOR THE WHOLE TRANSACTION, AND ONE COMMAND PER CALL. A
 * transaction must never go through `pool.query`, which dispatches each statement to a
 * different idle client - and `pg` uses the extended (prepared-statement) protocol
 * whenever a query carries values, which rejects multi-command strings outright
 * ("cannot insert multiple commands into a prepared statement"). So BEGIN, the GUC, the
 * DELETE and COMMIT are four separate calls on one client. The GUC is `set local` inside
 * the transaction, so committing it returns the connection to the pool without the
 * delete permission it briefly carried.
 */
async function purgeStorageObjects(orgIds: string[]): Promise<void> {
  const prefixes = orgIds.map((orgId) => `${orgId}/%`);
  const objects = await query<{ n: string }>(
    `select count(*)::text as n from storage.objects where name like any($1::text[])`,
    [prefixes],
  );
  if (objects[0]?.n === "0") return;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("set local storage.allow_delete_query = 'true'");
    const removed = await client.query(
      "delete from storage.objects where name like any($1::text[])",
      [prefixes],
    );
    await client.query("commit");
    if (removed.rowCount === 0) {
      throw new Error("storage objects were counted but none were deleted");
    }
  } finally {
    client.release();
  }
}

/**
 * What is still readable for the ids this file created, in human-readable form.
 *
 * The storage objects are read through the direct connection rather than PostgREST,
 * which exposes the public schema only and therefore cannot see `storage.objects` at
 * all - which is itself part of why the storage path is measured with the clients.
 */
async function residueReport(orgIds: string[], userIds: string[]): Promise<string[]> {
  const rows = await query<{ n: string }>(
    `select (select count(*)::text from public.organizations where id = any($1::uuid[])) as organizations,
            (select count(*)::text from public.patients where organization_id = any($1::uuid[])) as patients,
            (select count(*)::text from public.clinics where organization_id = any($1::uuid[])) as clinics,
            (select count(*)::text from public.roles where organization_id = any($1::uuid[])) as roles,
            (select count(*)::text from public.clinic_memberships where organization_id = any($1::uuid[])) as clinic_memberships,
            (select count(*)::text from public.organization_memberships where organization_id = any($1::uuid[])) as memberships,
            (select count(*)::text from public.invitations where organization_id = any($1::uuid[])) as invitations,
            (select count(*)::text from public.user_role_assignments where organization_id = any($1::uuid[])) as assignments,
            (select count(*)::text from public.audit_logs where organization_id = any($1::uuid[])) as audit_logs,
            (select count(*)::text from public.tenant_creation_events where user_id = any($2::uuid[])) as ledger,
            (select count(*)::text from auth.users where id = any($2::uuid[])) as users`,
    [orgIds, userIds],
  );
  const counts = rows[0] ?? {};
  return Object.entries(counts)
    .filter(([, n]) => n !== "0")
    .map(([table, n]) => `${table}: ${n}`);
}
