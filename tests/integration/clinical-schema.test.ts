// @vitest-environment node
/**
 * Task 1 - the clinical core schema, asserted against the live catalogue.
 *
 * WHY THIS FILE EXISTS. The four tables in 20261029001900 hang off patients as
 * well as clinics, so the load-bearing property is structural: every reference
 * includes organization_id, which makes a cross-tenant appointment, queue entry,
 * encounter or addendum unrepresentable rather than merely hidden. The test
 * reads pg_constraint and asserts the exact column ORDER of each foreign key,
 * because a composite key with the right columns in the wrong order would still
 * pass a naive set comparison.
 *
 * The CHECKs are exercised, not just read. A constraint definition in
 * pg_constraint proves a name exists; inserting the admitted values and the
 * refused one proves the predicate does what the brief says. The status
 * transition trigger gets the same treatment: one legal move, one illegal move,
 * and a no-op, because a no-op is allowed and a skip is not.
 *
 * Fixtures are created inside a transaction that always rolls back, so no
 * clinical row is left behind. The suite connects as the owner, which bypasses
 * RLS; the policies themselves belong to the clinical RLS task.
 */
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";

import { beginSession, closePool, dbDescribe, expectRejection, query } from "./helpers/database";

const NEW_TABLES = ["appointments", "encounter_addenda", "encounters", "queue_entries"];

const EXPECTED_COLUMNS: Record<string, string[]> = {
  appointments: [
    "id",
    "organization_id",
    "clinic_id",
    "patient_id",
    "clinician_user_id",
    "scheduled_start",
    "scheduled_end",
    "status",
    "reason",
    "notes",
    "created_by",
    "created_at",
    "updated_at",
  ],
  queue_entries: [
    "id",
    "organization_id",
    "clinic_id",
    "patient_id",
    "appointment_id",
    "status",
    "queued_at",
    "called_at",
    "completed_at",
    "created_by",
  ],
  encounters: [
    "id",
    "organization_id",
    "clinic_id",
    "patient_id",
    "appointment_id",
    "clinician_user_id",
    "status",
    "chief_complaint",
    "history",
    "examination",
    "assessment",
    "plan",
    "started_at",
    "finalized_at",
    "finalized_by",
    "created_at",
    "updated_at",
  ],
  encounter_addenda: [
    "id",
    "organization_id",
    "encounter_id",
    "author_user_id",
    "body",
    "created_at",
  ],
};

type ForeignKeyRow = {
  conname: string;
  table_name: string;
  referenced: string;
  on_delete: string;
  columns: string[];
  referenced_columns: string[];
};

/**
 * `onDelete` is pg_constraint.confdeltype: c = cascade, r = restrict,
 * a = no action. Patient references are RESTRICT so clinical history blocks a
 * hard delete; clinic references keep NO ACTION so an organization's cascade can
 * remove clinics and their children in one statement.
 */
const EXPECTED_FOREIGN_KEYS: Record<
  string,
  {
    table: string;
    columns: string[];
    referenced: string;
    referencedColumns: string[];
    onDelete: string;
  }
> = {
  appointments_organization_id_fkey: {
    table: "appointments",
    columns: ["organization_id"],
    referenced: "organizations",
    referencedColumns: ["id"],
    onDelete: "c",
  },
  appointments_clinic_fkey: {
    table: "appointments",
    columns: ["organization_id", "clinic_id"],
    referenced: "clinics",
    referencedColumns: ["organization_id", "id"],
    onDelete: "a",
  },
  appointments_patient_fkey: {
    table: "appointments",
    columns: ["organization_id", "patient_id"],
    referenced: "patients",
    referencedColumns: ["organization_id", "id"],
    onDelete: "r",
  },
  queue_entries_organization_id_fkey: {
    table: "queue_entries",
    columns: ["organization_id"],
    referenced: "organizations",
    referencedColumns: ["id"],
    onDelete: "c",
  },
  queue_entries_clinic_fkey: {
    table: "queue_entries",
    columns: ["organization_id", "clinic_id"],
    referenced: "clinics",
    referencedColumns: ["organization_id", "id"],
    onDelete: "a",
  },
  queue_entries_patient_fkey: {
    table: "queue_entries",
    columns: ["organization_id", "patient_id"],
    referenced: "patients",
    referencedColumns: ["organization_id", "id"],
    onDelete: "r",
  },
  queue_entries_appointment_fkey: {
    table: "queue_entries",
    columns: ["organization_id", "appointment_id"],
    referenced: "appointments",
    referencedColumns: ["organization_id", "id"],
    onDelete: "r",
  },
  encounters_organization_id_fkey: {
    table: "encounters",
    columns: ["organization_id"],
    referenced: "organizations",
    referencedColumns: ["id"],
    onDelete: "c",
  },
  encounters_clinic_fkey: {
    table: "encounters",
    columns: ["organization_id", "clinic_id"],
    referenced: "clinics",
    referencedColumns: ["organization_id", "id"],
    onDelete: "a",
  },
  encounters_patient_fkey: {
    table: "encounters",
    columns: ["organization_id", "patient_id"],
    referenced: "patients",
    referencedColumns: ["organization_id", "id"],
    onDelete: "r",
  },
  encounters_appointment_fkey: {
    table: "encounters",
    columns: ["organization_id", "appointment_id"],
    referenced: "appointments",
    referencedColumns: ["organization_id", "id"],
    onDelete: "r",
  },
  encounter_addenda_organization_id_fkey: {
    table: "encounter_addenda",
    columns: ["organization_id"],
    referenced: "organizations",
    referencedColumns: ["id"],
    onDelete: "c",
  },
  encounter_addenda_encounter_fkey: {
    table: "encounter_addenda",
    columns: ["organization_id", "encounter_id"],
    referenced: "encounters",
    referencedColumns: ["organization_id", "id"],
    onDelete: "r",
  },
};

type Session = Awaited<ReturnType<typeof beginSession>>;

interface Fixture {
  organizationId: string;
  clinicId: string;
  patientId: string;
}

/** One tenant, one clinic and one patient, created inside the caller's transaction. */
async function seedFixture(session: Session): Promise<Fixture> {
  const [organization] = await session.query<{ id: string }>(
    `insert into public.organizations (name, slug) values ('Clinical schema', $1) returning id`,
    // organizations_slug_length_check caps the slug at 48 characters.
    [`clinical-${randomUUID().slice(0, 8)}`],
  );
  if (organization === undefined) throw new Error("could not create the fixture organization");

  // clinics.timezone is filled from the organization by a BEFORE INSERT trigger.
  const [clinic] = await session.query<{ id: string }>(
    `insert into public.clinics (organization_id, name) values ($1, 'Main clinic') returning id`,
    [organization.id],
  );
  if (clinic === undefined) throw new Error("could not create the fixture clinic");

  const [patient] = await session.query<{ id: string }>(
    `insert into public.patients (organization_id, clinic_id, mrn) values ($1, $2, $3) returning id`,
    [organization.id, clinic.id, `MRN-${randomUUID()}`],
  );
  if (patient === undefined) throw new Error("could not create the fixture patient");

  return { organizationId: organization.id, clinicId: clinic.id, patientId: patient.id };
}

function normalizeRelation(name: string): string {
  return name.replace(/^public\./, "");
}

/** The ordered key columns from a `pg_get_indexdef` string, e.g. `(a, b, c)`. */
function indexColumns(definition: string): string[] {
  const columns = / USING \w+ \(([^)]+)\)/.exec(definition)?.[1];
  return columns === undefined ? [] : columns.split(",").map((column) => column.trim());
}

afterAll(closePool);

dbDescribe("clinical schema", () => {
  it("creates all four tables with row-level security enabled", async () => {
    const rows = await query<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any ($1)
        order by c.relname`,
      [NEW_TABLES],
    );
    expect(rows.map((row) => row.relname)).toEqual([...NEW_TABLES].sort());
    for (const row of rows) expect(row.rls, `${row.relname} must have RLS enabled`).toBe(true);
  });

  it("defines exactly the brief's columns, with the clinical actors as plain uuid", async () => {
    const rows = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = any ($1)
        order by table_name, ordinal_position`,
      [NEW_TABLES],
    );

    const byTable = new Map<string, typeof rows>();
    for (const row of rows) {
      const columns = byTable.get(row.table_name) ?? [];
      columns.push(row);
      byTable.set(row.table_name, columns);
    }

    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = byTable.get(table);
      expect(columns, `${table} is missing`).toBeDefined();
      expect(columns?.map((column) => column.column_name)).toEqual(expected);
    }

    const column = (table: string, name: string) =>
      byTable.get(table)?.find((row) => row.column_name === name);
    for (const [table, name] of [
      ["appointments", "clinician_user_id"],
      ["appointments", "created_by"],
      ["encounters", "clinician_user_id"],
      ["encounters", "finalized_by"],
      ["encounter_addenda", "author_user_id"],
    ] as const) {
      expect(column(table, name)?.data_type, `${table}.${name} must be uuid`).toBe("uuid");
      expect(column(table, name)?.is_nullable).toBe("YES");
    }

    expect(column("appointments", "scheduled_start")?.data_type).toBe("timestamp with time zone");
    expect(column("appointments", "scheduled_end")?.data_type).toBe("timestamp with time zone");
    expect(column("appointments", "status")?.column_default).toBe("'booked'::text");
    expect(column("queue_entries", "status")?.column_default).toBe("'waiting'::text");
    expect(column("encounters", "status")?.column_default).toBe("'draft'::text");
    // Append-only: an addendum has no updated_at, so no update trigger can rewrite it.
    expect(column("encounter_addenda", "updated_at")).toBeUndefined();
  });

  it("makes every patient, clinic and appointment reference composite over organization_id", async () => {
    const rows = await query<ForeignKeyRow>(
      `select k.conname,
              k.conrelid::regclass::text as table_name,
              k.confrelid::regclass::text as referenced,
              k.confdeltype as on_delete,
              (select array_agg(a.attname::text order by cols.ord)
                 from unnest(k.conkey) with ordinality as cols(attnum, ord)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = k.conrelid and a.attnum = cols.attnum) as columns,
              (select array_agg(a.attname::text order by cols.ord)
                 from unnest(k.confkey) with ordinality as cols(attnum, ord)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = k.confrelid and a.attnum = cols.attnum) as referenced_columns
         from pg_catalog.pg_constraint k
        where k.contype = 'f'
          and k.conrelid in ('public.appointments'::regclass,
                             'public.queue_entries'::regclass,
                             'public.encounters'::regclass,
                             'public.encounter_addenda'::regclass)
        order by k.conname`,
    );

    expect(rows).toHaveLength(Object.keys(EXPECTED_FOREIGN_KEYS).length);
    // No foreign key to auth.users: a closed staff account must not touch history.
    expect(rows.some((row) => row.referenced === "auth.users")).toBe(false);

    const byName = new Map(rows.map((row) => [row.conname, row]));
    for (const [name, expected] of Object.entries(EXPECTED_FOREIGN_KEYS)) {
      const row = byName.get(name);
      expect(row, `${name} is missing`).toBeDefined();
      expect(normalizeRelation(row?.table_name ?? ""), `${name} table`).toBe(expected.table);
      expect(row?.columns, `${name} column order`).toEqual(expected.columns);
      expect(normalizeRelation(row?.referenced ?? ""), `${name} parent`).toBe(expected.referenced);
      expect(row?.referenced_columns, `${name} parent column order`).toEqual(
        expected.referencedColumns,
      );
      expect(row?.on_delete, `${name} delete behaviour`).toBe(expected.onDelete);
    }
  });

  it("keeps the per-clinic MRN uniqueness a patient registration race depends on", async () => {
    const rows = await query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def
         from pg_catalog.pg_constraint
        where conrelid = 'public.patients'::regclass
          and conname = 'patients_organization_id_clinic_id_mrn_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.def).toBe("UNIQUE (organization_id, clinic_id, mrn)");
  });

  it("names every check exactly as the brief does", async () => {
    const rows = await query<{ conname: string; table_name: string }>(
      `select conname, conrelid::regclass::text as table_name
         from pg_catalog.pg_constraint
        where contype = 'c'
          and conrelid in ('public.appointments'::regclass,
                           'public.queue_entries'::regclass,
                           'public.encounters'::regclass)
        order by conname`,
    );
    expect(rows.map((row) => row.conname)).toEqual([
      "appointments_end_after_start_check",
      "appointments_status_check",
      "encounters_status_check",
      "queue_entries_status_check",
    ]);
    const byName = new Map(rows.map((row) => [row.conname, normalizeRelation(row.table_name)]));
    expect(byName.get("appointments_end_after_start_check")).toBe("appointments");
    expect(byName.get("appointments_status_check")).toBe("appointments");
    expect(byName.get("encounters_status_check")).toBe("encounters");
    expect(byName.get("queue_entries_status_check")).toBe("queue_entries");
  });

  it("admits exactly the appointment statuses and refuses an end that is not after the start", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);

      for (const status of [
        "booked",
        "confirmed",
        "checked_in",
        "completed",
        "cancelled",
        "no_show",
      ]) {
        await session.query(
          `insert into public.appointments
             (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end, status)
           values ($1, $2, $3, now(), now() + interval '15 minutes', $4)`,
          [organizationId, clinicId, patientId, status],
        );
      }

      const insertAppointment = `insert into public.appointments
          (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end, status)
        values ($1, $2, $3, now(), now() + interval '15 minutes', $4)`;

      await expectRejection(
        session,
        insertAppointment,
        [organizationId, clinicId, patientId, "bogus"],
        /appointments_status_check/,
      );
      await expectRejection(
        session,
        `insert into public.appointments
           (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end)
         values ($1, $2, $3, now(), now())`,
        [organizationId, clinicId, patientId],
        /appointments_end_after_start_check/,
      );
      await expectRejection(
        session,
        `insert into public.appointments
           (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end)
         values ($1, $2, $3, now(), now() - interval '1 minute')`,
        [organizationId, clinicId, patientId],
        /appointments_end_after_start_check/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("admits exactly the queue and encounter statuses", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);

      const [queue] = await session.query<{ id: string }>(
        `insert into public.queue_entries (organization_id, clinic_id, patient_id)
         values ($1, $2, $3) returning id`,
        [organizationId, clinicId, patientId],
      );
      if (queue === undefined) throw new Error("could not create the fixture queue entry");

      for (const status of ["called", "in_consultation", "completed", "skipped"]) {
        await session.query(`update public.queue_entries set status = $2 where id = $1`, [
          queue.id,
          status,
        ]);
      }
      await expectRejection(
        session,
        `insert into public.queue_entries (organization_id, clinic_id, patient_id, status)
         values ($1, $2, $3, 'bogus')`,
        [organizationId, clinicId, patientId],
        /queue_entries_status_check/,
      );

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters (organization_id, clinic_id, patient_id)
         values ($1, $2, $3) returning id`,
        [organizationId, clinicId, patientId],
      );
      if (encounter === undefined) throw new Error("could not create the fixture encounter");

      await session.query(`update public.encounters set status = 'finalized' where id = $1`, [
        encounter.id,
      ]);
      await expectRejection(
        session,
        `insert into public.encounters (organization_id, clinic_id, patient_id, status)
         values ($1, $2, $3, 'cancelled')`,
        [organizationId, clinicId, patientId],
        /encounters_status_check/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("creates the appointment and queue indexes with the exact definitions", async () => {
    const rows = await query<{
      indexname: string;
      is_unique: boolean;
      is_valid: boolean;
      predicate: string | null;
      definition: string;
    }>(
      `select c.relname as indexname,
              i.indisunique as is_unique,
              i.indisvalid as is_valid,
              pg_get_expr(i.indpred, i.indrelid) as predicate,
              pg_get_indexdef(i.indexrelid) as definition
         from pg_catalog.pg_index i
         join pg_catalog.pg_class c on c.oid = i.indexrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('appointments_clinic_start_idx',
                            'queue_open_idx',
                            'queue_one_open_per_patient_idx')
        order by c.relname`,
    );

    expect(rows.map((row) => row.indexname)).toEqual([
      "appointments_clinic_start_idx",
      "queue_one_open_per_patient_idx",
      "queue_open_idx",
    ]);
    for (const row of rows) expect(row.is_valid, `${row.indexname} must be valid`).toBe(true);

    const byName = new Map(rows.map((row) => [row.indexname, row]));
    const start = byName.get("appointments_clinic_start_idx");
    expect(indexColumns(start?.definition ?? "")).toEqual([
      "organization_id",
      "clinic_id",
      "scheduled_start",
    ]);
    expect(start?.is_unique).toBe(false);
    expect(start?.predicate).toBeNull();

    const open = byName.get("queue_open_idx");
    expect(indexColumns(open?.definition ?? "")).toEqual([
      "organization_id",
      "clinic_id",
      "queued_at",
    ]);
    expect(open?.is_unique).toBe(false);
    expect(open?.predicate?.replace(/\s+/g, " ")).toBe("(completed_at IS NULL)");

    const oneOpen = byName.get("queue_one_open_per_patient_idx");
    expect(indexColumns(oneOpen?.definition ?? "")).toEqual([
      "organization_id",
      "clinic_id",
      "patient_id",
    ]);
    expect(oneOpen?.is_unique).toBe(true);
    expect(oneOpen?.predicate?.replace(/\s+/g, " ")).toBe("(completed_at IS NULL)");
  });

  it("exists as a BEFORE UPDATE trigger and refuses a transition outside the graph", async () => {
    const session = await beginSession();
    try {
      const triggers = await session.query<{ tgname: string; table_name: string }>(
        `select t.tgname, c.relname as table_name
           from pg_catalog.pg_trigger t
           join pg_catalog.pg_class c on c.oid = t.tgrelid
          where t.tgname = 'appointments_status_transition' and not t.tgisinternal`,
      );
      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.table_name).toBe("appointments");

      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const [appointment] = await session.query<{ id: string }>(
        `insert into public.appointments
           (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end)
         values ($1, $2, $3, now(), now() + interval '15 minutes') returning id`,
        [organizationId, clinicId, patientId],
      );
      if (appointment === undefined) throw new Error("could not create the fixture appointment");

      const setStatus = `update public.appointments set status = $2 where id = $1`;
      await session.query(setStatus, [appointment.id, "confirmed"]);
      await expectRejection(
        session,
        setStatus,
        [appointment.id, "completed"],
        /cannot move from confirmed to completed/,
      );
      // A no-op is allowed: the same status is not a transition.
      await session.query(setStatus, [appointment.id, "confirmed"]);

      const [row] = await session.query<{ status: string }>(
        `select status from public.appointments where id = $1`,
        [appointment.id],
      );
      expect(row?.status).toBe("confirmed");
    } finally {
      await session.rollback();
    }
  });

  it("enforces every allowed and refused appointment status transition", async () => {
    const allowed: Array<[string, string]> = [
      ["booked", "confirmed"],
      ["booked", "cancelled"],
      ["confirmed", "checked_in"],
      ["confirmed", "cancelled"],
      ["confirmed", "no_show"],
      ["checked_in", "completed"],
      ["checked_in", "cancelled"],
      // A no-op is not a transition.
      ["booked", "booked"],
      ["confirmed", "confirmed"],
      ["checked_in", "checked_in"],
      ["completed", "completed"],
      ["cancelled", "cancelled"],
      ["no_show", "no_show"],
    ];
    const refused: Array<[string, string]> = [
      ["booked", "checked_in"],
      ["booked", "completed"],
      ["confirmed", "completed"],
      ["checked_in", "booked"],
      ["completed", "booked"],
      ["cancelled", "confirmed"],
    ];

    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const insertAppointment = `insert into public.appointments
          (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end, status)
        values ($1, $2, $3, now(), now() + interval '15 minutes', $4) returning id`;
      const setStatus = `update public.appointments set status = $2 where id = $1`;

      for (const [from, to] of allowed) {
        const [appointment] = await session.query<{ id: string }>(insertAppointment, [
          organizationId,
          clinicId,
          patientId,
          from,
        ]);
        if (appointment === undefined) throw new Error(`could not create a ${from} appointment`);
        await session.query(setStatus, [appointment.id, to]);
        const [row] = await session.query<{ status: string }>(
          `select status from public.appointments where id = $1`,
          [appointment.id],
        );
        expect(row?.status, `${from} -> ${to} must be allowed`).toBe(to);
      }

      for (const [from, to] of refused) {
        const [appointment] = await session.query<{ id: string }>(insertAppointment, [
          organizationId,
          clinicId,
          patientId,
          from,
        ]);
        if (appointment === undefined) throw new Error(`could not create a ${from} appointment`);
        await expectRejection(
          session,
          setStatus,
          [appointment.id, to],
          new RegExp(`cannot move from ${from} to ${to}`),
        );
      }
    } finally {
      await session.rollback();
    }
  });

  it("advances updated_at through the set_updated_at trigger", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      // now() is the transaction timestamp, so the insert is backdated to make the
      // trigger's write observable without sleeping inside one transaction.
      const [appointment] = await session.query<{ id: string }>(
        `insert into public.appointments
           (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end,
            created_at, updated_at)
         values ($1, $2, $3, now(), now() + interval '15 minutes',
                 now() - interval '1 hour', now() - interval '1 hour')
         returning id`,
        [organizationId, clinicId, patientId],
      );
      if (appointment === undefined) throw new Error("could not create the fixture appointment");
      await session.query(`update public.appointments set reason = 'Follow-up' where id = $1`, [
        appointment.id,
      ]);
      const [appointmentRow] = await session.query<{ advanced: boolean }>(
        `select updated_at > created_at as advanced from public.appointments where id = $1`,
        [appointment.id],
      );
      expect(appointmentRow?.advanced, "appointments.updated_at must advance").toBe(true);

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters
           (organization_id, clinic_id, patient_id, created_at, updated_at)
         values ($1, $2, $3, now() - interval '1 hour', now() - interval '1 hour')
         returning id`,
        [organizationId, clinicId, patientId],
      );
      if (encounter === undefined) throw new Error("could not create the fixture encounter");
      await session.query(`update public.encounters set assessment = 'Stable' where id = $1`, [
        encounter.id,
      ]);
      const [encounterRow] = await session.query<{ advanced: boolean }>(
        `select updated_at > created_at as advanced from public.encounters where id = $1`,
        [encounter.id],
      );
      expect(encounterRow?.advanced, "encounters.updated_at must advance").toBe(true);
    } finally {
      await session.rollback();
    }
  });

  it("keeps at most one open queue entry per patient and clinic", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);
      const insertQueueEntry = `insert into public.queue_entries (organization_id, clinic_id, patient_id)
         values ($1, $2, $3) returning id`;
      const params = [organizationId, clinicId, patientId];

      const [first] = await session.query<{ id: string }>(insertQueueEntry, params);
      if (first === undefined) throw new Error("could not create the first queue entry");

      await expectRejection(session, insertQueueEntry, params, /queue_one_open_per_patient_idx/);

      await session.query(
        `update public.queue_entries set status = 'completed', completed_at = now() where id = $1`,
        [first.id],
      );
      await session.query(insertQueueEntry, params);
    } finally {
      await session.rollback();
    }
  });

  it("blocks a hard delete of a patient with appointments and of an encounter with addenda", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);

      await session.query(
        `insert into public.appointments
           (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end)
         values ($1, $2, $3, now(), now() + interval '15 minutes')`,
        [organizationId, clinicId, patientId],
      );
      await expectRejection(
        session,
        `delete from public.patients where id = $1`,
        [patientId],
        /appointments_patient_fkey/,
      );

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters (organization_id, clinic_id, patient_id)
         values ($1, $2, $3) returning id`,
        [organizationId, clinicId, patientId],
      );
      if (encounter === undefined) throw new Error("could not create the fixture encounter");
      await session.query(
        `insert into public.encounter_addenda (organization_id, encounter_id, body)
         values ($1, $2, 'Reviewed after finalisation.')`,
        [organizationId, encounter.id],
      );

      await expectRejection(
        session,
        `delete from public.encounters where id = $1`,
        [encounter.id],
        /encounter_addenda_encounter_fkey/,
      );

      const [count] = await session.query<{ n: number }>(
        `select count(*)::int as n from public.encounter_addenda where encounter_id = $1`,
        [encounter.id],
      );
      expect(count?.n).toBe(1);
    } finally {
      await session.rollback();
    }
  });

  it("deletes an organization with clinical rows and cascades every child", async () => {
    // The RESTRICT patient and appointment references do not block a tenant delete:
    // PostgreSQL orders the organization's cascades so the referencing rows go first.
    // MEASURED: this delete succeeds with a full clinical record attached.
    const session = await beginSession();
    try {
      const { organizationId, clinicId, patientId } = await seedFixture(session);

      const [appointment] = await session.query<{ id: string }>(
        `insert into public.appointments
           (organization_id, clinic_id, patient_id, scheduled_start, scheduled_end)
         values ($1, $2, $3, now(), now() + interval '15 minutes') returning id`,
        [organizationId, clinicId, patientId],
      );
      if (appointment === undefined) throw new Error("could not create the fixture appointment");

      await session.query(
        `insert into public.queue_entries (organization_id, clinic_id, patient_id, appointment_id)
         values ($1, $2, $3, $4)`,
        [organizationId, clinicId, patientId, appointment.id],
      );

      const [encounter] = await session.query<{ id: string }>(
        `insert into public.encounters
           (organization_id, clinic_id, patient_id, appointment_id)
         values ($1, $2, $3, $4) returning id`,
        [organizationId, clinicId, patientId, appointment.id],
      );
      if (encounter === undefined) throw new Error("could not create the fixture encounter");

      await session.query(
        `insert into public.encounter_addenda (organization_id, encounter_id, body)
         values ($1, $2, 'Reviewed after finalisation.')`,
        [organizationId, encounter.id],
      );

      await session.query(`delete from public.organizations where id = $1`, [organizationId]);

      const [remaining] = await session.query<{
        clinics: number;
        patients: number;
        appointments: number;
        queue_entries: number;
        encounters: number;
        encounter_addenda: number;
      }>(
        `select (select count(*)::int from public.clinics where organization_id = $1) as clinics,
                (select count(*)::int from public.patients where organization_id = $1) as patients,
                (select count(*)::int from public.appointments where organization_id = $1) as appointments,
                (select count(*)::int from public.queue_entries where organization_id = $1) as queue_entries,
                (select count(*)::int from public.encounters where organization_id = $1) as encounters,
                (select count(*)::int from public.encounter_addenda where organization_id = $1) as encounter_addenda`,
        [organizationId],
      );
      expect(remaining).toEqual({
        clinics: 0,
        patients: 0,
        appointments: 0,
        queue_entries: 0,
        encounters: 0,
        encounter_addenda: 0,
      });
    } finally {
      await session.rollback();
    }
  });

  it("assigns MRNs automatically and sequentially per clinic", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId } = await seedFixture(session);
      const otherClinicId = randomUUID();
      await session.query(
        `insert into public.clinics (organization_id, name) values ($1, 'Other clinic')`,
        [organizationId],
      );
      // We need a real ID for the other clinic.
      const [otherClinic] = await session.query<{ id: string }>(
        `select id from public.clinics where organization_id = $1 and name = 'Other clinic'`,
        [organizationId],
      );
      const clinicBId = otherClinic?.id ?? otherClinicId;

      const actorId = randomUUID();
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, created_at, updated_at, aud, role, is_anonymous)
         values ($1, $2, now(), now(), now(), 'authenticated', 'authenticated', false)`,
        [actorId, `mrn-${actorId.slice(0, 8)}@test.local`],
      );
      await session.query(
        `insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')`,
        [organizationId, actorId],
      );
      // Stay as owner (postgres) to bypass RLS; set JWT claim so auth.uid() returns actorId for the MRN trigger
      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [actorId]);

      // 1. Auto-assignment regex
      const [p1] = await session.query<{ mrn: string }>(
        `insert into public.patients (organization_id, clinic_id) values ($1, $2) returning mrn`,
        [organizationId, clinicId],
      );
      expect(p1?.mrn).toMatch(/^MRN-\d{6}$/);

      // 2. Sequentiality
      const [p2] = await session.query<{ mrn: string }>(
        `insert into public.patients (organization_id, clinic_id) values ($1, $2) returning mrn`,
        [organizationId, clinicId],
      );
      const mrn1 = p1?.mrn ?? "";
      const mrn2 = p2?.mrn ?? "";
      const num1 = parseInt(mrn1.slice(4));
      const num2 = parseInt(mrn2.slice(4));
      expect(num2).toBe(num1 + 1);

      // 3. Isolation
      const [p3] = await session.query<{ mrn: string }>(
        `insert into public.patients (organization_id, clinic_id) values ($1, $2) returning mrn`,
        [organizationId, clinicBId],
      );
      expect(p3?.mrn).toBe("MRN-000001");
    } finally {
      await session.rollback();
    }
  });

  it("refuses MRN generation for unauthorized users", async () => {
    const session = await beginSession();
    try {
      const { organizationId, clinicId } = await seedFixture(session);
      const otherOrgId = randomUUID();
      const userId = randomUUID();

      // Stay as owner (postgres) to bypass RLS; test the function's internal
      // privilege checks by setting request.jwt.claim.sub before each call.

      // Privilege - Anon: No identity
      await session.query(`select set_config('request.jwt.claim.sub', null, true)`);
      await expectRejection(
        session,
        `select private.next_patient_mrn($1, $2)`,
        [organizationId, clinicId],
        /insufficient privilege/,
      );

      // Privilege - Org: Wrong Org
      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await expectRejection(
        session,
        `select private.next_patient_mrn($1, $2)`,
        [otherOrgId, clinicId],
        /insufficient privilege/,
      );

      // Privilege - Clinic: Unreachable Clinic
      const unreachableClinicId = randomUUID();
      // Create a membership for userId in the fixture org
      await session.query(
        `insert into auth.users (id, email, email_confirmed_at, created_at, updated_at, aud, role, is_anonymous)
         values ($1, $2, now(), now(), now(), 'authenticated', 'authenticated', false)`,
        [userId, `unreachable-${userId.slice(0, 8)}@test.local`],
      );
      await session.query(
        `insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')`,
        [organizationId, userId],
      );
      await session.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await expectRejection(
        session,
        `select private.next_patient_mrn($1, $2)`,
        [organizationId, unreachableClinicId],
        /insufficient privilege/,
      );
    } finally {
      await session.rollback();
    }
  });

  it("prevents MRN modification", async () => {
    const session = await beginSession();
    try {
      const { patientId } = await seedFixture(session);
      await expectRejection(
        session,
        `update public.patients set mrn = 'MRN-999999' where id = $1`,
        [patientId],
        /MRNs are immutable/,
      );
    } finally {
      await session.rollback();
    }
  });
});
