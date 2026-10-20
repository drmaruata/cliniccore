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

/**
 * The bucket-level file-type allowlist. `metadata` is deliberately UNPINNED in the
 * write predicates - the Storage API writes it server-side during upload as the
 * request's role, so a pin rejecting it would fail every legitimate upload. That makes
 * this list the ONLY control on the mimetype a write-permission holder can declare, and
 * a control nothing asserted is a control that can be deleted silently.
 */
const EXPECTED_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/dicom",
  "text/plain",
];

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
const GRACE = "3a1b0c1d-0000-4000-8000-0000000000a6";

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
         ($5,'frank@example.test','{}'), ($6,'grace@example.test','{}')`,
      [ALICE, DAVE, CAROL, OPERATOR, FRANK, GRACE],
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
    // GRACE is the principal ALICE cannot be. ALICE's ROLE ASSIGNMENT is clinic-scoped,
    // so `can()` alone already refuses a clinic she was not granted - which means no
    // test could tell whether the `clinic_ids` reach clause was doing any work.
    //
    // GRACE's assignment is ORG-WIDE, so `can()` returns true for every clinic in the
    // organization. Her REACH is narrowed instead by a clinic_memberships row. Only the
    // reach clause can refuse her, so she is what pins the third conjunct - on SELECT,
    // INSERT, UPDATE and DELETE alike. This is Task 9's "pin each clause separately"
    // lesson; the third review found DELETE had never had it.
    const [graceMembership] = await session.query<{ id: string }>(
      `insert into public.organization_memberships (organization_id, user_id, status)
       values ($1, $2, 'active') returning id`,
      [ORG_A, GRACE],
    );
    await session.query(
      `insert into public.clinics (id, organization_id, name) values
         ($1,$4,'A1'), ($2,$4,'A2'), ($3,$5,'B1')`,
      [CLINIC_A1, CLINIC_A2, CLINIC_B1, ORG_A, ORG_B],
    );
    // After `clinics`, because clinic_memberships carries a composite FK to it.
    await session.query(
      `insert into public.clinic_memberships (id, organization_id, membership_id, clinic_id)
       values (gen_random_uuid(), $1, $2, $3)`,
      [ORG_A, graceMembership?.id, CLINIC_A1],
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
         ('3a1b0c1d-0000-4000-8000-0000000000f4', $9, $10, $11, null),
         ('3a1b0c1d-0000-4000-8000-0000000000f5', $1, $12, $6, null)`,
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
        GRACE,
      ],
    );

    // Fixtures written as the OWNER so they exist regardless of what the policies
    // allow. owner_id matters: the write policies require it to be the caller's, so
    // each object's owner has to be the principal the test later acts as.
    for (const [bucket, name, owner] of [
      ["patient-documents", `${ORG_A}/${CLINIC_A1}/alice-report.pdf`, ALICE],
      ["patient-documents", `${ORG_A}/${CLINIC_A1}/dave-note.pdf`, DAVE],
      ["patient-documents", `${ORG_A}/${CLINIC_A2}/alice-clinic2.pdf`, ALICE],
      ["patient-documents", `${ORG_B}/${CLINIC_B1}/bob-report.pdf`, CAROL],
      // clinical-attachments and investigation-reports need their OWN rows. The
      // re-review found a "positive control" that asserted clinical-attachments was
      // EMPTY - which is true for every principal, permitted or not, because the
      // fixture seeded none. A control whose expected value is identical whether the
      // policy is present or deleted cannot distinguish anything.
      ["clinical-attachments", `${ORG_A}/${CLINIC_A1}/alice-note.txt`, ALICE],
      ["clinical-attachments", `${ORG_A}/${CLINIC_A1}/dave-note.txt`, DAVE],
      ["investigation-reports", `${ORG_A}/${CLINIC_A1}/alice-report.dcm`, ALICE],
      ["prescription-documents", `${ORG_A}/${CLINIC_A1}/alice-rx.pdf`, ALICE],
      ["org-assets", `${ORG_A}/logo.png`, DAVE],
      ["patient-documents", `not-a-uuid/orphan.pdf`, ALICE],
      // FRANK must OWN objects, or his DELETE and UPDATE refusals prove nothing: the
      // owner clause would filter the row first, so a policy with the permission check
      // REMOVED would behave identically to a correct one. Measured - with no
      // FRANK-owned rows, stripping `can()` from the clinical DELETE policies left all
      // 17 tests green. He owns these so the permission clause is the only possible
      // reason a write is refused.
      ["patient-documents", `${ORG_A}/${CLINIC_A1}/frank-report.pdf`, FRANK],
      ["clinical-attachments", `${ORG_A}/${CLINIC_A1}/frank-note.txt`, FRANK],
      ["org-assets", `${ORG_A}/frank-logo.png`, FRANK],
      // An object whose NAME carries a traversal segment, written as the owner so it
      // exists regardless of policy. The segment is THREE dots, not two, on purpose:
      // the superseded guard accepted `...` and `....`, and the current one refuses any
      // all-dots segment. Seeding a literal `..` would have been caught by BOTH guards,
      // so the assertion would have passed against the guard it exists to defend.
      ["org-assets", `${ORG_A}/${CLINIC_A1}/.../seeded.png`, DAVE],
    ] as const) {
      await session.query(
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), $1, $2, $3, false, false)`,
        [bucket, name, owner],
      );
    }

    // An object the SERVICE ROLE has archived. Only service_role can produce this state,
    // which is the point: the pinned archived_at means no authenticated principal can
    // then delete it, and that trade-off needs asserting rather than assuming.
    await session.query(
      `insert into storage.objects
         (id, bucket_id, name, owner_id, archived_at, is_delete_marker, is_versioned)
       values (gen_random_uuid(), 'patient-documents', $1, $2, now(), false, false)`,
      [`${ORG_A}/${CLINIC_A1}/dave-archived.pdf`, DAVE],
    );
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
      // EVERY permission the policy demands, not just the first. The delete policies now
      // demand the bucket write permission AND, as the administrative alternative,
      // settings.manage - so taking the first match would assert the wrong thing.
      const demanded = [...(row.text ?? "").matchAll(/private\.can\([^,]+, '([^']+)'/g)].map(
        (match) => match[1],
      );
      expect(demanded, `${row.policyname} must demand ${want}`).toContain(want);
      // The bucket_id literal inside the predicate is what stops one bucket's policy
      // matching another bucket's rows. Asserting it here covers all twenty policies
      // in one place, where before it was pinned for two buckets by one behavioural
      // test.
      expect(row.text ?? "", `${row.policyname} must pin its own bucket_id`).toContain(
        `bucket_id = '${key.replace(/_/g, "-")}'`,
      );
      // The clinic-reach conjunct: present on every clinical policy, absent from
      // org-assets, which is organization-scoped and has no clinic segment to check.
      //
      // This is a TEXT assertion and it is here because the behavioural version did not
      // hold. MEASURED: deleting the conjunct from patient_documents_delete left all 23
      // tests green. The behavioural test for it is still present and still worth
      // having, but a clause whose removal the suite cannot distinguish from correct is
      // exactly what a catalogue assertion is for. Asserting the ABSENCE for org-assets
      // too, so this cannot be satisfied by adding the conjunct everywhere.
      const wantsClinicReach = key !== "org_assets";
      expect(
        /clinic_ids/.test(row.text ?? ""),
        `${row.policyname} ${wantsClinicReach ? "must" : "must not"} gate on clinic reach`,
      ).toBe(wantsClinicReach);
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
        `${ORG_A}/${CLINIC_A1}/dave-archived.pdf`,
        `${ORG_A}/${CLINIC_A1}/dave-note.pdf`,
        `${ORG_A}/${CLINIC_A1}/frank-report.pdf`,
        `${ORG_A}/${CLINIC_A2}/alice-clinic2.pdf`,
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
      // Positive control: the same shape into his OWN organization is accepted. A
      // refusal and an ABSENT policy raise the identical message, so without this the
      // assertion above would also pass against a deleted insert policy.
      const permitted = await insertObject(
        session,
        "patient-documents",
        `${ORG_A}/${CLINIC_A1}/dave-new.pdf`,
        DAVE,
      );
      expect(permitted).toHaveLength(1);
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
      // Positive control: ALICE holds encounters.read and the fixture seeds real
      // clinical-attachments rows, so she CAN read them. The previous version of this
      // control asserted the bucket was EMPTY, which is true for every principal
      // including one with the policy deleted - and so proved nothing at all.
      await session.resetRole();
      await become(session, ALICE);
      const readable = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'clinical-attachments' order by name`,
      );
      expect(readable.map((r) => r.name)).toEqual([
        `${ORG_A}/${CLINIC_A1}/alice-note.txt`,
        `${ORG_A}/${CLINIC_A1}/dave-note.txt`,
        `${ORG_A}/${CLINIC_A1}/frank-note.txt`,
      ]);
      // And FRANK, who holds encounters.read too, is refused the same writes - so the
      // refusals above are the write policy rather than an empty bucket.
      await session.resetRole();
      await become(session, FRANK);
      const frankReads = await session.query<{ n: string }>(
        `select count(*)::text as n from storage.objects where bucket_id = 'clinical-attachments'`,
      );
      expect(Number(frankReads[0]?.n)).toBe(3);
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
      // Every clinical bucket, keyed on owner_id rather than name so the assertion is
      // about the PERMISSION and not about whether a particular fixture row happens to
      // exist - that confound is what made the first version of this test vacuous.
      for (const bucket of CLINICAL) {
        const removed = await session.query<{ name: string }>(
          `delete from storage.objects where bucket_id = $1 and owner_id = $2 returning name`,
          [bucket, FRANK],
        );
        expect(removed, `FRANK holds no write permission; ${bucket} delete must filter`).toEqual(
          [],
        );
      }

      // Positive control, and the thing that makes the refusals above mean something: a
      // refusal-only DELETE assertion is indistinguishable from an ABSENT policy, since
      // both filter to zero rows. ALICE holds patients.update and owns this object, so
      // she must be able to delete it. Without this, deleting all four clinical DELETE
      // policies would leave this test green.
      await session.resetRole();
      await become(session, ALICE);
      const permitted = await session.query<{ name: string }>(
        `delete from storage.objects where bucket_id = 'patient-documents' and name = $1 returning name`,
        [`${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      );
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a clinical delete across clinics, which the reach clause exists for", async () => {
    // Task 9's lesson - pin each clause of the conjunction separately - was not applied
    // to DELETE. Drop the clinic_ids conjunct from all four clinical DELETE predicates
    // and the suite still passed, because FRANK holds no write permission at all, so
    // the clause was irrelevant to him. ALICE holds patients.update in clinic A1 only.
    const session = await stage();
    try {
      await become(session, ALICE);
      await session.query(`select set_config('storage.allow_delete_query', 'true', true)`);
      const sameClinic = await session.query<{ name: string }>(
        `delete from storage.objects
          where bucket_id = 'patient-documents' and name = $1 returning name`,
        [`${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      );
      expect(sameClinic).toHaveLength(1);

      const otherClinic = await session.query<{ name: string }>(
        `delete from storage.objects
          where bucket_id = 'patient-documents' and name = $1 returning name`,
        [`${ORG_A}/${CLINIC_A2}/alice-clinic2.pdf`],
      );
      expect(otherClinic).toEqual([]);
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
      // Named rather than counted: a bare "nonzero" assertion cannot tell a working
      // policy from one that has been quietly widened, and adding a fixture row would
      // otherwise force this number to be edited rather than reasoned about.
      expect(own.map((r) => r.name)).toContain(`${ORG_A}/${CLINIC_A1}/alice-report.pdf`);
      expect(own.map((r) => r.name)).not.toContain("not-a-uuid/orphan.pdf");
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
      // Positive control that also pins org_assets_select: carol still sees her own
      // active organization's objects, so the empty result above is the suspension and
      // not a policy that shows nobody anything.
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
      // Positive control FIRST, as DAVE, so the deny-all below cannot be satisfied by
      // an absent policy set - which would make it assert nothing at all.
      await session.resetRole();
      await become(session, DAVE);
      const visible = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'patient-documents' order by name`,
      );
      expect(visible.length).toBeGreaterThan(0);

      await session.resetRole();
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

dbDescribe("ownership is load-bearing, and an administrator may clean up after a departure", () => {
  // Operator-confirmed trade-off, and the third review found it defended by nothing:
  // stripping the owner clauses from every INSERT and DELETE policy left all 17 tests
  // green, because the fixture's other principals owned nothing of each other's.
  it("refuses an administrator any write to another user's object", async () => {
    const session = await stage();
    try {
      await session.query(`select set_config('storage.allow_delete_query', 'true', true)`);
      // DAVE holds every write permission in the mapping and is org-wide, so the owner
      // clause is the only thing that can refuse him.
      await become(session, DAVE);

      // DAVE holds ROLE_ADMIN_A, which includes settings.manage, so he is an ADMINISTRATOR
      // and may now delete another user's object. The decision changed in Task 13: under
      // uploader-only ownership, a clinician who LEFT left their documents undeletable by
      // anyone - the uploader had gone and no other role could satisfy the ownership
      // clause. For a PHI system that may have to erase a patient's documents on request,
      // "nobody can delete this" is the worst available answer.
      const removed = await session.query<{ name: string }>(
        `delete from storage.objects
          where bucket_id = 'patient-documents' and name = $1 returning name`,
        [`${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      );
      expect(removed.length).toBe(1);

      // And the deletion is a TRAIL event. C4: a document removed through the Storage
      // API - which is how the browser removes one - used to leave no record in the
      // project's own audit log, and the table carries no foreign keys, so nothing else
      // would have recorded it either.
      // Read the trail as service_role. The audit_logs SELECT policy exposes a tenant's
      // own events to its members, and the organization comes from the OBJECT PATH - so
      // reading it as the member also proves the event was filed against the right tenant.
      await session.query("set local role service_role");
      const trail = await session.query<{
        actor_user_id: string;
        action: string;
        organization_id: string;
      }>(
        `select actor_user_id, action, organization_id from public.audit_logs
          where action = 'storage.object_deleted' and resource_type = 'patient-documents'`,
      );
      expect(trail.length).toBe(1);
      expect(trail[0]?.actor_user_id).toBe(DAVE);
      expect(
        trail[0]?.organization_id,
        "the event must name the tenant the object path belongs to",
      ).toBe(ORG_A);
      // Back to the member, or the next statement in this test would run with the wrong
      // role and pass for the wrong reason.
      await session.query("set local role authenticated");

      const renamed = await session.query<{ name: string }>(
        `update storage.objects set name = $1
          where bucket_id = 'patient-documents' and name = $2 returning name`,
        [`${ORG_A}/${CLINIC_A1}/taken-over.pdf`, `${ORG_A}/${CLINIC_A1}/alice-report.pdf`],
      );
      expect(renamed).toEqual([]);

      // Handing a new object to someone else, which would let it escape his own control
      // and land under a colleague's ownership in one step.
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)`,
        [`${ORG_A}/${CLINIC_A1}/gifted.pdf`, ALICE],
        /row-level security/i,
      );

      // Positive control: his OWN object deletes and renames freely, so the refusals
      // above are the owner clause and not the write path being closed for everyone.
      const own = await session.query<{ name: string }>(
        `delete from storage.objects
          where bucket_id = 'patient-documents' and name = $1 returning name`,
        [`${ORG_A}/${CLINIC_A1}/dave-note.pdf`],
      );
      expect(own).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("bucket configuration", () => {
  it("restricts every bucket to the agreed file types", async () => {
    // The only control on the mimetype, since `metadata` is deliberately unpinned.
    // Before this assertion the entire allowlist could be deleted and the suite stayed
    // green - the same ratchet class three times over, sitting on an
    // operator-confirmed decision.
    const rows = await query<{ id: string; allowed_mime_types: string[] | null }>(
      `select id, allowed_mime_types from storage.buckets order by id`,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.allowed_mime_types, `${row.id} has no MIME allowlist at all`).not.toBeNull();
      expect([...(row.allowed_mime_types ?? [])].sort(), `${row.id} file types`).toEqual(
        [...EXPECTED_MIME].sort(),
      );
    }
  });
});

dbDescribe("the archive and delete-marker pins", () => {
  it("refuses a client to create an archived object, or delete one the service role archived", async () => {
    const session = await stage();
    try {
      await session.query(`select set_config('storage.allow_delete_query', 'true', true)`);
      await become(session, DAVE);

      await expectRejection(
        session,
        `insert into storage.objects
           (id, bucket_id, name, owner_id, archived_at, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, now(), false, false)`,
        [`${ORG_A}/${CLINIC_A1}/pre-archived.pdf`, DAVE],
        /row-level security/i,
      );
      await expectRejection(
        session,
        `insert into storage.objects
           (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, true, false)`,
        [`${ORG_A}/${CLINIC_A1}/marker.pdf`, DAVE],
        /row-level security/i,
      );

      // The recorded trade-off: only the service role can archive, and once it has, no
      // authenticated principal can delete the object again - not even its uploader,
      // who holds every write permission.
      const removed = await session.query<{ name: string }>(
        `delete from storage.objects
          where bucket_id = 'patient-documents' and name = $1 returning name`,
        [`${ORG_A}/${CLINIC_A1}/dave-archived.pdf`],
      );
      expect(removed).toEqual([]);

      // But it is still READABLE, because SELECT deliberately ignores archived_at - an
      // object under legal hold has to stay visible to the people investigating it.
      const readable = await session.query<{ name: string }>(
        `select name from storage.objects
          where bucket_id = 'patient-documents' and name = $1`,
        [`${ORG_A}/${CLINIC_A1}/dave-archived.pdf`],
      );
      expect(readable).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("the path guard is not confined to writes", () => {
  it("hides a traversal-named object from SELECT too", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      const rows = await session.query<{ name: string }>(
        `select name from storage.objects where name like $1`,
        [`%seeded.png`],
      );
      expect(rows).toEqual([]);
      // Positive control: his real org-assets objects are visible, so the empty result
      // is the path guard and not a policy that shows DAVE nothing at all.
      const real = await session.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'org-assets' order by name`,
      );
      expect(real.map((r) => r.name)).toEqual([`${ORG_A}/frank-logo.png`, `${ORG_A}/logo.png`]);
    } finally {
      await session.rollback();
    }
  });

  it("refuses a traversal name on an org-assets write", async () => {
    const session = await stage();
    try {
      await become(session, DAVE);
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'org-assets', $1, $2, false, false)`,
        [`${ORG_A}/../${ORG_B}/traversed.png`, DAVE],
        /row-level security/i,
      );
      const permitted = await insertObject(session, "org-assets", `${ORG_A}/dave-brand.png`, DAVE);
      expect(permitted).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});

dbDescribe("the reach clause is load-bearing on its own", () => {
  it("refuses GRACE a clinic that only clinic_ids excludes", async () => {
    // Every other reach test here uses ALICE, whose role ASSIGNMENT is clinic-scoped -
    // so private.can already refuses her and nothing could tell whether the clinic_ids
    // conjunct was doing any work. GRACE's assignment is ORG-WIDE, so can() says yes to
    // every clinic and the reach clause is the only possible reason for a refusal.
    // Strip that conjunct from any of the four policies and this goes red.
    const session = await stage();
    try {
      // Seeded as the OWNER, so the policies do not decide whether these rows exist, and
      // so each object is GRACE's: an object owned by somebody else would be filtered
      // by the owner clause first, and the refusal would be attributable to the wrong
      // clause. That confound is exactly what my first attempt at this test did.
      await session.query(
        `insert into storage.objects
           (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false),
                (gen_random_uuid(), 'patient-documents', $3, $2, false, false)`,
        [`${ORG_A}/${CLINIC_A1}/grace-a1.pdf`, GRACE, `${ORG_A}/${CLINIC_A2}/grace-a2.pdf`],
      );
      await session.query(`select set_config('storage.allow_delete_query', 'true', true)`);
      await become(session, GRACE);

      // The premise, asserted rather than assumed.
      const permitted = await session.query<{ c: boolean }>(
        `select private.can($1, 'patients.update', $2) as c`,
        [ORG_A, CLINIC_A2],
      );
      expect(
        permitted[0]?.c,
        "premise: an org-wide assignment makes can() true for any clinic",
      ).toBe(true);
      const reach = await session.query<{ id: string }>(`select private.clinic_ids($1) as id`, [
        ORG_A,
      ]);
      expect(reach.map((r) => r.id)).toEqual([CLINIC_A1]);

      // SELECT: clinic A2 invisible, clinic A1 visible.
      expect(
        await session.query(`select name from storage.objects where name = $1`, [
          `${ORG_A}/${CLINIC_A2}/grace-a2.pdf`,
        ]),
      ).toEqual([]);
      expect(
        await session.query(`select name from storage.objects where name = $1`, [
          `${ORG_A}/${CLINIC_A1}/grace-a1.pdf`,
        ]),
      ).toHaveLength(1);

      // INSERT into the unreachable clinic raises; into the reachable one it succeeds.
      await expectRejection(
        session,
        `insert into storage.objects (id, bucket_id, name, owner_id, is_delete_marker, is_versioned)
         values (gen_random_uuid(), 'patient-documents', $1, $2, false, false)`,
        [`${ORG_A}/${CLINIC_A2}/grace-new.pdf`, GRACE],
        /row-level security/i,
      );
      const created = await insertObject(
        session,
        "patient-documents",
        `${ORG_A}/${CLINIC_A1}/grace-new.pdf`,
        GRACE,
      );
      expect(created).toHaveLength(1);

      // UPDATE into the unreachable clinic raises on WITH CHECK.
      await expectRejection(
        session,
        `update storage.objects set name = $1
          where bucket_id = 'patient-documents' and name = $2`,
        [`${ORG_A}/${CLINIC_A2}/grace-moved.pdf`, `${ORG_A}/${CLINIC_A1}/grace-a1.pdf`],
        /row-level security/i,
      );

      // DELETE from the unreachable clinic filters to zero rows; from the reachable one
      // it deletes. Both objects are hers, so the owner clause cannot be the reason.
      expect(
        await session.query(`delete from storage.objects where name = $1 returning name`, [
          `${ORG_A}/${CLINIC_A2}/grace-a2.pdf`,
        ]),
      ).toEqual([]);
      expect(
        await session.query(`delete from storage.objects where name = $1 returning name`, [
          `${ORG_A}/${CLINIC_A1}/grace-a1.pdf`,
        ]),
      ).toHaveLength(1);
    } finally {
      await session.rollback();
    }
  });
});
