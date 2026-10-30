// @vitest-environment node
/**
 * Task 2 - the Phase 5 clinical policies, asserted against the live catalogue.
 *
 * WHY THIS FILE EXISTS. The clinical tables are the first tenant data that hangs off
 * patients rather than clinics alone, so their policies are the only thing standing
 * between a clinic-scoped principal and another clinic's appointments, queue entries and
 * clinical records. The catalogue half of the security suite pins the global policy set;
 * this file pins the SHAPE of the thirteen clinical policies and the two locks beside
 * them: every policy carries a row filter where its command needs one, and the grant
 * ceiling matches the policies - DELETE is absent on encounters and addenda, addenda has
 * no UPDATE, and anon holds nothing at all.
 *
 * The finalization guards are asserted STRUCTURALLY, not behaviourally: this file reads the
 * policy expressions, and Task 9 owns the behavioural finalization test. `encounters_write`
 * must admit only a draft with null finalized_at and finalized_by, `encounters_update` must
 * carry the same guard in BOTH the using and the with check, and an addendum may only attach
 * to a finalized encounter. The using clause decides which rows may be updated; the with
 * check decides what the new row may look like. A guard in only one of the two lets a caller
 * either edit a finalized record or finalize one through an UPDATE.
 *
 * Every test runs inside a transaction that always rolls back, so the suite leaves no
 * rows and no DDL behind. It connects as the owner, which bypasses RLS; the behavioural
 * half of clinical isolation belongs to the security suite.
 */
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";

import { beginSession, closePool, dbDescribe, expectRejection } from "./helpers/database";
import { seedFixture, createRole } from "./helpers/fixtures";

type Cmd = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

interface Expected {
  table: string;
  name: string;
  cmd: Cmd;
  /** A row filter must exist; INSERT legitimately has none. */
  qual: boolean;
  /** A new-row check must exist; SELECT and DELETE legitimately have none. */
  withCheck: boolean;
}

const EXPECTED: Expected[] = [
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

const CLINICAL_TABLES = ["appointments", "encounter_addenda", "encounters", "queue_entries"];

/** The command set `authenticated` may hold per table. */
const GRANTS: Record<string, Cmd[]> = {
  appointments: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  queue_entries: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  encounters: ["SELECT", "INSERT", "UPDATE"],
  // Append-only: no UPDATE policy exists, and the dead UPDATE privilege is revoked.
  encounter_addenda: ["SELECT", "INSERT"],
};

const COMMANDS: Cmd[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

afterAll(closePool);

dbDescribe("clinical policies", () => {
  it("creates the thirteen policies, each with the shape its command needs", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{
        tablename: string;
        policyname: string;
        permissive: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select tablename, policyname, permissive, cmd, qual, with_check
           from pg_catalog.pg_policies
          where schemaname = 'public' and tablename = any ($1)`,
        [CLINICAL_TABLES],
      );

      // Nothing beyond the brief's set. An unlisted policy on a clinical table is a
      // hole nobody reviewed, so the total is asserted, not just each presence.
      expect(rows).toHaveLength(EXPECTED.length);
      const found = new Map(rows.map((row) => [`${row.tablename}.${row.policyname}`, row]));
      expect([...found.keys()].sort()).toEqual(EXPECTED.map((e) => `${e.table}.${e.name}`).sort());

      for (const e of EXPECTED) {
        const key = `${e.table}.${e.name}`;
        const row = found.get(key);
        expect(row?.permissive, `${key} must be PERMISSIVE`).toBe("PERMISSIVE");
        expect(row?.cmd, `${key} command`).toBe(e.cmd);
        if (e.qual) expect(row?.qual, `${key} must filter rows`).toBeTruthy();
        else expect(row?.qual, `${key} must not carry a row filter`).toBeNull();
        if (e.withCheck) expect(row?.with_check, `${key} must check new rows`).toBeTruthy();
        else expect(row?.with_check, `${key} must not carry a new-row check`).toBeNull();
      }
    } finally {
      await session.rollback();
    }
  });

  it("grants authenticated exactly the clinical command set and anon nothing", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{
        table_name: string;
        auth_select: boolean;
        auth_insert: boolean;
        auth_update: boolean;
        auth_delete: boolean;
        auth_truncate: boolean;
        auth_references: boolean;
        auth_trigger: boolean;
        anon_select: boolean;
        anon_insert: boolean;
        anon_update: boolean;
        anon_delete: boolean;
        anon_truncate: boolean;
        anon_references: boolean;
        anon_trigger: boolean;
      }>(
        `select c.relname as table_name,
                has_table_privilege('authenticated', c.oid, 'select') as auth_select,
                has_table_privilege('authenticated', c.oid, 'insert') as auth_insert,
                has_table_privilege('authenticated', c.oid, 'update') as auth_update,
                has_table_privilege('authenticated', c.oid, 'delete') as auth_delete,
                has_table_privilege('authenticated', c.oid, 'truncate') as auth_truncate,
                has_table_privilege('authenticated', c.oid, 'references') as auth_references,
                has_table_privilege('authenticated', c.oid, 'trigger') as auth_trigger,
                has_table_privilege('anon', c.oid, 'select') as anon_select,
                has_table_privilege('anon', c.oid, 'insert') as anon_insert,
                has_table_privilege('anon', c.oid, 'update') as anon_update,
                has_table_privilege('anon', c.oid, 'delete') as anon_delete,
                has_table_privilege('anon', c.oid, 'truncate') as anon_truncate,
                has_table_privilege('anon', c.oid, 'references') as anon_references,
                has_table_privilege('anon', c.oid, 'trigger') as anon_trigger
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any ($1)
          order by c.relname`,
        [CLINICAL_TABLES],
      );
      expect(rows.map((row) => row.table_name)).toEqual(CLINICAL_TABLES);

      for (const row of rows) {
        const allowed = GRANTS[row.table_name] ?? [];
        for (const cmd of COMMANDS) {
          expect(
            row[`auth_${cmd.toLowerCase()}` as keyof typeof row],
            `authenticated must ${allowed.includes(cmd) ? "hold" : "NOT hold"} ${cmd} on ${row.table_name}`,
          ).toBe(allowed.includes(cmd));
          expect(
            row[`anon_${cmd.toLowerCase()}` as keyof typeof row],
            `anon must NOT hold ${cmd} on ${row.table_name}`,
          ).toBe(false);
        }
        // Neither role may hold a maintenance privilege: TRUNCATE empties the table,
        // REFERENCES can pin a foreign key, and TRIGGER can attach one that runs as the
        // table owner. The migration revokes ALL, so these must all be false.
        for (const privilege of ["truncate", "references", "trigger"]) {
          expect(
            row[`auth_${privilege}` as keyof typeof row],
            `authenticated must NOT hold ${privilege} on ${row.table_name}`,
          ).toBe(false);
          expect(
            row[`anon_${privilege}` as keyof typeof row],
            `anon must NOT hold ${privilege} on ${row.table_name}`,
          ).toBe(false);
        }
      }

      // The negative half spelled out, because it is the one a stray default GRANT
      // reopens: clinical history is not client-deletable through the API.
      for (const table of ["encounters", "encounter_addenda"]) {
        const row = rows.find((r) => r.table_name === table);
        expect(row?.auth_delete, `authenticated must NOT hold DELETE on ${table}`).toBe(false);
      }
    } finally {
      await session.rollback();
    }
  });

  it("guards finalization in both halves of every encounter write path", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{
        tablename: string;
        policyname: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select tablename, policyname, qual, with_check
           from pg_catalog.pg_policies
          where schemaname = 'public'
            and (tablename, policyname) in (
              ('encounters', 'encounters_write'),
              ('encounters', 'encounters_update'),
              ('encounter_addenda', 'encounter_addenda_write')
            )`,
      );
      expect(rows).toHaveLength(3);
      const found = new Map(rows.map((row) => [row.policyname, row]));
      // `status = 'draft'` is deparsed with an explicit text cast; stripping it keeps the
      // assertions readable without depending on the cast's spelling.
      const normalize = (text: string | null | undefined) =>
        (text ?? "")
          .toLowerCase()
          .replace(/::text/g, "")
          .replace(/\s+/g, " ");

      const write = found.get("encounters_write");
      // An INSERT may not create a finalized record: that is the definer RPC's path, and
      // only that path writes the audit row.
      expect(normalize(write?.with_check)).toContain("status = 'draft'");
      expect(normalize(write?.with_check)).toContain("finalized_at is null");
      expect(normalize(write?.with_check)).toContain("finalized_by is null");

      const update = found.get("encounters_update");
      // Both halves: the using clause stops a finalized row from being selected for
      // update, and the with check stops an UPDATE from finalizing a draft.
      for (const half of [update?.qual, update?.with_check]) {
        expect(normalize(half)).toContain("status = 'draft'");
        expect(normalize(half)).toContain("finalized_at is null");
      }

      const addendum = found.get("encounter_addenda_write");
      // An addendum annotates a finalized record; attaching one to a draft would let the
      // draft's author write history that the finalization audit never saw.
      expect(normalize(addendum?.with_check)).toContain("finalized_at is not null");
    } finally {
      await session.rollback();
    }
  });

  it("allows a clinician to update a draft encounter", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const actorId = randomUUID();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, created_at, updated_at, aud, role, is_anonymous)
         values ($1, $2, now(), now(), now(), 'authenticated', 'authenticated', false)`,
        [actorId, `clinician-${actorId.slice(0, 8)}@test.local`],
      );
      const [membership] = await session.query<{ id: string }>(
        `insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') returning id`,
        [organizationId, actorId],
      );
      if (!membership) throw new Error("membership insert returned no row");
      await session.query(
        `insert into public.clinic_memberships (organization_id, membership_id, clinic_id) values ($1, $2, $3)`,
        [organizationId, membership.id, clinicId],
      );
      const roleId = await createRole(session, organizationId, "test_doctor", ["encounters.write"]);
      await session.query(
        `insert into public.user_role_assignments (organization_id, user_id, role_id) values ($1, $2, $3)`,
        [organizationId, actorId, roleId],
      );

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters (organization_id, clinic_id, patient_id, status, chief_complaint)
         values ($1, $2, $3, 'draft', 'Initial complaint') returning id`,
        [organizationId, clinicId, patientId],
      );
      if (!encounter) throw new Error("encounter insert returned no row");

      await session.query("set local role authenticated");
      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
      await session.query(
        `update public.encounters set chief_complaint = 'Updated complaint' where id = $1`,
        [encounter.id],
      );

      const [row] = await session.query<{ chief_complaint: string }>(
        `select chief_complaint from public.encounters where id = $1`,
        [encounter.id],
      );
      expect(row?.chief_complaint).toBe("Updated complaint");
    } finally {
      await session.rollback();
    }
  });

  it("refuses direct UPDATE of a finalized encounter (zero rows affected, row unchanged)", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const actorId = randomUUID();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, created_at, updated_at, aud, role, is_anonymous)
         values ($1, $2, now(), now(), now(), 'authenticated', 'authenticated', false)`,
        [actorId, `clinician-${actorId.slice(0, 8)}@test.local`],
      );
      const [membership] = await session.query<{ id: string }>(
        `insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') returning id`,
        [organizationId, actorId],
      );
      if (!membership) throw new Error("membership insert returned no row");
      await session.query(
        `insert into public.clinic_memberships (organization_id, membership_id, clinic_id) values ($1, $2, $3)`,
        [organizationId, membership.id, clinicId],
      );
      const roleId = await createRole(session, organizationId, "test_doctor", ["encounters.write"]);
      await session.query(
        `insert into public.user_role_assignments (organization_id, user_id, role_id) values ($1, $2, $3)`,
        [organizationId, actorId, roleId],
      );

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters (organization_id, clinic_id, patient_id, status, chief_complaint, finalized_at, finalized_by)
         values ($1, $2, $3, 'finalized', 'Finalized complaint', now(), $4) returning id`,
        [organizationId, clinicId, patientId, actorId],
      );
      if (!encounter) throw new Error("encounter insert returned no row");

      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
      await session.query("set local role authenticated");
      await session.query(
        `update public.encounters set chief_complaint = 'Tampered' where id = $1`,
        [encounter.id],
      );

      const [row] = await session.query<{ chief_complaint: string }>(
        `select chief_complaint from public.encounters where id = $1`,
        [encounter.id],
      );
      expect(row?.chief_complaint).toBe("Finalized complaint");
    } finally {
      await session.rollback();
    }
  });

  it("finalize_encounter succeeds once and raises on second call", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const actorId = randomUUID();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, created_at, updated_at, aud, role, is_anonymous)
         values ($1, $2, now(), now(), now(), 'authenticated', 'authenticated', false)`,
        [actorId, `clinician-${actorId.slice(0, 8)}@test.local`],
      );
      const [membership] = await session.query<{ id: string }>(
        `insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') returning id`,
        [organizationId, actorId],
      );
      if (!membership) throw new Error("membership insert returned no row");
      await session.query(
        `insert into public.clinic_memberships (organization_id, membership_id, clinic_id) values ($1, $2, $3)`,
        [organizationId, membership.id, clinicId],
      );
      const roleId = await createRole(session, organizationId, "test_doctor", ["encounters.write"]);
      await session.query(
        `insert into public.user_role_assignments (organization_id, user_id, role_id) values ($1, $2, $3)`,
        [organizationId, actorId, roleId],
      );

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters (organization_id, clinic_id, patient_id, status, chief_complaint)
         values ($1, $2, $3, 'draft', 'To be finalized') returning id`,
        [organizationId, clinicId, patientId],
      );
      if (!encounter) throw new Error("encounter insert returned no row");

      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
      await session.query(`select public.finalize_encounter($1)`, [encounter.id]);

      const [afterFirst] = await session.query<{
        status: string;
        finalized_at: string;
        finalized_by: string;
      }>(`select status, finalized_at, finalized_by from public.encounters where id = $1`, [
        encounter.id,
      ]);
      expect(afterFirst?.status).toBe("finalized");
      expect(afterFirst?.finalized_at).toBeTruthy();
      expect(afterFirst?.finalized_by).toBe(actorId);

      await expectRejection(
        session,
        `select public.finalize_encounter($1)`,
        [encounter.id],
        /encounter already finalized/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("refuses encounter_addenda INSERT for a user without encounters.write", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const actorId = randomUUID();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, created_at, updated_at, aud, role, is_anonymous)
         values ($1, $2, now(), now(), now(), 'authenticated', 'authenticated', false)`,
        [actorId, `no-permission-${actorId.slice(0, 8)}@test.local`],
      );
      const [membership] = await session.query<{ id: string }>(
        `insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') returning id`,
        [organizationId, actorId],
      );
      if (!membership) throw new Error("membership insert returned no row");
      await session.query(
        `insert into public.clinic_memberships (organization_id, membership_id, clinic_id) values ($1, $2, $3)`,
        [organizationId, membership.id, clinicId],
      );
      // No role assignment = no encounters.write permission

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters (organization_id, clinic_id, patient_id, status, finalized_at, finalized_by)
         values ($1, $2, $3, 'finalized', now(), $4) returning id`,
        [organizationId, clinicId, patientId, actorId],
      );
      if (!encounter) throw new Error("encounter insert returned no row");

      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
      await expectRejection(
        session,
        `select public.add_encounter_addendum($1, 'Addendum body')`,
        [encounter.id],
        /insufficient privilege/,
      );
    } finally {
      await session.rollback();
    }
  });
});
