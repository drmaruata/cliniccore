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
 * ceiling matches the policies - DELETE is absent on encounters and addenda, and anon
 * holds nothing at all.
 *
 * The `finalized_at is null` assertion is behavioural rather than cosmetic. It is the
 * clause that makes a finalized encounter immutable through the ordinary UPDATE path, and
 * it has to sit in BOTH the using and the with check: the using clause decides which rows
 * may be updated, the with check decides what the new row may look like, and a policy
 * carrying it in only one of the two lets a caller either edit a finalized record or
 * finalize one through an UPDATE.
 *
 * Every test runs inside a transaction that always rolls back, so the suite leaves no
 * rows and no DDL behind. It connects as the owner, which bypasses RLS; the behavioural
 * half of clinical isolation belongs to the security suite.
 */
import { afterAll, expect, it } from "vitest";

import { beginSession, closePool, dbDescribe } from "./helpers/database";

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

/** The command set `authenticated` may hold per table. DELETE is absent by design. */
const GRANTS: Record<string, Cmd[]> = {
  appointments: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  queue_entries: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  encounters: ["SELECT", "INSERT", "UPDATE"],
  encounter_addenda: ["SELECT", "INSERT", "UPDATE"],
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
        anon_select: boolean;
        anon_insert: boolean;
        anon_update: boolean;
        anon_delete: boolean;
      }>(
        `select c.relname as table_name,
                has_table_privilege('authenticated', c.oid, 'select') as auth_select,
                has_table_privilege('authenticated', c.oid, 'insert') as auth_insert,
                has_table_privilege('authenticated', c.oid, 'update') as auth_update,
                has_table_privilege('authenticated', c.oid, 'delete') as auth_delete,
                has_table_privilege('anon', c.oid, 'select') as anon_select,
                has_table_privilege('anon', c.oid, 'insert') as anon_insert,
                has_table_privilege('anon', c.oid, 'update') as anon_update,
                has_table_privilege('anon', c.oid, 'delete') as anon_delete
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

  it("keeps finalized_at is null in both halves of encounters_update", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{ qual: string | null; with_check: string | null }>(
        `select qual, with_check
           from pg_catalog.pg_policies
          where schemaname = 'public' and tablename = 'encounters'
            and policyname = 'encounters_update'`,
      );
      expect(rows).toHaveLength(1);
      const normalize = (text: string | null | undefined) =>
        (text ?? "").toLowerCase().replace(/\s+/g, " ");
      // Both halves: the using clause stops a finalized row from being selected for
      // update, and the with check stops an UPDATE from setting the timestamp.
      expect(normalize(rows[0]?.qual)).toContain("finalized_at is null");
      expect(normalize(rows[0]?.with_check)).toContain("finalized_at is null");
    } finally {
      await session.rollback();
    }
  });
});
