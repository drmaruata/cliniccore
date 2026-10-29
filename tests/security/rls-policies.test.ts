// @vitest-environment node
import { createHash } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import {
  beginSession,
  closePool,
  dbDescribe,
  expectRejection,
  query,
} from "../integration/helpers/database";

/*
 * Task 9 - row-level security, on the live database.
 *
 * Until this task every table was RLS-enabled and policy-free, which is deny-all:
 * correct, and useless. This file has two halves and the second is the one that
 * matters.
 *
 * The catalogue half asserts the policy set exists with the right commands and
 * non-null predicates. It cannot tell a correct policy from a permissive one, and
 * it is not where the security argument lives.
 *
 * The behavioural half is the security argument. It impersonates real principals
 * - `set local role authenticated` plus set_config for the JWT sub, the same
 * impersonation the onboarding and audit suites use - and asserts what each one
 * can actually see. Every refusal has a positive control beside it, because a
 * policy set that returns nothing passes every "sees nothing" assertion while
 * being useless.
 *
 * Why the clinic-scope tests exist twice over. `private.can` and
 * `private.clinic_ids` are independent authorities and neither implies the other:
 *
 *   - alice holds a CLINIC-SCOPED assignment in clinic 1. `can` refuses clinic 2,
 *     so she cannot see it even though she can reach it.
 *   - bob holds an ORG-WIDE assignment but is scoped to clinic 1 by
 *     clinic_memberships. `can` permits clinic 2, so only clinic_ids stops him.
 *
 * The policy is the conjunction of both, and each test fails if its own clause is
 * dropped. That is the specific defect this conjunction was written to prevent:
 * written with the two-argument `can` a clinic-scoped reader silently gets no
 * rows, and that silence is what invites loosening `can` into a cross-clinic leak.
 */

afterAll(async () => {
  await closePool();
});

type Cmd = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

interface Expected {
  table: string;
  name: string;
  cmd: Cmd;
  /** A row filter must exist; INSERT legitimately has none. */
  qual: boolean;
  withCheck: boolean;
}

const EXPECTED: Expected[] = [
  { table: "profiles", name: "profiles_select_self", cmd: "SELECT", qual: true, withCheck: false },
  { table: "profiles", name: "profiles_update_self", cmd: "UPDATE", qual: true, withCheck: true },

  {
    table: "organizations",
    name: "organizations_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "organizations",
    name: "organizations_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },

  {
    table: "organization_memberships",
    name: "organization_memberships_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "organization_memberships",
    name: "organization_memberships_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },

  { table: "clinics", name: "clinics_select", cmd: "SELECT", qual: true, withCheck: false },
  { table: "clinics", name: "clinics_update", cmd: "UPDATE", qual: true, withCheck: true },

  {
    table: "clinic_memberships",
    name: "clinic_memberships_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "clinic_memberships",
    name: "clinic_memberships_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
  {
    table: "clinic_memberships",
    name: "clinic_memberships_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },
  {
    table: "clinic_memberships",
    name: "clinic_memberships_delete",
    cmd: "DELETE",
    qual: true,
    withCheck: false,
  },

  { table: "invitations", name: "invitations_select", cmd: "SELECT", qual: true, withCheck: false },
  { table: "invitations", name: "invitations_write", cmd: "INSERT", qual: false, withCheck: true },
  { table: "invitations", name: "invitations_update", cmd: "UPDATE", qual: true, withCheck: true },
  { table: "invitations", name: "invitations_delete", cmd: "DELETE", qual: true, withCheck: false },

  { table: "permissions", name: "permissions_select", cmd: "SELECT", qual: true, withCheck: false },

  { table: "roles", name: "roles_select", cmd: "SELECT", qual: true, withCheck: false },
  { table: "roles", name: "roles_write", cmd: "INSERT", qual: false, withCheck: true },
  { table: "roles", name: "roles_update", cmd: "UPDATE", qual: true, withCheck: true },
  { table: "roles", name: "roles_delete", cmd: "DELETE", qual: true, withCheck: false },

  {
    table: "role_permissions",
    name: "role_permissions_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "role_permissions",
    name: "role_permissions_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
  {
    table: "role_permissions",
    name: "role_permissions_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },
  {
    table: "role_permissions",
    name: "role_permissions_delete",
    cmd: "DELETE",
    qual: true,
    withCheck: false,
  },

  {
    table: "user_role_assignments",
    name: "user_role_assignments_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "user_role_assignments",
    name: "user_role_assignments_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
  {
    table: "user_role_assignments",
    name: "user_role_assignments_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },
  {
    table: "user_role_assignments",
    name: "user_role_assignments_delete",
    cmd: "DELETE",
    qual: true,
    withCheck: false,
  },

  { table: "patients", name: "patients_select", cmd: "SELECT", qual: true, withCheck: false },
  { table: "patients", name: "patients_write", cmd: "INSERT", qual: false, withCheck: true },
  { table: "patients", name: "patients_update", cmd: "UPDATE", qual: true, withCheck: true },
  { table: "patients", name: "patients_delete", cmd: "DELETE", qual: true, withCheck: false },

  {
    table: "patient_identifiers",
    name: "patient_identifiers_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "patient_identifiers",
    name: "patient_identifiers_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
  {
    table: "patient_identifiers",
    name: "patient_identifiers_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },
  {
    table: "patient_identifiers",
    name: "patient_identifiers_delete",
    cmd: "DELETE",
    qual: true,
    withCheck: false,
  },

  { table: "audit_logs", name: "audit_logs_select", cmd: "SELECT", qual: true, withCheck: false },

  {
    table: "platform_settings",
    name: "platform_settings_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },

  {
    table: "appointments",
    name: "appointments_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "appointments",
    name: "appointments_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
  {
    table: "appointments",
    name: "appointments_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },
  {
    table: "appointments",
    name: "appointments_delete",
    cmd: "DELETE",
    qual: true,
    withCheck: false,
  },

  {
    table: "queue_entries",
    name: "queue_entries_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "queue_entries",
    name: "queue_entries_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
  {
    table: "queue_entries",
    name: "queue_entries_update",
    cmd: "UPDATE",
    qual: true,
    withCheck: true,
  },
  {
    table: "queue_entries",
    name: "queue_entries_delete",
    cmd: "DELETE",
    qual: true,
    withCheck: false,
  },

  { table: "encounters", name: "encounters_select", cmd: "SELECT", qual: true, withCheck: false },
  { table: "encounters", name: "encounters_write", cmd: "INSERT", qual: false, withCheck: true },
  { table: "encounters", name: "encounters_update", cmd: "UPDATE", qual: true, withCheck: true },

  {
    table: "encounter_addenda",
    name: "encounter_addenda_select",
    cmd: "SELECT",
    qual: true,
    withCheck: false,
  },
  {
    table: "encounter_addenda",
    name: "encounter_addenda_write",
    cmd: "INSERT",
    qual: false,
    withCheck: true,
  },
];

/** Tables that must stay completely closed: a definer function is their only writer. */
const DENY_ALL = ["tenant_sequences"];

const ALL_TABLES = [
  "appointments",
  "audit_logs",
  "clinic_memberships",
  "clinics",
  "encounter_addenda",
  "encounters",
  "invitations",
  "organization_memberships",
  "organizations",
  "patient_identifiers",
  "patients",
  "permissions",
  "platform_settings",
  "profiles",
  "queue_entries",
  "role_permissions",
  "roles",
  "tenant_creation_events",
  "tenant_sequences",
  "user_role_assignments",
];

dbDescribe("the policy catalogue", () => {
  it("enables row-level security on every public table", async () => {
    const rows = await query<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(ALL_TABLES);
    for (const row of rows) expect(row.rls, `${row.relname} must have RLS enabled`).toBe(true);
  });

  it("creates exactly the expected policies, with non-null row filters", async () => {
    const rows = await query<{
      tablename: string;
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, cmd, qual, with_check
         from pg_catalog.pg_policies
        where schemaname = 'public'`,
    );

    const found = new Map(rows.map((r) => [`${r.tablename}.${r.policyname}`, r]));
    for (const e of EXPECTED) {
      const key = `${e.table}.${e.name}`;
      const row = found.get(key);
      expect(row, `${key} is missing`).toBeDefined();
      expect(row?.cmd, `${key} command`).toBe(e.cmd);
      if (e.qual) expect(row?.qual, `${key} must filter rows`).toBeTruthy();
      if (e.withCheck) expect(row?.with_check, `${key} must check new rows`).toBeTruthy();
    }

    // Nothing beyond the expected set. An unlisted policy is a hole nobody
    // reviewed, so this asserts the total, not just the presence.
    const expectedKeys = new Set(EXPECTED.map((e) => `${e.table}.${e.name}`));
    const extra = [...found.keys()].filter((k) => !expectedKeys.has(k));
    expect(extra, "unexpected policies exist").toEqual([]);
    expect(rows).toHaveLength(EXPECTED.length);
  });

  it("keeps tenant_sequences closed: its only writer is a definer function", async () => {
    const rows = await query<{ count: string }>(
      `select count(*)::text as count from pg_catalog.pg_policies
        where schemaname = 'public' and tablename = any ($1)`,
      [DENY_ALL],
    );
    expect(Number(rows[0]?.count)).toBe(0);
    // RLS alone is one lock; the grant is the second. Both, because the project's
    // history is a stray `grant insert ... to authenticated` silently reopening a
    // closed table.
    const grants = await query<{ insert: boolean; update: boolean; delete: boolean }>(
      `select has_table_privilege('authenticated', 'public.tenant_sequences', 'insert') as insert,
              has_table_privilege('authenticated', 'public.tenant_sequences', 'update') as "update",
              has_table_privilege('authenticated', 'public.tenant_sequences', 'delete') as "delete"`,
    );
    expect(grants[0]?.insert).toBe(false);
    expect(grants[0]?.update).toBe(false);
    expect(grants[0]?.delete).toBe(false);
  });

  it("makes audit_logs append-only and permissions a read-only registry", async () => {
    const rows = await query<{ tablename: string; cmd: string }>(
      `select tablename, cmd from pg_catalog.pg_policies
        where schemaname = 'public' and tablename in ('audit_logs', 'permissions')`,
    );
    expect(rows.map((r) => `${r.tablename}:${r.cmd}`).sort()).toEqual([
      "audit_logs:SELECT",
      "permissions:SELECT",
    ]);

    const grants = await query<{ table_name: string; ins: boolean; upd: boolean; del: boolean }>(
      `select c.relname as table_name,
              has_table_privilege('authenticated', c.oid, 'insert') as ins,
              has_table_privilege('authenticated', c.oid, 'update') as upd,
              has_table_privilege('authenticated', c.oid, 'delete') as del
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('audit_logs', 'permissions', 'platform_settings')`,
    );
    for (const row of grants) {
      expect(row.ins, `${row.table_name} must not be client-insertable`).toBe(false);
      expect(row.upd, `${row.table_name} must not be client-updatable`).toBe(false);
      expect(row.del, `${row.table_name} must not be client-deletable`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------- */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_SUSPENDED = "33333333-3333-4333-8333-333333333333";
const CLINIC_1 = "44444444-4444-4444-8444-444444444444";
const CLINIC_2 = "55555555-5555-4555-8555-555555555555";
const CLINIC_3 = "66666666-6666-4666-8666-666666666666";

const ALICE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CAROL = "cccccccc-3333-4333-8333-cccccccccccc";
const DAVE = "dddddddd-4444-4444-8444-dddddddddddd";
const OPERATOR = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

/* Two principals who exist only to be PARTIAL holders. The grant ceiling is
 * invisible without them: dave holds all seventeen permissions, so every ceiling
 * passes for him, and alice holds none, so she fails before the ceiling is even
 * consulted. FRANK holds staff.manage alone; GRACE holds settings.manage without
 * the clinical and billing keys. */
const FRANK = "fa000000-1111-4111-8111-fa0000000001";
const GRACE = "ac000000-1111-4111-8111-ac0000000002";
const ROLE_PARTIAL = "00000000-0000-4000-8000-000000000003";
const ROLE_SETTINGS = "00000000-0000-4000-8000-000000000004";

/**
 * The `organization_owner` role of this fixture, and a principal who REALLY holds it.
 *
 * The fixture has no owner, because until the owner clause existed no policy needed
 * one: the ceiling was the subset rule, and an administrator passes it - the
 * administrator's permission set is byte-identical to the owner's. The owner clause
 * needs a real owner to be measured against, and `stageOwner` provides one.
 */
const OWNER_ROLE = "00000000-0000-4000-8000-000000000006";
const OWNER = "ab000000-1111-4111-8111-ab0000000006";

const PATIENT_1 = "12121212-1111-4111-8111-121212121212";
const PATIENT_2 = "23232323-2222-4222-8222-232323232323";
const PATIENT_3 = "34343434-3333-4333-8333-343434343434";

type Session = Awaited<ReturnType<typeof beginSession>>;

async function become(session: Session, userId: string): Promise<void> {
  await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await session.query("set local role authenticated");
}

/**
 * Give a principal the `organization_owner` role, as the database owner would.
 *
 * Staged per test rather than in the shared fixture: an owner in the fixture would
 * change what every other test in this file sees - the roster, the assignment
 * listings, the counts.
 */
async function stageOwner(session: Session): Promise<void> {
  await session.resetRole();
  await session.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
     values ($1, 'owner@example.test', now(), '{}')`,
    [OWNER],
  );
  await session.query(
    `insert into public.organization_memberships (organization_id, user_id, status)
     values ($1, $2, 'active')`,
    [ORG_A, OWNER],
  );
  await session.query(
    `insert into public.user_role_assignments (organization_id, user_id, role_id)
     values ($1, $2, $3)`,
    [ORG_A, OWNER, OWNER_ROLE],
  );
}

/**
 * Two organizations plus a suspended one, three clinics, and four principals
 * chosen so that the two clinic-scope authorities disagree:
 *
 *   alice  clinic-scoped assignment in clinic 1, no clinic_memberships  -> reaches all of org A
 *   bob    org-wide assignment, clinic_membership limited to clinic 1   -> reaches only clinic 1
 *   carol  member of org B only
 *   dave   member of org A, holds settings.manage org-wide
 *   operator  platform administrator, member of nothing
 */
async function stage(): Promise<Session> {
  const session = await beginSession();
  // A fixture failure must still release the connection. The pool holds four, and
  // a staged throw outside the caller's try/finally leaks one per test until every
  // later test blocks on acquire and times out - which reads as a slow suite
  // rather than as the FK violation that actually broke it.
  try {
    await seed(session);
  } catch (error) {
    await session.rollback();
    throw error;
  }
  return session;
}

async function seed(session: Session): Promise<void> {
  await session.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
       ($1,'alice@example.test', now(),'{}'), ($2,'bob@example.test', now(),'{}'),
       ($3,'carol@example.test', now(),'{}'), ($4,'dave@example.test', now(),'{}'),
       ($5,'operator@example.test', now(),'{}'), ($6,'frank@example.test', now(),'{}'),
       ($7,'grace@example.test', now(),'{}')`,
    [ALICE, BOB, CAROL, DAVE, OPERATOR, FRANK, GRACE],
  );
  await session.query(
    `insert into public.organizations (id, name, slug, status) values
       ($1,'Org A','rls-a','active'), ($2,'Org B','rls-b','active'),
       ($3,'Org S','rls-s','suspended')`,
    [ORG_A, ORG_B, ORG_SUSPENDED],
  );
  await session.query(
    `insert into public.organization_memberships (organization_id, user_id, status) values
       ($1,$4,'active'), ($1,$5,'active'), ($1,$6,'active'),
       ($2,$7,'active'), ($3,$7,'active'),
       ($1,$8,'active'), ($1,$9,'active')`,
    [ORG_A, ORG_B, ORG_SUSPENDED, ALICE, BOB, DAVE, CAROL, FRANK, GRACE],
  );
  await session.query(
    `insert into public.clinics (id, organization_id, name) values
       ($1,$4,'Clinic 1'), ($2,$4,'Clinic 2'), ($3,$5,'Clinic 3')`,
    [CLINIC_1, CLINIC_2, CLINIC_3, ORG_A, ORG_B],
  );

  await session.query("set local role service_role");
  await session.query(`update public.profiles set is_platform_admin = true where id = $1`, [
    OPERATOR,
  ]);
  await session.query("reset role");

  await session.query(
    `insert into public.roles (id, organization_id, key, name, is_system) values
       ('00000000-0000-4000-8000-000000000001', $1, 'clinician',        'Clinician',        false),
       ('00000000-0000-4000-8000-000000000002', $1, 'org_admin',        'Org Admin',        false),
       ($2, $1, 'medical_director',  'Medical Director',  false),
       ($3, $1, 'clinic_admin',      'Clinic Admin',      false),
       ('00000000-0000-4000-8000-000000000006', $1, 'organization_owner', 'Organization Owner', false)`,
    [ORG_A, ROLE_PARTIAL, ROLE_SETTINGS],
  );
  await session.query(
    `insert into public.role_permissions (role_id, permission_key) values
       ('00000000-0000-4000-8000-000000000001', 'patients.read'),
       ('00000000-0000-4000-8000-000000000002', 'patients.read'),
       ('00000000-0000-4000-8000-000000000002', 'settings.manage'),
       ('00000000-0000-4000-8000-000000000002', 'staff.manage'),
       ('00000000-0000-4000-8000-000000000002', 'audit.read'),
       ('00000000-0000-4000-8000-000000000002', 'patients.create'),
       ('00000000-0000-4000-8000-000000000002', 'patients.update'),
       ('00000000-0000-4000-8000-000000000002', 'subscription.manage'),
       ($1, 'staff.manage'),
       ($2, 'settings.manage'), ($2, 'staff.manage'), ($2, 'patients.read'),
       ('00000000-0000-4000-8000-000000000006', 'patients.read'),
       ('00000000-0000-4000-8000-000000000006', 'settings.manage'),
       ('00000000-0000-4000-8000-000000000006', 'staff.manage'),
       ('00000000-0000-4000-8000-000000000006', 'audit.read'),
       ('00000000-0000-4000-8000-000000000006', 'patients.create'),
       ('00000000-0000-4000-8000-000000000006', 'patients.update'),
       ('00000000-0000-4000-8000-000000000006', 'subscription.manage')`,
    [ROLE_PARTIAL, ROLE_SETTINGS],
  );
  await session.query(
    `insert into public.user_role_assignments (id, organization_id, user_id, role_id, clinic_id) values
       ('00000000-0000-4000-8000-000000000011', $1, $2, '00000000-0000-4000-8000-000000000001', $4),
       ('00000000-0000-4000-8000-000000000012', $1, $3, '00000000-0000-4000-8000-000000000001', null),
       ('00000000-0000-4000-8000-000000000013', $1, $5, '00000000-0000-4000-8000-000000000002', null),
       ('00000000-0000-4000-8000-000000000014', $1, $6, $7, null),
       ('00000000-0000-4000-8000-000000000015', $1, $8, $9, null)`,
    [ORG_A, ALICE, BOB, CLINIC_1, DAVE, FRANK, ROLE_PARTIAL, GRACE, ROLE_SETTINGS],
  );

  // The one thing that scopes bob to a single clinic. Without this row he would
  // inherit every active clinic through clinic_ids' all-active fallback.
  await session.query(
    `insert into public.clinic_memberships (organization_id, membership_id, clinic_id)
     select $1, m.id, $2 from public.organization_memberships m where m.user_id = $3`,
    [ORG_A, CLINIC_1, BOB],
  );

  await session.query(
    `insert into public.patients (id, organization_id, clinic_id, mrn, last_name) values
       ($1,$4,$6,'A-1','One'), ($2,$4,$7,'A-2','Two'), ($3,$5,$8,'B-1','Three')`,
    [PATIENT_1, PATIENT_2, PATIENT_3, ORG_A, ORG_B, CLINIC_1, CLINIC_2, CLINIC_3],
  );
}

const mrnOf = (rows: { mrn: string }[]): string[] => rows.map((r) => r.mrn).sort();

dbDescribe("tenant isolation", () => {
  it("shows a member only their own organization's patients", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      // dave holds patients.read org-wide in org A, which reaches all of org A's
      // clinics - and must not reach org B's patient.
      const rows = await session.query<{ mrn: string }>(`select mrn from public.patients`);
      expect(mrnOf(rows)).toEqual(["A-1", "A-2"]);
    } finally {
      await session.rollback();
    }
  });

  it("shows a member of another organization none of this one's data", async () => {
    // carol is a member of org B and of the suspended org. She belongs to neither
    // is-org-A, so every org A table must be empty for her. Deliberately NOT the
    // platform operator: organizations and platform_settings have a deliberate
    // is_platform_admin branch, and a test that asserted those were empty would be
    // asserting that the operator cannot restore a suspended tenant.
    const session = await stage();
    try {
      await become(session, CAROL);
      const orgATables = [
        "patients",
        "patient_identifiers",
        "clinic_memberships",
        "invitations",
        "roles",
        "role_permissions",
        "user_role_assignments",
        "audit_logs",
      ];
      for (const table of orgATables) {
        const rows = await session.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`,
        );
        expect(Number(rows[0]?.n), `${table} must be empty for a non-member`).toBe(0);
      }

      // Positive control: she still sees her own organization, herself, and the
      // one clinic that organization owns - and not org A's two.
      const orgs = await session.query<{ slug: string }>(`select slug from public.organizations`);
      expect(orgs.map((r) => r.slug)).toEqual(["rls-b"]);
      const clinics = await session.query<{ name: string }>(`select name from public.clinics`);
      expect(clinics.map((r) => r.name)).toEqual(["Clinic 3"]);
      const own = await session.query<{ id: string }>(`select id::text from public.profiles`);
      expect(own.map((r) => r.id)).toEqual([CAROL]);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("clinic scope is a conjunction, not a choice", () => {
  it("stops a clinic-scoped assignment at its own clinic (the `can` clause)", async () => {
    const session = await stage();
    try {
      await become(session, ALICE);
      const rows = await session.query<{ mrn: string }>(`select mrn from public.patients`);
      expect(mrnOf(rows)).toEqual(["A-1"]);
    } finally {
      await session.rollback();
    }
  });

  it("stops an org-wide assignment at the clinics it can reach (the `clinic_ids` clause)", async () => {
    // The case the conjunction exists for. bob's assignment is org-wide, so
    // `can` permits clinic 2 - only the clinic_ids clause withholds A-2. Drop that
    // clause and this test fails.
    const session = await stage();
    try {
      await become(session, BOB);
      const rows = await session.query<{ mrn: string }>(`select mrn from public.patients`);
      expect(mrnOf(rows)).toEqual(["A-1"]);
    } finally {
      await session.rollback();
    }
  });

  it("scopes identifiers with their patient, since they carry no clinic of their own", async () => {
    // patient_identifiers has no clinic_id column, so clinic reach has to come
    // through the patient row. If that link is dropped, a clinic-scoped user
    // reads MRNs for patients in a clinic they cannot reach.
    const session = await stage();
    try {
      await session.query(
        `insert into public.patient_identifiers (id, organization_id, patient_id, kind, value) values
           ('99999999-1111-4111-8111-999999999991', $1, $2, 'mrn_alt', 'X-1'),
           ('99999999-2222-4222-8222-999999999992', $1, $3, 'mrn_alt', 'X-2')`,
        [ORG_A, PATIENT_1, PATIENT_2],
      );

      await become(session, ALICE);
      const mine = await session.query<{ value: string }>(
        `select value from public.patient_identifiers`,
      );
      expect(mine.map((r) => r.value)).toEqual(["X-1"]);

      await session.resetRole();
      await become(session, BOB);
      const bobSees = await session.query<{ value: string }>(
        `select value from public.patient_identifiers`,
      );
      expect(bobSees.map((r) => r.value)).toEqual(["X-1"]);

      // Positive control: the org-wide admin sees both.
      await session.resetRole();
      await become(session, DAVE);
      const admin = await session.query<{ value: string }>(
        `select value from public.patient_identifiers`,
      );
      expect(admin.map((r) => r.value).sort()).toEqual(["X-1", "X-2"]);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("suspension cuts access but not restoration", () => {
  it("hides a suspended tenant from its own members and shows it to the platform", async () => {
    const session = await stage();
    try {
      await become(session, CAROL);
      const tenantView = await session.query<{ slug: string }>(
        `select slug from public.organizations`,
      );
      // carol is a member of org B and of the suspended org. current_org_ids joins
      // organizations for status = 'active', so suspension removes the second.
      expect(tenantView.map((r) => r.slug)).toEqual(["rls-b"]);

      await session.resetRole();
      await become(session, OPERATOR);
      const operatorView = await session.query<{ slug: string }>(
        `select slug from public.organizations where slug in ('rls-a','rls-b','rls-s') order by slug`,
      );
      // The operator must still see the suspended tenant, or they can never
      // restore it - which is the only reason they exist.
      //
      // Scoped to THIS test's slugs rather than all organizations. The operator's
      // view is global by policy (private.is_platform_admin sees every tenant), so
      // a global assertion here depends on no other suite having created an
      // organization - which stopped being true once active-org.test.ts landed.
      // The invariant under test is "the three rls-* tenants, including the
      // suspended one, are visible", not "these are the only tenants in the
      // database".
      expect(operatorView.map((r) => r.slug)).toEqual(["rls-a", "rls-b", "rls-s"]);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("privilege escalation is closed on every path", () => {
  it("refuses to create a platform role, and to attach a platform permission", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);

      await expectRejection(
        session,
        `insert into public.roles (organization_id, key, name, is_system)
           values (null, 'platform_super_admin', 'Sneaky', false)`,
        [],
        /row-level security/i,
      );

      await expectRejection(
        session,
        `insert into public.role_permissions (role_id, permission_key)
           values ('00000000-0000-4000-8000-000000000002', 'platform.tenants.manage')`,
        [],
        /row-level security/i,
      );

      await expectRejection(
        session,
        `insert into public.permissions (key, description) values ('evil.key', 'nope')`,
        [],
        /row-level security|permission denied/i,
      );

      // No resetRole() here: that returns to the session user, which is the table OWNER
      // and therefore bypasses RLS entirely - the assertion would measure postgres, not
      // dave, and pass for the wrong reason.
      const roles = await session.query<{ key: string }>(
        `select key from public.roles order by key`,
      );
      expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(["clinician", "org_admin"]));
      expect(roles.map((r) => r.key)).not.toContain("platform_super_admin");
    } finally {
      await session.rollback();
    }
  });

  it("refuses to enrol, evict or re-status anyone without staff.manage", async () => {
    // This table IS the tenant boundary: current_org_ids, is_member and clinic_ids
    // all read it. Gating its UPDATE on bare is_member meant any member - holding
    // no role at all - could rewrite a row's user_id and enrol an arbitrary
    // account into the tenant. MEASURED before the fix: 1 row changed, and the
    // outsider immediately read the org directory and the staff roster.
    const OUTSIDER = "99999999-0000-4000-8000-0000000000ff";
    const session = await stage();
    try {
      await become(session, ALICE);
      for (const statement of [
        `update public.organization_memberships set user_id = '${OUTSIDER}' where organization_id = $1 returning user_id`,
        `update public.organization_memberships set status = 'revoked' where organization_id = $1 returning status`,
        `update public.organization_memberships set status = 'active' where organization_id = $1 returning status`,
      ]) {
        const rows = await session.query(statement, [ORG_A]);
        expect(
          rows,
          `alice holds no staff.manage; ${statement.slice(7, 60)} must filter every row`,
        ).toEqual([]);
      }

      // Positive control: staff.manage is what opens it. Without this the three
      // assertions above would also pass against a policy that refuses everyone,
      // which is a tenant nobody can administer.
      await session.resetRole();
      await become(session, DAVE);
      const permitted = await session.query<{ user_id: string }>(
        `update public.organization_memberships set status = 'suspended' where organization_id = $1 returning user_id::text`,
        [ORG_A],
      );
      expect(permitted).toHaveLength(5);
    } finally {
      await session.rollback();
    }
  });

  it("refuses tenant settings writes to anyone without settings.manage", async () => {
    // currency is not cosmetic: money is bigint minor units OF the tenant's
    // currency, so flipping it relabels every stored amount in the product.
    // timezone feeds the clinicDayBounds report windows. slug is the tenant's
    // public identifier. MEASURED before the fix: alice set currency to 'XXX'.
    const session = await stage();
    try {
      await become(session, ALICE);
      const refused = await session.query<{ currency: string }>(
        `update public.organizations set currency = 'XXX', timezone = 'UTC' where id = $1 returning currency`,
        [ORG_A],
      );
      expect(refused).toEqual([]);

      await session.resetRole();
      await become(session, DAVE);
      const permitted = await session.query<{ currency: string }>(
        `update public.organizations set currency = 'USD' where id = $1 returning currency`,
        [ORG_A],
      );
      expect(permitted).toEqual([{ currency: "USD" }]);

      // And the platform operator can still restore a suspended tenant, which is
      // the whole reason the organizations policy has a platform branch at all.
      await session.resetRole();
      await become(session, OPERATOR);
      const restored = await session.query<{ status: string }>(
        `update public.organizations set status = 'active' where id = $1 returning status`,
        [ORG_SUSPENDED],
      );
      expect(restored).toEqual([{ status: "active" }]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses to delete a role that is still in use", async () => {
    // THE LOCKOUT. Deleting an assigned role cascades away its role_permissions and
    // its assignments. If the deleted role was the one granting settings.manage, the
    // deleter loses that too - and re-creating a role REQUIRES settings.manage, so the
    // tenant is left with no administrators and no client repair path.
    //
    // My first attempt gated this on `is_system is not true`, which was a NO-OP:
    // gen-permissions-sql.ts populates that column from role.isPlatform, so every
    // tenant-seeded role is is_system = false and the clause was equivalent to the
    // organization_id is not null already present. The fixture then hand-seeded
    // is_system = true, a state no production path produces, so the test proved
    // nothing about the product. MEASURED against the real onboarding RPC: all
    // fourteen seeded roles have is_system = false.
    //
    // Both are fixed - the fixture uses what the product creates, and the guard is
    // the actual invariant rather than a column whose meaning is disputed.
    const session = await stage();
    try {
      await become(session, DAVE);
      // Refused by the BEFORE DELETE trigger, so it RAISES. Previously this was a
      // policy clause and filtered silently - the third refusal shape in this file.
      await expectRejection(
        session,
        `delete from public.roles where organization_id = $1 and key = 'clinician'`,
        [ORG_A],
        /still in use/i,
      );

      // Positive control: a role nobody holds is the tenant's to remove.
      await session.query(
        `insert into public.roles (organization_id, key, name, is_system)
         values ($1, 'temp_unused', 'Temp', false)`,
        [ORG_A],
      );
      const unused = await session.query<{ key: string }>(
        `delete from public.roles where organization_id = $1 and key = 'temp_unused' returning key`,
        [ORG_A],
      );
      expect(unused).toEqual([{ key: "temp_unused" }]);

      // Once it IS assigned it stops being removable. That is the intended workflow:
      // revoke the assignments first, then drop the role.
      await session.query(
        `insert into public.roles (organization_id, key, name, is_system)
         values ($1, 'temp_used', 'Temp', false)`,
        [ORG_A],
      );
      await session.query(
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         select $1, $2, r.id from public.roles r
          where r.organization_id = $1 and r.key = 'temp_used'`,
        [ORG_A, BOB],
      );
      await expectRejection(
        session,
        `delete from public.roles where organization_id = $1 and key = 'temp_used'`,
        [ORG_A],
        /still in use/i,
      );
    } finally {
      await session.rollback();
    }
  });

  it("refuses to re-key a role or flip it to system", async () => {
    // key is the identity the registry maps through, so renaming it breaks every
    // lookup by key. Flipping is_system would make a role undeletable, which is a
    // self-inflicted denial of service dressed as an admin action.
    const session = await stage();
    try {
      await become(session, DAVE);
      // A trigger refusal RAISES, like a failed INSERT WITH CHECK and unlike a
      // filtered UPDATE. Three refusal shapes now in this file, each with its own
      // assertion shape: RLS USING -> toEqual([]), WITH CHECK -> expectRejection,
      // trigger -> expectRejection.
      for (const statement of [
        `update public.roles set key = 'hijacked' where organization_id = $1 and key = 'clinician'`,
        `update public.roles set is_system = true where organization_id = $1 and key = 'clinician'`,
      ]) {
        await expectRejection(session, statement, [ORG_A], /not user-writable/i);
      }

      await session.resetRole();
      const after = await session.query<{ key: string; is_system: boolean }>(
        `select key, is_system from public.roles where organization_id = $1 order by key`,
        [ORG_A],
      );
      expect(after.map((r) => r.key)).toEqual(
        expect.arrayContaining(["clinician", "org_admin", "organization_owner"]),
      );
      expect(after.map((r) => r.key)).not.toContain("platform_super_admin");
      expect(after.every((r) => r.is_system === false)).toBe(true);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an assignment or invitation naming a platform role", async () => {
    // Latent rather than live - can() refuses platform keys, so attaching the
    // platform role confers nothing today. But it costs one EXISTS to say no at
    // the policy layer, and the acceptance RPC that would resolve this is Task 12.
    const session = await stage();
    try {
      await session.resetRole();
      const platform = await session.query<{ id: string }>(
        `select id::text from public.roles where organization_id is null`,
      );
      const platformRole = platform[0]?.id as string;

      await become(session, DAVE);
      // A refused INSERT RAISES rather than returning no rows - the opposite of a
      // filtered UPDATE, which is why this uses expectRejection and the UPDATE
      // assertions above do not.
      await expectRejection(
        session,
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3)`,
        [ORG_A, BOB, platformRole],
        /row-level security/i,
      );

      await expectRejection(
        session,
        `insert into public.invitations (organization_id, email, role_id, token_hash, expires_at)
         values ($1, 'x@example.test', $2, 'hash', now() + interval '1 day')`,
        [ORG_A, platformRole],
        /row-level security/i,
      );

      // Positive control: an org-scoped role is accepted. Without it, the two
      // refusals above would also pass against a policy refusing every insert.
      const permitted = await session.query(
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3) returning id`,
        [ORG_A, DAVE, "00000000-0000-4000-8000-000000000001"],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an invitation naming another organization's clinic", async () => {
    // clinic_ids is a bare uuid[] - arrays cannot carry the composite foreign key
    // that every other tenant reference in this schema uses, so the policy has to
    // carry the invariant the FK would otherwise enforce.
    const session = await stage();
    try {
      await become(session, DAVE);
      await expectRejection(
        session,
        `insert into public.invitations (organization_id, email, role_id, token_hash, clinic_ids, expires_at)
         values ($1, 'y@example.test', $2, 'hash', array[$3::uuid], now() + interval '1 day')`,
        [ORG_A, "00000000-0000-4000-8000-000000000001", CLINIC_3],
        /row-level security/i,
      );

      // Positive control: a clinic of the invitation's own organization is fine.
      const permitted = await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, clinic_ids, invited_by, expires_at)
         values ($1, 'y@example.test', $2, 'hash', array[$3::uuid], $4, now() + interval '1 day') returning id`,
        [ORG_A, "00000000-0000-4000-8000-000000000001", CLINIC_1, DAVE],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a membership in a clinic the writer cannot reach", async () => {
    const session = await stage();
    try {
      await become(session, ALICE);
      // alice has no staff.manage, so she can neither read nor write these.
      await expect(
        session.query(`select count(*)::text as n from public.clinic_memberships`),
      ).resolves.toEqual([{ n: "0" }]);
      await expect(
        session.query(
          `insert into public.clinic_memberships (organization_id, membership_id, clinic_id)
           select $1, m.id, $2 from public.organization_memberships m where m.user_id = $3`,
          [ORG_A, CLINIC_1, ALICE],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await session.rollback();
    }
  });

  it("lets an administrator manage staff, and refuses everyone else", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      // dave holds staff.manage org-wide, so he sees every assignment in org A -
      // including alice's clinic-scoped one, which is the case the two-argument
      // can() plus a NULL-tolerant reach clause exists to keep visible.
      const rows = await session.query<{ key: string; clinic_scoped: boolean }>(
        `select r.key, a.clinic_id is not null as clinic_scoped
           from public.user_role_assignments a
           join public.roles r on r.id = a.role_id
          order by r.key, a.clinic_id nulls first`,
      );
      expect(rows.map((r) => r.key)).toEqual([
        "clinic_admin",
        "clinician",
        "clinician",
        "medical_director",
        "org_admin",
      ]);
      const scoped = rows.filter((r) => r.clinic_scoped).map((r) => r.key);
      expect(scoped).toEqual(["clinician"]);

      await session.resetRole();
      await become(session, ALICE);
      const own = await session.query<{ key: string }>(
        `select r.key from public.user_role_assignments a
           join public.roles r on r.id = a.role_id`,
      );
      // A user can always see their own assignments, or the app cannot render
      // what they are permitted to do. No staff.manage, so only their own.
      expect(own.map((r) => r.key)).toEqual(["clinician"]);

      // And the write path is closed to them. NOTE the shape of this assertion:
      // RLS FILTERS the row out rather than raising, so the statement succeeds and
      // updates zero rows. Asserting that it throws would pass against a policy set
      // that filtered nothing and failed for some unrelated reason. Asserting the
      // returned rows is what actually measures the refusal - MEASURED: 0 rows
      // updated, role_id unchanged.
      const escalated = await session.query<{ role_id: string }>(
        `update public.user_role_assignments set role_id = '00000000-0000-4000-8000-000000000002'
          where user_id = $1
        returning role_id`,
        [ALICE],
      );
      expect(escalated).toEqual([]);

      await session.resetRole();
      const after = await session.query<{ role_id: string }>(
        `select role_id::text from public.user_role_assignments where user_id = $1`,
        [ALICE],
      );
      expect(after[0]?.role_id).toBe("00000000-0000-4000-8000-000000000001");
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("profiles", () => {
  it("lets a user edit themselves but not mint themselves an admin flag", async () => {
    const session = await stage();
    try {
      await become(session, ALICE);
      await session.query(`update public.profiles set full_name = 'Alice A' where id = $1`, [
        ALICE,
      ]);
      const self = await session.query<{ full_name: string; is_platform_admin: boolean }>(
        `select full_name, is_platform_admin from public.profiles where id = $1`,
        [ALICE],
      );
      expect(self[0]?.full_name).toBe("Alice A");
      expect(self[0]?.is_platform_admin).toBe(false);

      // The INSERT-side route to platform admin. No INSERT policy exists.
      await expectRejection(
        session,
        `insert into public.profiles (id, full_name, is_platform_admin) values ($1, 'Mallory', true)`,
        ["99999999-9999-4999-8999-999999999999"],
        /row-level security/i,
      );

      // And the UPDATE-side route. TWO guards refuse this and either is acceptable: the
      // BEFORE UPDATE trigger fires first and raises, and the policy's WITH CHECK
      // forbids the value independently. Keeping both is the point - the trigger
      // covers this path only while it stays attached, and the policy covers it
      // even if it is not. This assertion deliberately does not say which fired,
      // because PostgreSQL evaluates them in that order and a test pinned to one
      // message would break on a version bump without any behaviour changing.
      await expectRejection(
        session,
        `update public.profiles set is_platform_admin = true where id = $1`,
        [ALICE],
        /row-level security|is_platform_admin is not user-writable/i,
      );

      // And nobody else's row. Filtered rather than raised: zero rows come back.
      const notMine = await session.query<{ id: string }>(
        `update public.profiles set full_name = 'Not Bob' where id = $1 returning id::text`,
        [BOB],
      );
      expect(notMine).toEqual([]);

      await session.resetRole();
      const bobStill = await session.query<{ full_name: string | null }>(
        `select full_name from public.profiles where id = $1`,
        [BOB],
      );
      expect(bobStill[0]?.full_name).toBeNull();
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("audit and platform settings", () => {
  it("lets a tenant read its own trail with audit.read, and no one else", async () => {
    const session = await stage();
    try {
      await session.query(
        `insert into public.audit_logs (organization_id, actor_user_id, action, resource_type)
         values ($1, $2, 'patient.read', 'patient'), ($1, $2, 'patient.read', 'patient'),
                (null, null, 'platform.tenants.manage', 'organization')`,
        [ORG_A, DAVE],
      );

      await become(session, DAVE);
      const mine = await session.query<{ n: string }>(
        `select count(*)::text as n from public.audit_logs`,
      );
      expect(Number(mine[0]?.n)).toBe(2);

      // carol has no audit.read, and is not even in org A.
      await session.resetRole();
      await become(session, CAROL);
      const theirs = await session.query<{ n: string }>(
        `select count(*)::text as n from public.audit_logs`,
      );
      expect(Number(theirs[0]?.n)).toBe(0);

      // The operator reads the platform-scoped half of the trail - and NOT org A's,
      // which belongs to org A. Asserting the platform branch without this
      // negative would pass on an operator who sees everything.
      await session.resetRole();
      await become(session, OPERATOR);
      const operatorTrail = await session.query<{ action: string }>(
        `select action from public.audit_logs order by action`,
      );
      expect(operatorTrail.map((r) => r.action)).toEqual(["platform.tenants.manage"]);
    } finally {
      await session.rollback();
    }
  });

  it("shows platform settings to the platform and to nobody else", async () => {
    const session = await stage();
    try {
      await session.query(
        `insert into public.platform_settings (key, value) values ('signup.mode', '"invite_only"')`,
      );

      await become(session, DAVE);
      const tenant = await session.query<{ key: string }>(
        `select key from public.platform_settings`,
      );
      expect(tenant).toEqual([]);

      await session.resetRole();
      await become(session, OPERATOR);
      const operator = await session.query<{ key: string }>(
        `select key from public.platform_settings`,
      );
      expect(operator.map((r) => r.key)).toEqual(["signup.mode"]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses every write to the audit trail", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      for (const statement of [
        `update public.audit_logs set action = 'rewritten' where id = 1`,
        `delete from public.audit_logs`,
        `insert into public.audit_logs (organization_id, action, resource_type) values ($1, 'forged', 'x')`,
      ]) {
        await expect(session.query(statement, [ORG_A])).rejects.toThrow();
      }
      await expect(
        session.query(
          `update public.platform_settings set value = '{}'::jsonb where key = 'signup.mode'`,
        ),
      ).rejects.toThrow();
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("authorised writes actually work", () => {
  // The suite's other half. Every refusal elsewhere is worthless without these: a
  // policy set that refuses everything passes a refusal-only suite. MEASURED: with
  // patients_write, patient_identifiers_write and role_permissions_write each
  // replaced by `with check (false)` - still non-null, so the catalogue test still
  // passed, and the policy count was unchanged - every test in the file passed with
  // three tenant tables made permanently unwritable.
  it("lets an org administrator create, read, edit and remove a patient", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const created = await session.query<{ id: string; mrn: string }>(
        `insert into public.patients (organization_id, clinic_id, mrn, last_name)
         values ($1, $2, 'A-3', 'Three') returning id::text, mrn`,
        [ORG_A, CLINIC_1],
      );
      expect(created).toHaveLength(1);

      const patientId = created[0]?.id as string;

      const edited = await session.query<{ last_name: string }>(
        `update public.patients set last_name = 'Edited' where id = $1 returning last_name`,
        [patientId],
      );
      expect(edited).toEqual([{ last_name: "Edited" }]);

      const removed = await session.query<{ mrn: string }>(
        `delete from public.patients where id = $1 returning mrn`,
        [patientId],
      );
      expect(removed).toEqual([{ mrn: "A-3" }]);
    } finally {
      await session.rollback();
    }
  });

  it("lets an org administrator attach and detach a patient's identifier", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const added = await session.query<{ value: string }>(
        `insert into public.patient_identifiers (organization_id, patient_id, kind, value)
         values ($1, $2, 'mrn_alt', 'Y-1') returning value`,
        [ORG_A, PATIENT_1],
      );
      expect(added).toEqual([{ value: "Y-1" }]);

      const removed = await session.query<{ value: string }>(
        `delete from public.patient_identifiers where value = 'Y-1' returning value`,
      );
      expect(removed).toEqual([{ value: "Y-1" }]);
    } finally {
      await session.rollback();
    }
  });

  it("lets an org administrator grant and revoke a permission on its own role", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const granted = await session.query<{ permission_key: string }>(
        `insert into public.role_permissions (role_id, permission_key)
         values ('00000000-0000-4000-8000-000000000001', 'patients.create') returning permission_key`,
      );
      expect(granted).toEqual([{ permission_key: "patients.create" }]);

      const revoked = await session.query<{ permission_key: string }>(
        `delete from public.role_permissions
          where role_id = '00000000-0000-4000-8000-000000000001'
            and permission_key = 'patients.create'
        returning permission_key`,
      );
      expect(revoked).toEqual([{ permission_key: "patients.create" }]);
    } finally {
      await session.rollback();
    }
  });

  it("lets an org administrator rename a clinic and scope a member to it", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const renamed = await session.query<{ name: string }>(
        `update public.clinics set name = 'Clinic One' where id = $1 returning name`,
        [CLINIC_1],
      );
      expect(renamed).toEqual([{ name: "Clinic One" }]);

      const scoped = await session.query<{ clinic_id: string }>(
        `insert into public.clinic_memberships (organization_id, membership_id, clinic_id)
         select $1, m.id, $2 from public.organization_memberships m where m.user_id = $3
         returning clinic_id::text`,
        [ORG_A, CLINIC_1, ALICE],
      );
      expect(scoped).toEqual([{ clinic_id: CLINIC_1 }]);

      const unscoped = await session.query<{ clinic_id: string }>(
        `delete from public.clinic_memberships
          where organization_id = $1 and clinic_id = $2 returning clinic_id::text`,
        [ORG_A, CLINIC_1],
      );
      expect(unscoped).toHaveLength(2);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an unprivileged update rather than raising, so a caller can tell it apart", async () => {
    // A loose USING with a tight WITH CHECK makes an unprivileged UPDATE raise
    // 42501 where every other policy silently filters the row out. That
    // inconsistency was the only asymmetric policy in the set; roles_update now
    // carries its permission in both clauses, so this asserts the filter shape.
    //
    // It carries a positive control because without one it is the file's own
    // anti-pattern: an assertion that alice is refused also passes against a policy
    // that refuses everybody.
    const session = await stage();
    try {
      await become(session, ALICE);
      const refused = await session.query<{ key: string }>(
        `update public.roles set name = 'Renamed' where organization_id = $1 returning key`,
        [ORG_A],
      );
      expect(refused).toEqual([]);

      await session.resetRole();
      await become(session, DAVE);
      const permitted = await session.query<{ name: string }>(
        `update public.roles set name = 'Renamed' where organization_id = $1 returning name`,
        [ORG_A],
      );
      expect(permitted.length).toBeGreaterThan(0);
      expect(new Set(permitted.map((r) => r.name))).toEqual(new Set(["Renamed"]));
    } finally {
      await session.rollback();
    }
  });

  // The seven command policies the re-review proved could each be replaced by
  // `using (false) with check (false)` - leaving the policy count at 52 and the
  // non-null qual/with_check assertions intact - with every test in the file still
  // passing. Each now has an authorised-write positive control, so neutering one
  // turns this suite red instead of silently disabling that operation.
  it("lets an administrator exercise every remaining write command", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);

      const regrant = await session.query<{ permission_key: string }>(
        `update public.role_permissions set permission_key = 'patients.create'
          where role_id = '00000000-0000-4000-8000-000000000001'
            and permission_key = 'patients.read'
        returning permission_key`,
      );
      expect(regrant).toEqual([{ permission_key: "patients.create" }]);

      await session.query(
        `insert into public.patient_identifiers (organization_id, patient_id, kind, value)
         values ($1, $2, 'mrn_alt', 'Z-1')`,
        [ORG_A, PATIENT_1],
      );
      const reidentified = await session.query<{ value: string }>(
        `update public.patient_identifiers set value = 'Z-2' where value = 'Z-1' returning value`,
      );
      expect(reidentified).toEqual([{ value: "Z-2" }]);

      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'w@example.test', $2, 'hash', $3, now() + interval '1 day')`,
        [ORG_A, "00000000-0000-4000-8000-000000000001", DAVE],
      );
      const reissued = await session.query<{ email: string }>(
        `update public.invitations set email = 'w2@example.test'
          where organization_id = $1 returning email`,
        [ORG_A],
      );
      expect(reissued).toEqual([{ email: "w2@example.test" }]);
      const withdrawn = await session.query<{ email: string }>(
        `delete from public.invitations where organization_id = $1 returning email`,
        [ORG_A],
      );
      expect(withdrawn).toEqual([{ email: "w2@example.test" }]);

      const reassigned = await session.query<{ role_id: string }>(
        `update public.user_role_assignments set clinic_id = $1
          where organization_id = $2 and user_id = $3
        returning role_id::text`,
        [CLINIC_1, ORG_A, ALICE],
      );
      expect(reassigned).toHaveLength(1);
      const unassigned = await session.query<{ user_id: string }>(
        `delete from public.user_role_assignments
          where organization_id = $1 and user_id = $2
        returning user_id::text`,
        [ORG_A, ALICE],
      );
      expect(unassigned).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("the grant ceiling", () => {
  // I DECLINED this twice, on the stated premise that a subset ceiling "would break
  // the legitimate admin-creates-owner flow". That premise was never measured, and it
  // is false: measured against a tenant built by the real onboarding RPC,
  // organization_owner and organization_admin carry BYTE-IDENTICAL 17-permission
  // sets, so an org_admin who holds all seventeen passes a subset ceiling unchanged.
  // A ceiling therefore closes the escalation without closing the flow.
  it("refuses to assign a role carrying a permission the assigner does not hold", async () => {
    const session = await stage();
    try {
      await become(session, FRANK);
      // FRANK holds staff.manage and nothing else. organization_owner carries 17.
      await expectRejection(
        session,
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         select $1, $2, r.id from public.roles r
          where r.organization_id = $1 and r.key = 'organization_owner'`,
        [ORG_A, FRANK],
        /row-level security/i,
      );
    } finally {
      await session.rollback();
    }
  });

  it("refuses to mint a permission key the granter does not hold", async () => {
    // The escalation nobody had recorded. GRACE holds settings.manage, which is
    // enough to edit any role in the organization - so before this she could add
    // subscription.manage to her own role, assign it to herself, and hold a
    // permission the shipped clinic_admin role deliberately withholds.
    const session = await stage();
    try {
      await become(session, GRACE);
      // Target org_admin, which exists in this fixture. An earlier version of this
      // test named 'organization_admin', which the fixture does not create - so the
      // INSERT matched zero rows, nothing was ever checked, and the assertion passed
      // for no reason at all. A refusal test that inserts nothing proves nothing.
      await expectRejection(
        session,
        `insert into public.role_permissions (role_id, permission_key)
         select r.id, 'subscription.manage' from public.roles r
          where r.organization_id = $1 and r.key = 'org_admin'`,
        [ORG_A],
        /row-level security/i,
      );
      await expectRejection(
        session,
        `update public.role_permissions set permission_key = 'subscription.manage'
          where role_id = $1 and permission_key = 'patients.read'`,
        [ROLE_SETTINGS],
        /row-level security/i,
      );

      // Positive control: a key she DOES hold is grantable, or the ceiling is just
      // refusing everybody.
      const permitted = await session.query<{ permission_key: string }>(
        `insert into public.role_permissions (role_id, permission_key)
         values ($1, 'staff.manage') returning permission_key`,
        ["00000000-0000-4000-8000-000000000001"],
      );
      expect(permitted).toEqual([{ permission_key: "staff.manage" }]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an administrator the owner role, and allows a real owner", async () => {
    // THE OWNER CLAUSE, ON THE DIRECT ASSIGNMENT PATH.
    //
    // DAVE holds `org_admin`, whose permission set is IDENTICAL to the owner's -
    // 01240's own measurement - so the SUBSET rule cannot tell the two apart, and
    // only the owner clause can.
    //
    // AN EARLIER VERSION OF THIS TEST ASSERTED THE OPPOSITE: that an administrator
    // could create an owner, "which is why the ceiling is a subset". That was the
    // hole. Two contradicting ceilings - the subset rule on the assignment path and
    // the owner rule on the invitation path - and a test pinning the wrong one.
    const session = await stage();
    try {
      await stageOwner(session);

      await become(session, DAVE);
      // The INSERT path.
      await expectRejection(
        session,
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3)`,
        [ORG_A, DAVE, OWNER_ROLE],
        /row-level security/i,
      );

      // The UPDATE path: an assignment the granter may grant - BOB already holds the
      // `clinician` role - and then MOVED to the owner role.
      await expectRejection(
        session,
        `update public.user_role_assignments set role_id = $1
          where organization_id = $2 and user_id = $3`,
        [OWNER_ROLE, ORG_A, BOB],
        /row-level security/i,
      );

      // Positive control: a REAL OWNER may grant the owner role, on both paths. A
      // ceiling that refused everybody would pass every refusal above.
      await become(session, OWNER);
      const granted = await session.query<{ id: string }>(
        `insert into public.user_role_assignments (organization_id, user_id, role_id)
         values ($1, $2, $3) returning id`,
        [ORG_A, ALICE, OWNER_ROLE],
      );
      expect(granted).toHaveLength(1);
      const moved = await session.query<{ role_id: string }>(
        `update public.user_role_assignments set role_id = $1
          where organization_id = $2 and user_id = $3 returning role_id::text`,
        [OWNER_ROLE, ORG_A, BOB],
      );
      expect(moved).toHaveLength(1);
      expect(moved[0]?.role_id).toBe(OWNER_ROLE);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("the role editor's clear-all button", () => {
  it("refuses to strip the permissions from a role the caller holds", async () => {
    // The lockout 01230 exists to prevent is reachable in ONE statement through
    // role_permissions rather than through roles: clear every grant from your own
    // admin role and the tenant has zero grants, zero ways to make any, and no
    // client repair path. 01230's guard is on the wrong table for the invariant.
    const session = await stage();
    try {
      await become(session, DAVE);
      const blocked = await session.query<{ permission_key: string }>(
        `delete from public.role_permissions where role_id = $1 returning permission_key`,
        ["00000000-0000-4000-8000-000000000002"],
      );
      expect(blocked, "an admin must not be able to revoke their own route to admin").toEqual([]);

      // Positive control: stripping a role the caller does NOT hold is fine.
      await session.query(
        `delete from public.role_permissions where role_id = $1 and permission_key = 'patients.read'`,
        [ROLE_SETTINGS],
      );
      const stillThere = await session.query<{ n: string }>(
        `select count(*)::text as n from public.role_permissions where role_id = $1`,
        ["00000000-0000-4000-8000-000000000002"],
      );
      expect(Number(stillThere[0]?.n)).toBe(7);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("the shell can tell 'no membership' from 'a hidden membership'", () => {
  it("hides a suspended membership from its owner, and says it is there", async () => {
    // The memberships table's row filter is `private.is_member(organization_id)`, and
    // `is_member` requires an ACTIVE membership in an ACTIVE organization. So a
    // suspended membership - and a membership of a suspended tenant - is filtered out
    // before it reaches its owner.
    //
    // That made the shell's first branch wrong: an empty membership list reads as
    // "you belong to nothing", and the shell answered that with the ONBOARDING screen,
    // which offers to create an organization to a member the database is hiding.
    //
    // `public.has_any_membership()` answers the question RLS cannot - it is a
    // definer, so it sees the hidden rows - and it answers about the CALLER only, so
    // it is not an oracle about anybody else.
    const session = await stage();
    try {
      await session.resetRole();
      await session.query(
        `update public.organization_memberships set status = 'suspended'
          where organization_id = $1 and user_id = $2`,
        [ORG_A, ALICE],
      );

      await become(session, ALICE);
      // The row is invisible to her.
      const visible = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships where user_id = $1`,
        [ALICE],
      );
      expect(Number(visible[0]?.n)).toBe(0);

      // And the database says she does have one.
      const any = await session.query<{ any: boolean }>(
        `select public.has_any_membership() as any`,
      );
      expect(any[0]?.any).toBe(true);

      // A user with no membership at all is told the truth.
      await become(session, OPERATOR);
      const none = await session.query<{ any: boolean }>(
        `select public.has_any_membership() as any`,
      );
      expect(none[0]?.any).toBe(false);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("private helpers are not oracles", () => {
  it("refuses a direct call to role_in_use, which answers for roles you cannot see", async () => {
    // role_in_use took a role_id and returned a boolean about ANY role, so a member
    // of one tenant could probe another tenant's roles. PostgreSQL does not check
    // EXECUTE when invoking a trigger function, so the check moved into a BEFORE
    // DELETE trigger and the grant went away entirely.
    const session = await stage();
    try {
      await become(session, CAROL);
      await expectRejection(
        session,
        `select private.role_in_use($1::uuid)`,
        ["00000000-0000-4000-8000-000000000001"],
        /permission denied/i,
      );
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("the invitation grant ceiling", () => {
  /*
   * THE ESCALATION THIS BLOCK EXISTS FOR.
   *
   * The ceiling was put in the invitations INSERT policy and nowhere else, and the
   * UPDATE policy is what changes the role an invitation will hand out. So a
   * `medical_director` - which holds `staff.manage` and the doctor's permissions, but
   * not `settings.manage`, `billing.manage` or `subscription.manage` - could create an
   * invitation for `doctor`, UPDATE its `role_id` to `organization_owner`, and then
   * redeem the token it already held: `private.accept_invitation` is a definer, so no
   * policy stood in the way, and it wrote the `user_role_assignments` row for
   * `organization_owner`.
   *
   * Every test below has a POSITIVE CONTROL beside it. A refusal-only block passes
   * just as well against a policy that refuses everything, and against a function that
   * refuses every acceptance - which is exactly what a broken fix would look like.
   */

  /** The token the acceptance function is handed, and the digest the row must hold. */
  const TOKEN = "c".repeat(64);
  const TOKEN_HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");

  /** A second token, for the cases that need two invitations in one test. */
  const TOKEN_TWO = "d".repeat(64);
  const TOKEN_TWO_HASH = createHash("sha256").update(TOKEN_TWO, "utf8").digest("hex");

  /** A principal who is a member of nothing, so a membership created is visible. */
  const NEWCOMER = "ab000000-1111-4111-8111-ab0000000009";

  /** A principal whose address is NOT confirmed. */
  const UNCONFIRMED = "ab000000-1111-4111-8111-ab0000000007";

  /**
   * Become a principal whose JWT carries an email claim.
   *
   * `private.accept_invitation` compares the invitation's address with the
   * ACCEPTOR's claim, so a test of the acceptance path has to set one - and it has to
   * set it the way PostgREST does. `request.jwt.claim.sub` is what `auth.uid()` reads
   * and `request.jwt.claims` is what `auth.jwt()` reads; the two are set separately
   * because the library reads the sub claim first and the whole claims object second.
   */
  async function becomeWithEmail(session: Session, userId: string, email: string): Promise<void> {
    await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await session.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, email }),
    ]);
    await session.query("set local role authenticated");
  }

  it("refuses an invitation whose inviter is somebody else", async () => {
    // THE INVITER IS THE CALLER. `private.accept_invitation` judges the grant ceiling
    // for `invited_by` - the person who issued the invitation - so a column the
    // caller supplies would make the SUBJECT of the ceiling attacker-chosen. The
    // write-time ceiling still bounds the role, so this was not an escalation; but
    // two ceilings that can diverge is not a thing to leave in place.
    const session = await stage();
    try {
      await become(session, FRANK);
      // FRANK names DAVE as the inviter. FRANK holds staff.manage, and the role
      // named is one he may grant, so every other clause passes - and the policy
      // refuses because the inviter is not the caller.
      await expectRejection(
        session,
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'someone@example.test', $2, 'hash-inviter', $3, now() + interval '1 day')`,
        [ORG_A, ROLE_PARTIAL, DAVE],
        /row-level security/i,
      );

      // Positive control: the same invitation, issued by the caller, is accepted.
      const permitted = await session.query<{ id: string }>(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'someone@example.test', $2, 'hash-inviter-ok', $3, now() + interval '1 day')
         returning id`,
        [ORG_A, ROLE_PARTIAL, FRANK],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an invitation naming a role the inviter may not grant", async () => {
    const session = await stage();
    try {
      await become(session, FRANK);
      // FRANK holds staff.manage and nothing else. The medical_director role carries
      // settings.manage and patients.read as well, so FRANK may not hand it out -
      // and an invitation for it would make its holder a doctor AND a settings
      // manager, which FRANK is neither.
      await expectRejection(
        session,
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'frank-target@example.test', $2, 'hash-frank-refused', $3, now() + interval '1 day')`,
        [ORG_A, ROLE_SETTINGS, FRANK],
        /row-level security/i,
      );

      // Positive control: the role whose ONLY permission is staff.manage - the one
      // FRANK holds - is grantable. Without this, the refusal above would also pass
      // against a policy refusing every invitation.
      const permitted = await session.query<{ id: string }>(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'frank-target@example.test', $2, 'hash-frank-ok', $3, now() + interval '1 day')
         returning id`,
        [ORG_A, ROLE_PARTIAL, FRANK],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses to move an invitation to a role the writer may not grant", async () => {
    const session = await stage();
    try {
      await become(session, FRANK);
      // An invitation FRANK may create: the role whose only permission he holds.
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'frank-target@example.test', $2, 'hash-move', $3, now() + interval '1 day')`,
        [ORG_A, ROLE_PARTIAL, FRANK],
      );

      // THE ESCALATION. The row stays visible to FRANK (its USING clause passes), and
      // the NEW row is refused by the ceiling in the WITH CHECK - which RAISES,
      // because a failed check on an otherwise visible row is an error and not a
      // silent filter.
      await expectRejection(
        session,
        `update public.invitations set role_id = $1 where token_hash = 'hash-move'`,
        [ROLE_SETTINGS],
        /row-level security/i,
      );

      // Positive control: the same writer may still change the invitation's other
      // columns, and the role it names is untouched.
      const stillThere = await session.query<{ role_id: string }>(
        `update public.invitations set email = 'frank-target2@example.test'
          where token_hash = 'hash-move' returning role_id::text`,
      );
      expect(stillThere).toHaveLength(1);
      expect(stillThere[0]?.role_id).toBe(ROLE_PARTIAL);
    } finally {
      await session.rollback();
    }
  });

  it("refuses to accept an invitation for a suspended organization", async () => {
    const session = await stage();
    try {
      // A role of the suspended organization, so the ONLY thing wrong with this
      // invitation is the organization's status.
      await session.resetRole();
      await session.query(
        `insert into public.roles (organization_id, key, name) values ($1, 'doctor', 'Doctor')`,
        [ORG_SUSPENDED],
      );
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         select $1, 'alice@example.test', r.id, $2, $3, now() + interval '1 day'
           from public.roles r where r.organization_id = $1 and r.key = 'doctor'`,
        [ORG_SUSPENDED, TOKEN_HASH, CAROL],
      );

      await becomeWithEmail(session, ALICE, "alice@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /not accepting new members/i,
      );

      // And no membership was created for the suspended organization.
      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships
          where organization_id = $1 and user_id = $2`,
        [ORG_SUSPENDED, ALICE],
      );
      expect(Number(memberships[0]?.n)).toBe(0);
    } finally {
      await session.rollback();
    }
  });

  it("refuses to accept an invitation naming another tenant's role", async () => {
    const session = await stage();
    try {
      // The invitation names a role of org A. Then the ROLE is moved to org B -
      // which the schema allows, because `private.guard_role_identity` guards the
      // role's key and its system flag, not its organization. So this is a state the
      // database can actually reach, and the invitation now names a role of another
      // tenant.
      await session.resetRole();
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'alice@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, ROLE_SETTINGS, TOKEN_HASH, DAVE],
      );
      await session.query(`update public.roles set organization_id = $1 where id = $2`, [
        ORG_B,
        ROLE_SETTINGS,
      ]);

      await becomeWithEmail(session, ALICE, "alice@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /role this organization does not have/i,
      );

      // And ALICE gained no membership anywhere new.
      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships where user_id = $1`,
        [ALICE],
      );
      expect(Number(memberships[0]?.n)).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("accepts an invitation that names a role of its own tenant, addressed to the acceptor", async () => {
    // THE POSITIVE CONTROL for the two refusals above. Without it, they would also
    // pass against an acceptance function that refuses everything - which is what a
    // broken fix looks like.
    const session = await stage();
    try {
      await session.resetRole();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'newcomer@example.test', now(), '{}')`,
        [NEWCOMER],
      );
      // DAVE can grant the role this invitation names - every permission it carries is
      // one DAVE holds - so this is an invitation a staff manager may legitimately
      // issue. (The fixture's role KEYS are not the ones the registry would use; what
      // matters here is the permission set, and the role id is asserted below.)
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'newcomer@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, ROLE_SETTINGS, TOKEN_HASH, DAVE],
      );

      await becomeWithEmail(session, NEWCOMER, "newcomer@example.test");
      const accepted = await session.query<{ membership: string }>(
        `select private.accept_invitation($1)::text as membership`,
        [TOKEN],
      );
      expect(accepted).toHaveLength(1);

      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships
          where organization_id = $1 and user_id = $2`,
        [ORG_A, NEWCOMER],
      );
      expect(Number(memberships[0]?.n)).toBe(1);

      const assignments = await session.query<{ role_id: string }>(
        `select role_id::text from public.user_role_assignments
          where organization_id = $1 and user_id = $2`,
        [ORG_A, NEWCOMER],
      );
      // The role the invitation named - and only that role.
      expect(assignments.map((a) => a.role_id)).toEqual([ROLE_SETTINGS]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an acceptance addressed to somebody else", async () => {
    // The invitation is for one account. The acceptance compares the stored address
    // with the acceptor's VERIFIED claim, so a bearer of the link who is not that
    // person is refused - which is what makes the stored address mean something, and
    // what stops the owner's roster showing "Pending" for ever.
    const session = await stage();
    try {
      await session.resetRole();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'newcomer@example.test', now(), '{}')`,
        [NEWCOMER],
      );
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'somebody-else@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, ROLE_SETTINGS, TOKEN_HASH, DAVE],
      );

      await becomeWithEmail(session, NEWCOMER, "newcomer@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /sent to a different address/i,
      );

      // And the newcomer is not a member.
      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships where user_id = $1`,
        [NEWCOMER],
      );
      expect(Number(memberships[0]?.n)).toBe(0);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an acceptance whose inviter was not allowed to grant the role", async () => {
    // THE DEFENDER HALF. Even with the UPDATE policy fixed, the acceptance function is
    // a definer and the stored role_id is data - so the ceiling is checked AGAIN, for
    // the inviter, at redemption time. Here the inviter is GRACE, who holds
    // settings.manage, staff.manage and patients.read - and the invitation names the
    // organization_owner role, which she may not grant.
    const session = await stage();
    try {
      await session.resetRole();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'newcomer@example.test', now(), '{}')`,
        [NEWCOMER],
      );
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'newcomer@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, "00000000-0000-4000-8000-000000000006", TOKEN_HASH, GRACE],
      );

      await becomeWithEmail(session, NEWCOMER, "newcomer@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /not allowed to grant/i,
      );

      // And the newcomer is not a member.
      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships where user_id = $1`,
        [NEWCOMER],
      );
      expect(Number(memberships[0]?.n)).toBe(0);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an invitation for the owner role whose inviter is not an owner", async () => {
    // THE OWNER CLAUSE, ISOLATED. The inviter here is DAVE, who holds `org_admin` -
    // whose permission set is byte-identical to the owner's - so the SUBSET rule
    // passes and ONLY the owner clause can refuse. That is what makes this test
    // different from every other refusal in this block: deleting the owner clause
    // from `can_assign_role_for` leaves this one failing and nothing else.
    const session = await stage();
    try {
      await stageOwner(session);
      await session.resetRole();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'newcomer@example.test', now(), '{}')`,
        [NEWCOMER],
      );
      // The invitation is written as the database owner, because a staff manager's
      // own INSERT would be refused by the same clause.
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'newcomer@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, OWNER_ROLE, TOKEN_HASH, DAVE],
      );

      await becomeWithEmail(session, NEWCOMER, "newcomer@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /not allowed to grant/i,
      );

      // And the newcomer is not a member.
      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships where user_id = $1`,
        [NEWCOMER],
      );
      expect(Number(memberships[0]?.n)).toBe(0);

      // POSITIVE CONTROL: the same invitation, issued by a REAL OWNER, is accepted.
      // Without it, the refusal above would also pass against a ceiling that refuses
      // every owner role.
      await session.resetRole();
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'newcomer@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, OWNER_ROLE, TOKEN_TWO_HASH, OWNER],
      );
      await becomeWithEmail(session, NEWCOMER, "newcomer@example.test");
      const accepted = await session.query<{ membership: string }>(
        `select private.accept_invitation($1)::text as membership`,
        [TOKEN_TWO],
      );
      expect(accepted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a redemption by an account whose address is not confirmed", async () => {
    // A CLAIM IS NOT A PROVEN ADDRESS. The claim is authentic, but the address behind
    // it need not be confirmed - and this deployment does not require a confirmation,
    // so anybody could register the invited address and redeem. The acceptance asks
    // the ACCOUNT's own row, and fails closed.
    const session = await stage();
    try {
      await session.resetRole();
      // No `email_confirmed_at`: the account exists, and its address is unproven.
      await session.query(
        `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'unconfirmed@example.test', '{}')`,
        [UNCONFIRMED],
      );
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'unconfirmed@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, ROLE_SETTINGS, TOKEN_HASH, DAVE],
      );

      await becomeWithEmail(session, UNCONFIRMED, "unconfirmed@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /different address/i,
      );

      // And the account gained no membership.
      const memberships = await session.query<{ n: string }>(
        `select count(*)::text as n from public.organization_memberships where user_id = $1`,
        [UNCONFIRMED],
      );
      expect(Number(memberships[0]?.n)).toBe(0);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a suspended member's redemption, and does not spend the invitation", async () => {
    // A SUSPENDED MEMBERSHIP is not something an invitation quietly restores, and the
    // refusal happens BEFORE the acceptance stamp - so the invitation is still
    // redeemable once the membership is active again. Spending it would have left a
    // locked-out member with a spent invitation and an inert assignment.
    const session = await stage();
    try {
      await session.resetRole();
      await session.query(
        `update public.organization_memberships set status = 'suspended'
          where organization_id = $1 and user_id = $2`,
        [ORG_A, ALICE],
      );
      await session.query(
        `insert into public.invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
         values ($1, 'alice@example.test', $2, $3, $4, now() + interval '1 day')`,
        [ORG_A, ROLE_SETTINGS, TOKEN_HASH, DAVE],
      );

      await becomeWithEmail(session, ALICE, "alice@example.test");
      await expectRejection(
        session,
        `select private.accept_invitation($1)`,
        [TOKEN],
        /not active/i,
      );

      // The invitation is NOT spent: `accepted_at` is untouched, so the same link
      // works once the membership is active again. READ AS THE OWNER - the
      // invitations table is readable only by a staff manager.
      await session.resetRole();
      const invitation = await session.query<{ accepted_at: string | null }>(
        `select accepted_at from public.invitations where token_hash = $1`,
        [TOKEN_HASH],
      );
      expect(invitation[0]?.accepted_at).toBeNull();

      // POSITIVE CONTROL: with the membership active again, the same invitation is
      // accepted. Without this, the refusal above would also pass against an
      // invitation that was simply broken.
      await session.resetRole();
      await session.query(
        `update public.organization_memberships set status = 'active'
          where organization_id = $1 and user_id = $2`,
        [ORG_A, ALICE],
      );
      await becomeWithEmail(session, ALICE, "alice@example.test");
      const accepted = await session.query<{ membership: string }>(
        `select private.accept_invitation($1)::text as membership`,
        [TOKEN],
      );
      expect(accepted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});
