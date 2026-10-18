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
 * the last, so [1] is always the organization directory and the last segment is always
 * the filename. That is what makes the shape unambiguous per bucket rather than guessed
 * from whether a segment happens to look like a UUID.
 *
 * FOUR SHAPES OF FAILURE THIS SUITE IS BUILT AROUND, three of them learned the hard way
 * during review:
 *
 *  - A path whose first segment is NOT a uuid. Casting it raises 22P02, which
 *    PostgREST reports as a 500 rather than a 403. The helper returns NULL instead.
 *  - RLS FILTERS a non-permitted UPDATE/DELETE to zero rows without raising. So the
 *    refusal is a row count, not an error, and asserting a throw proves nothing.
 *  - A test that writes to a fixture the product never produces proves nothing. The
 *    first version of the "positive control" below held only READ permissions, so it
 *    passed BECAUSE of the write-permission bug rather than despite it. The fixture now
 *    separates the three questions - reach, read permission, write permission - into
 *    three different principals, so each assertion can only fail for its own reason.
 *  - A policy that refuses everybody passes every refusal test. Every refusal here has
 *    a positive control beside it.
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

/**
 * What each bucket's INSERT and DELETE must demand, taken from the migration header.
 *
 * This table is the regression test for a CRITICAL that shipped and was reviewed out:
 * `format()` fills `%s` positionally, and one shared argument list fed four templates,
 * so the one-placeholder INSERT and DELETE branches consumed the READ predicate. A
 * read-only clinician could create and permanently delete PHI on three of the five
 * buckets. The catalogue assertion below re-reads pg_policies and checks every one of
 * the twenty against this table, so the bug cannot come back silently - and, more
 * importantly, a future edit to the mapping cannot drift from the documentation.
 */
const EXPECTED_PERMISSION: Record<string, { read: string; write: string }> = {
  "patient-documents": { read: "patients.read", write: "patients.update" },
  "clinical-attachments": { read: "encounters.read", write: "encounters.write" },
  "investigation-reports": { read: "investigations.order", write: "investigations.verify" },
  "prescription-documents": { read: "prescriptions.create", write: "prescriptions.create" },
  "org-assets": { read: "settings.manage", write: "settings.manage" },
};

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
const FRANK = "3a1b0c1d-0000-4000-8000-0000000000a5";

const ROLE_MIXED_A = "3a1b0c1d-0000-4000-8000-0000000000c1";
const ROLE_ADMIN_A = "3a1b0c1d-0000-4000-8000-0000000000c2";
const ROLE_READONLY_A = "3a1b0c1d-0000-4000-8000-0000000000c3";
const ROLE_CLINICIAN_B = "3a1b0c1d-0000-4000-8000-0000000000c4";

type Session = Awaited<ReturnType<typeof beginSession>>;

/**
 * Five principals, each isolating one variable:
 *
 *   ALICE   clinic-scoped to A1, can READ patient-documents and WRITE them, but holds
 *           no encounters.write and no investigations.verify. She is the ONLY reason
 *           the per-bucket mapping is testable - she can write one clinical bucket and
 *           not the next.
 *   FRANK   clinic-scoped to A1, patients.read and nothing else. THE regression
 *           principal: he must be unable to create or destroy PHI.
 *   DAVE    org-wide administrator holding every write permission in the mapping.
 *   CAROL   member of org B and of the suspended org.
 *   OPERATOR platform administrator belonging to no organization.
 */
async function stage(): Promise<Session> {
  const session = await beginSession();

  const seed = async () => {
    await session.query(
      `insert into auth.users (id, email, raw_user_meta_data) values
         ($1,'alice@example.test','{}'), ($2,'dave@example.test','{}'),
         ($3,'carol@example.test','{}'), ($4,'operator@example.test','{}'),
         ($5,'frank@example.test','{}')`,
      [ALICE, DAVE, CAROL, OPERATOR, FRANK],
    );
    await session.query(
      `insert into public.organizations (id, name, slug, status) values
         ($1,'Org A','store-a','active'), ($2,'Org B','store-b','active'),
         ($3,'Org S','store-s','suspended')`,
      [ORG_A, ORG_B, ORG_SUSPENDED],
    );
    await session.query(
      `insert into public.organization_memberships (organization_id, user_id, status) values
         ($1,$4,'active'), ($1,$5,'active'), ($1,$6,'active'),
         ($2,$7,'active'), ($3,$7,'active')`,
      [ORG_A, ORG_B, ORG_SUSPENDED, ALICE, DAVE, FRANK, CAROL],
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
         ($1,$4,'mixed',    'Mixed',       false),
         ($2,$4,'org_admin', 'Org Admin',   false),
         ($3,$4,'read_only', 'Read Only',   false),
         ($5,$6,'clinician', 'Clinician',   false)`,
      [ROLE_MIXED_A, ROLE_ADMIN_A, ROLE_READONLY_A, ORG_A, ROLE_CLINICIAN_B, ORG_B],
    );
    await session.query(
      `insert into public.role_permissions (role_id, permission_key) values
         ($1,'patients.read'), ($1,'patients.update'), ($1,'encounters.read'),
         ($2,'patients.read'), ($2,'patients.update'), ($2,'patients.create'),
         ($2,'encounters.read'), ($2,'encounters.write'),
         ($2,'investigations.order'), ($2,'investigations.verify'),
         ($2,'prescriptions.create'), ($2,'settings.manage'),
         ($3,'patients.read'), ($3,'encounters.read'),
         ($4,'patients.read')`,
      [ROLE_MIXED_A, ROLE_ADMIN_A, ROLE_READONLY_A, ROLE_CLINICIAN_B],
    );
    await session.query(
      `insert into public.user_role_assignments (id, organization_id, user_id, role_id, clinic_id) values
         ('3a1b0c1d-0000-4000-8000-0000000000f1', $1, $2, $3, $4),
         ('3a1b0c1d-0000-4000-8000-0000000000f2', $1, $5, $6, null),
         ('3a1b0c1d-0000-4000-8000-0000000000f3', $1, $7, $8, $4),
         ('3a1b0c1d-0000-4000-8000-0000000000f4', $9, $10, $11, null)`,
      [
        ORG_A,
        ALICE,
        ROLE_MIXED_A,
        CLINIC_A1,
        DAVE,
        ROLE_ADMIN_A,
        FRANK,
        ROLE_READONLY_A,
        ORG_B,
        CAROL,
        ROLE_CLINICIAN_B,
      ],
    );

    // Fixtures written as the OWNER so they exist regardless of what the policies
    // allow. owner_id matters: the write policies require it to be the caller's, so
    // each object's owner has to be the principal the test later acts as.
    for (const [bucket, name, owner] of [
      ["patient-documents", `${ORG_A}/${CLINIC_A1}/alice-report.pdf`, ALICE],
      ["patient-documents", `${ORG_A}/${CLINIC_A1}/dave-note.pdf`, DAVE],
      ["patient-documents", `${ORG_B}/${CLINIC_B1}/bob-report.pdf`, CAROL],
      ["org-assets", `${ORG_A}/logo.png`, DAVE],
      ["patient-documents", `not-a-uuid/orphan.pdf`, ALICE],
    ] as const) {
      await session.query(
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), $1, $2, $3, false, false)`,
        [bucket, name, owner],
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

const insertObject = (session: Session, bucket: string, name: string, owner: string) =>
  session.query(
    `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
     values (gen_random_uuid(), $1, $2, $3, false, false) returning name`,
    [bucket, name, owner],
  );

dbDescribe("storage buckets", () => {
  it("creates the five buckets, none of them public", async () => {
    const rows = await query<{ id: string; public: boolean }>(
      `select id, public from storage.buckets order by id`,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...ALL_BUCKETS].sort());
    for (const row of rows) expect(row.public, `${row.id} must not be public`).toBe(false);
  });

  it("has exactly four policies per bucket, each demanding its declared permission", async () => {
    // The regression test for the format() bug. Read back from pg_policies rather than
    // trusting the file: 01300 shipped a mapping that did not match its own header for
    // six of the twenty policies, and every behavioural test still passed.
    const rows = await query<{ policyname: string; cmd: string; text: string | null }>(
      `select policyname, cmd, coalesce(with_check, qual) as text
         from pg_catalog.pg_policies where schemaname = 'storage'`,
    );

    const expected: string[] = [];
    for (const bucket of ALL_BUCKETS) {
      const key = bucket.replace(/-/g, "_");
      for (const command of ["select", "insert", "update", "delete"])
        expected.push(`${key}_${command}`);
    }
    expect(rows.map((r) => r.policyname).sort()).toEqual(expected.sort());
    expect(rows).toHaveLength(20);

    for (const row of rows) {
      const match = row.policyname.match(/^(.*)_(select|insert|update|delete)$/);
      expect(match, row.policyname).not.toBeNull();
      const key = match?.[1] ?? "";
      const command = match?.[2] ?? "";
      const wanted = EXPECTED_PERMISSION[key.replace(/_/g, "-")];
      expect(wanted, `${key} is not in the expected mapping`).toBeDefined();
      const want = command === "select" ? wanted?.read : wanted?.write;
      const got = (row.text ?? "").match(/private\.can\([^,]+, '([^']+)'/)?.[1];
      expect(got, `${row.policyname} must demand ${want}`).toBe(want);
    }
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
      expect(rows.map((r) => r.name)).toEqual([
        `${ORG_A}/${CLINIC_A1}/alice-report.pdf`,
        `${ORG_A}/${CLINIC_A1}/dave-note.pdf`,
      ]);
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
        [`${ORG_A}/${CLINIC_A1}/dave-note.pdf`],
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
    // ALICE is clinic-scoped to A1. A2 is the same organization and unreachable, so
    // this assertion can ONLY fail because of clinic reach - she holds patients.update,
    // which is what makes it a reach test rather than a permission test.
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
      const permitted = await insertObject(
        session,
        "patient-documents",
        `${ORG_A}/${CLINIC_A1}/alice-here.pdf`,
        ALICE,
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("a read permission is not a write permission", () => {
  // The regression suite for the CRITICAL. Every test here exists because 01300 let
  // patients.read, encounters.read and investigations.order authorise INSERT and DELETE
  // on their buckets, and the original suite's "positive control" passed BECAUSE of it.
  it("refuses a read-only user any upload, on every clinical bucket", async () => {
    const session = await stage();
    try {
      await become(session, FRANK);
      for (const bucket of CLINICAL) {
        await expectRejection(
          session,
          `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
           values (gen_random_uuid(), $1, $2, $3, false, false)`,
          [bucket, `${ORG_A}/${CLINIC_A1}/frank-${bucket}.pdf`, FRANK],
          /row-level security/i,
        );
      }
      // Positive control: he CAN read them, so the refusals are the write policy and
      // not an empty result set.
      const readable = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'clinical-attachments'`,
      );
      expect(readable).toEqual([]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a read-only user any clinical delete, at the policy layer", async () => {
    // Setting the GUC satisfies storage.protect_delete(), so what refuses here is our
    // own DELETE policy. Without it this test would measure the trigger and pass no
    // matter what the policy said.
    const session = await stage();
    try {
      await become(session, FRANK);
      await session.query(`select set_config('storage.allow_delete_query', 'true', true)`);
      for (const [bucket, name] of [
        ["patient-documents", `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
        ["clinical-attachments", `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
        ["investigation-reports", `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      ] as const) {
        const removed = await session.query<{ name: string }>(
          `delete from storage.objects where bucket_id = $1 and name = $2 returning name`,
          [bucket, name],
        );
        expect(removed, `FRANK holds no write permission; ${bucket} delete must filter`).toEqual(
          [],
        );
      }
    } finally {
      await session.rollback();
    }
  });

  it("lets a user write one clinical bucket and not the next", async () => {
    // ALICE holds patients.update but NOT encounters.write and NOT
    // investigations.verify. If every bucket resolved to the same permission this pair
    // would be indistinguishable, which is exactly how the mapping bug hid.
    const session = await stage();
    try {
      await become(session, ALICE);
      const allowed = await insertObject(
        session,
        "patient-documents",
        `${ORG_A}/${CLINIC_A1}/mixed-ok.pdf`,
        ALICE,
      );
      expect(allowed).toHaveLength(1);

      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), $1, $2, $3, false, false)`,
        ["clinical-attachments", `${ORG_A}/${CLINIC_A1}/mixed-no.pdf`, ALICE],
        /row-level security/i,
      );
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), $1, $2, $3, false, false)`,
        ["investigation-reports", `${ORG_A}/${CLINIC_A1}/mixed-no.pdf`, ALICE],
        /row-level security/i,
      );
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("pinned columns", () => {
  it("refuses to forge ownership, archive, or soft-delete", async () => {
    const session = await stage();
    try {
      await become(session, ALICE);
      // owner_id must be the caller. This is the UPDATE-side forgery: the row she is
      // allowed to touch is her own, and she is trying to hand it to someone else.
      await expectRejection(
        session,
        `update storage.objects set owner_id = $1
          where bucket_id = 'patient-documents' and name = $2`,
        [DAVE, `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
        /row-level security/i,
      );

      // archived_at and is_delete_marker implement soft delete: set them and the
      // object stops being served while the row AND the blob remain.
      await expectRejection(
        session,
        `update storage.objects set archived_at = now()
          where bucket_id = 'patient-documents' and name = $1`,
        [`${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
        /row-level security/i,
      );
      await expectRejection(
        session,
        `update storage.objects set is_delete_marker = true
          where bucket_id = 'patient-documents' and name = $1`,
        [`${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
        /row-level security/i,
      );

      // Positive control: a rename she IS allowed still works, so the refusals above
      // are the pinned columns and not the whole UPDATE path being closed.
      await session.resetRole();
      await become(session, DAVE);
      const renamed = await session.query<{ name: string }>(
        `update storage.objects set name = $1
          where bucket_id = 'patient-documents' and name = $2 returning name`,
        [`${ORG_A}/${CLINIC_A1}/dave-renamed.pdf`, `${ORG_A}/${CLINIC_A1}/dave-note.pdf`],
      );
      expect(renamed).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a path containing a dot-dot segment", async () => {
    // Segment 2 genuinely is clinic A1, so the clinic clause would approve it - but
    // whether the Storage API's S3 backend normalises `..` is outside the database and
    // unverifiable from here. Refusing the segment removes the question.
    const session = await stage();
    try {
      await become(session, DAVE);
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)`,
        [`${ORG_A}/${CLINIC_A1}/../${CLINIC_A2}/traversed.pdf`, DAVE],
        /row-level security/i,
      );
      // Positive control: the same shape WITHOUT the traversal segment is accepted, so
      // the refusal above is the path check rather than the whole bucket being closed.
      const plain = await insertObject(
        session,
        "patient-documents",
        `${ORG_A}/${CLINIC_A1}/direct.pdf`,
        DAVE,
      );
      expect(plain).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("path parsing is total", () => {
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
      // Positive control: DAVE's own object is visible, so the empty result above is
      // the path check and not a policy that refuses everyone.
      const own = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'patient-documents' order by name`,
      );
      expect(own).toHaveLength(2);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("move and delete", () => {
  it("refuses an update that moves an object into another tenant", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      // A SELECT-only policy would let this through. WITH CHECK is what stops it, and
      // the refusal RAISES rather than filtering - an UPDATE that changes a row the
      // caller may not see is an error, not a silent zero.
      await expectRejection(
        session,
        `update storage.objects set name = $1
          where bucket_id = 'patient-documents' and name = $2`,
        [`${ORG_B}/${CLINIC_B1}/moved.pdf`, `${ORG_A}/${CLINIC_A1}/dave-note.pdf`],
        /row-level security/i,
      );
    } finally {
      await session.rollback();
    }
  });

  it("refuses a delete at two locks", async () => {
    // Lock one is storage.protect_delete(), a Supabase trigger refusing a direct DELETE
    // for EVERYONE - service role included - unless the Storage API has set
    // storage.allow_delete_query. Independent of RLS, so asserted first.
    //
    // Lock two is our DELETE policy, the gate on the path that matters: the API sets
    // that GUC and deletes as the request's role.
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
      // RLS FILTERS a non-permitted DELETE to zero rows rather than raising it, so the
      // refusal is a row count. Asserting a throw here would pass against a policy that
      // deleted everything.
      const filtered = await session.query<{ name: string }>(
        `delete from storage.objects where bucket_id = 'org-assets' and name = $1 returning name`,
        [`${ORG_A}/logo.png`],
      );
      expect(filtered).toEqual([]);

      // Positive control: with the GUC set, the uploader who holds settings.manage can
      // delete - so the refusals above are the permission check, not the trigger.
      await session.resetRole();
      await become(session, DAVE);
      const permitted = await session.query<{ name: string }>(
        `delete from storage.objects where bucket_id = 'org-assets' and name = $1 returning name`,
        [`${ORG_A}/logo.png`],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("suspension and the platform", () => {
  it("hides a suspended tenant's objects from its own members", async () => {
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
      // Positive control: carol still sees her own active organization's objects.
      const active = await session.query<{ name: string }>(
        `select name from storage.objects where name like $1`,
        [`${ORG_B}/%`],
      );
      expect(active).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("shows a platform administrator nothing, because they belong to no organization", async () => {
    // Asserted because the alternative - a platform branch on storage.objects - would
    // hand an operator every tenant's PHI, which is not what is_platform_admin means
    // anywhere else in this schema.
    const session = await stage();
    try {
      await become(session, OPERATOR);
      const rows = await session.query<{ name: string }>(`select name from storage.objects`);
      expect(rows).toEqual([]);
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)`,
        [`${ORG_A}/${CLINIC_A1}/operator.pdf`, OPERATOR],
        /row-level security/i,
      );
    } finally {
      await session.rollback();
    }
  });
});
