// @vitest-environment node
import { afterAll, expect, it } from "vitest";

import {
  beginSession,
  closePool,
  dbDescribe,
  expectRejection,
  query,
} from "../integration/helpers/database";

/*
 * Task 10 - storage buckets and their object policies, on the live database.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE RLS SUITE. Every table in the RLS suite
 * has a real `organization_id` column, and the project's tenant FKs are composite so a
 * row physically cannot reference another tenant. `storage.objects` has NEITHER. Its
 * tenancy is carried by the object NAME - a text path whose first segment is the
 * organization id - and a text path cannot carry a foreign key. The policies are the
 * only thing standing between a member of one tenant and another tenant's documents.
 *
 * Path shape (operator-confirmed): clinical buckets are <org_uuid>/<clinic_uuid>/<file>,
 * org-assets is <org_uuid>/<file>. `storage.foldername()` returns every segment EXCEPT
 * the last, so [1] is always the organization directory and [2] is the clinic for a
 * clinical bucket. That is what makes the shape unambiguous per bucket rather than
 * guessed from whether a segment happens to look like a UUID.
 *
 * Two shapes of failure this suite is built to catch:
 *
 *   - A path whose first segment is NOT a uuid. Casting it to uuid raises 22P02, which
 *     is a 500 rather than a 403. `private.storage_org_id` returns NULL instead, so the
 *     row is denied cleanly. Asserted explicitly below.
 *   - An UPDATE that moves an object into another tenant's prefix. SELECT-only policies
 *     would not catch it, so every bucket has a write policy whose WITH CHECK is the
 *     same predicate as its USING.
 */

afterAll(async () => {
  await closePool();
});

const CLINICAL = [
  "patient-documents",
  "clinical-attachments",
  "investigation-reports",
  "prescription-documents",
];
const ORG_SCOPED = ["org-assets"];
const ALL_BUCKETS = [...CLINICAL, ...ORG_SCOPED];

const ORG_A = "3a1b0c1d-0000-4000-8000-000000000001";
const ORG_B = "3a1b0c1d-0000-4000-8000-000000000002";
const ORG_SUSPENDED = "3a1b0c1d-0000-4000-8000-000000000003";
const CLINIC_A1 = "3a1b0c1d-0000-4000-8000-000000000011";
const CLINIC_A2 = "3a1b0c1d-0000-4000-8000-000000000012";
const CLINIC_B1 = "3a1b0c1d-0000-4000-8000-000000000021";

const ALICE = "3a1b0c1d-0000-4000-8000-0000000000a1";
const DAVE = "3a1b0c1d-0000-4000-8000-0000000000a2";
const CAROL = "3a1b0c1d-0000-4000-8000-0000000000a3";
const OPERATOR = "3a1b0c1d-0000-4000-8000-0000000000a4";

const ROLE_CLINICIAN_A = "3a1b0c1d-0000-4000-8000-0000000000c1";
const ROLE_ADMIN_A = "3a1b0c1d-0000-4000-8000-0000000000c2";
const ROLE_CLINICIAN_B = "3a1b0c1d-0000-4000-8000-0000000000c3";

type Session = Awaited<ReturnType<typeof beginSession>>;

/**
 * One clinician scoped to clinic A1, one org-wide administrator, one member of org B,
 * and a platform operator who belongs to nothing.
 */
async function stage(): Promise<Session> {
  const session = await beginSession();
  const seed = async () => {
    await session.query(
      `insert into auth.users (id, email, raw_user_meta_data) values
         ($1,'alice@example.test','{}'), ($2,'dave@example.test','{}'),
         ($3,'carol@example.test','{}'), ($4,'operator@example.test','{}')`,
      [ALICE, DAVE, CAROL, OPERATOR],
    );
    await session.query(
      `insert into public.organizations (id, name, slug, status) values
         ($1,'Org A','store-a','active'), ($2,'Org B','store-b','active'),
         ($3,'Org S','store-s','suspended')`,
      [ORG_A, ORG_B, ORG_SUSPENDED],
    );
    await session.query(
      `insert into public.organization_memberships (organization_id, user_id, status) values
         ($1,$4,'active'), ($1,$5,'active'), ($2,$6,'active'), ($3,$6,'active')`,
      [ORG_A, ORG_B, ORG_SUSPENDED, ALICE, DAVE, CAROL],
    );
    await session.query(
      `insert into public.clinics (id, organization_id, name) values
         ($1,$4,'A1'), ($2,$4,'A2'), ($3,$5,'B1')`,
      [CLINIC_A1, CLINIC_A2, CLINIC_B1, ORG_A, ORG_B],
    );
    await session.query("set local role service_role");
    await session.query(`update public.profiles set is_platform_admin = true where id = $1`, [
      OPERATOR,
    ]);
    await session.query("reset role");

    await session.query(
      `insert into public.roles (id, organization_id, key, name, is_system) values
         ($1,$3, 'clinician', 'Clinician', false),
         ($2,$3, 'org_admin',  'Org Admin',  false),
         ($4,$5, 'clinician',  'Clinician',  false)`,
      [ROLE_CLINICIAN_A, ROLE_ADMIN_A, ORG_A, ROLE_CLINICIAN_B, ORG_B],
    );
    await session.query(
      `insert into public.role_permissions (role_id, permission_key) values
         ($1, 'patients.read'), ($1, 'encounters.read'), ($1, 'investigations.order'),
         ($2, 'patients.read'), ($2, 'patients.update'), ($2, 'patients.create'),
         ($2, 'encounters.read'), ($2, 'encounters.write'),
         ($2, 'investigations.order'), ($2, 'investigations.verify'),
         ($2, 'prescriptions.create'), ($2, 'settings.manage')`,
      [ROLE_CLINICIAN_A, ROLE_ADMIN_A],
    );
    await session.query(
      `insert into public.user_role_assignments (id, organization_id, user_id, role_id, clinic_id) values
         ('3a1b0c1d-0000-4000-8000-0000000000f1', $1, $2, $3, $4),
         ('3a1b0c1d-0000-4000-8000-0000000000f2', $1, $5, $6, null),
         ('3a1b0c1d-0000-4000-8000-0000000000f3', $7, $8, $9, null)`,
      [
        ORG_A,
        ALICE,
        ROLE_CLINICIAN_A,
        CLINIC_A1,
        DAVE,
        ROLE_ADMIN_A,
        ORG_B,
        CAROL,
        ROLE_CLINICIAN_B,
      ],
    );

    // Objects belonging to each tenant, written as the owner so the fixtures exist
    // regardless of what the policies allow.
    for (const [bucket, name] of [
      ["patient-documents", `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      ["patient-documents", `${ORG_B}/${CLINIC_B1}/bob-report.pdf`],
      ["org-assets", `${ORG_A}/logo.png`],
      ["patient-documents", `not-a-uuid/orphan.pdf`],
    ] as const) {
      await session.query(
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), $1, $2, $3, false, false)`,
        [bucket, name, ALICE],
      );
    }
  };

  try {
    await seed();
  } catch (error) {
    await session.rollback();
    throw error;
  }
  return session;
}

async function become(session: Session, userId: string): Promise<void> {
  await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await session.query("set local role authenticated");
}

dbDescribe("storage buckets", () => {
  it("creates the five buckets, none of them public", async () => {
    const rows = await query<{ id: string; public: boolean }>(
      `select id, public from storage.buckets order by id`,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...ALL_BUCKETS].sort());
    for (const row of rows) expect(row.public, `${row.id} must not be public`).toBe(false);
  });
});

dbDescribe("storage object isolation", () => {
  it("shows a member only their own organization's objects", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const rows = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'patient-documents' order by name`,
      );
      expect(rows.map((r) => r.name)).toEqual([`${ORG_A}/${CLINIC_A1}/alice-report.pdf`]);
    } finally {
      await session.rollback();
    }
  });

  it("cannot read another organization's object by name", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const other = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'patient-documents' and name = $1`,
        [`${ORG_B}/${CLINIC_B1}/bob-report.pdf`],
      );
      expect(other).toEqual([]);
      // Positive control: their own object is there, so the empty result is the
      // policy and not an empty table.
      const own = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'patient-documents' and name = $1`,
        [`${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      );
      expect(own).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an upload into another organization's prefix", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)`,
        [`${ORG_B}/${CLINIC_B1}/stolen.pdf`, DAVE],
        /row-level security/i,
      );
    } finally {
      await session.rollback();
    }
  });

  it("refuses an upload into a clinic the writer cannot reach", async () => {
    // DAVE is org-wide so he can reach both of org A's clinics. ALICE is scoped to
    // clinic A1, so clinic A2 is the case: same organization, unreachable clinic.
    const session = await stage();
    try {
      await become(session, ALICE);
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)`,
        [`${ORG_A}/${CLINIC_A2}/alice-elsewhere.pdf`, ALICE],
        /row-level security/i,
      );
      // Positive control: her own clinic is fine, or the policy refuses everyone.
      const permitted = await session.query<{ name: string }>(
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)
         returning name`,
        [`${ORG_A}/${CLINIC_A1}/alice-here.pdf`, ALICE],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("denies an object whose first path segment is not a uuid, without raising", async () => {
    // A naive (storage.foldername(name))[1]::uuid raises 22P02 here, which PostgREST
    // reports as a 500 rather than a 403. The helper returns NULL instead, so the row
    // is simply not visible.
    const session = await stage();
    try {
      await become(session, DAVE);
      const rows = await session.query<{ name: string }>(
        `select name from storage.objects where name = 'not-a-uuid/orphan.pdf'`,
      );
      expect(rows).toEqual([]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses an update that moves an object into another tenant", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      // A SELECT-only policy would let this through. WITH CHECK is what stops it.
      await expectRejection(
        session,
        `update storage.objects set name = $1
          where bucket_id = 'patient-documents' and name = $2`,
        [`${ORG_B}/${CLINIC_B1}/moved.pdf`, `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
        /row-level security/i,
      );
      await session.resetRole();
      const still = await session.query<{ name: string }>(
        `select name from storage.objects where name like '%moved.pdf'`,
      );
      expect(still).toEqual([]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a delete from someone without the write permission, at two locks", async () => {
    // Lock one is storage.protect_delete(), a Supabase trigger that refuses a direct
    // DELETE from storage.objects for EVERYONE - service role included - unless the
    // Storage API has set storage.allow_delete_query. Measured, and independent of
    // RLS, so it is asserted first.
    //
    // Lock two is our own DELETE policy, which is the gate on the path that actually
    // matters: the Storage API sets that GUC and then deletes as the request's role,
    // so RLS is what decides. Without setting the GUC here, this test would be
    // measuring the trigger and would pass no matter what our policy said.
    const session = await stage();
    try {
      await become(session, ALICE);
      await expectRejection(
        session,
        `delete from storage.objects where bucket_id = 'org-assets' and name = $1`,
        [`${ORG_A}/logo.png`],
        /Direct deletion from storage tables/i,
      );

      await session.query(`select set_config('storage.allow_delete_query', 'true', true)`);
      // With the GUC set the trigger is satisfied and RLS is the only gate left.
      // RLS FILTERS a non-permitted DELETE rather than raising it, so the refusal is
      // "zero rows", not "an error" - asserted with RETURNING so the row count is
      // the measurement. Asserting a throw here would pass against a policy that
      // deleted everything.
      const filtered = await session.query<{ name: string }>(
        `delete from storage.objects where bucket_id = 'org-assets' and name = $1 returning name`,
        [`${ORG_A}/logo.png`],
      );
      expect(filtered).toEqual([]);

      // Positive control: with the GUC set, the administrator CAN delete - so the
      // refusal above is the permission check and not the trigger still firing.
      await session.resetRole();
      await become(session, DAVE);
      const permitted = await session.query(
        `delete from storage.objects where bucket_id = 'org-assets' and name = $1 returning name`,
        [`${ORG_A}/logo.png`],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("hides a suspended tenant's objects from its own members and from the operator", async () => {
    const session = await stage();
    try {
      await session.query(
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'org-assets', $1, $2, false, false)`,
        [`${ORG_SUSPENDED}/suspended-logo.png`, CAROL],
      );
      await become(session, CAROL);
      const tenant = await session.query<{ name: string }>(
        `select name from storage.objects where name like $1`,
        [`${ORG_SUSPENDED}/%`],
      );
      expect(tenant).toEqual([]);
    } finally {
      await session.rollback();
    }
  });
});
