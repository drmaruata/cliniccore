// @vitest-environment node
import { expect, it } from "vitest";

import { dbDescribe, query } from "./helpers/database";

/*
 * Task 8 - tenant data, audit and platform schema, asserted against the live
 * catalogue.
 *
 * Two requirements here are the OPPOSITE of each other and both are load-bearing.
 * patients and patient_identifiers are joined to their parents by composite
 * foreign keys that span organization_id, so a row cannot reach across tenants.
 * audit_logs and platform_settings must carry NO foreign keys at all: a cascade
 * from organizations would erase a tenant's trail when the tenant is deleted, and
 * one from auth.users would erase it when the actor's account is closed - which
 * is exactly when you most want to know what they did.
 */

const NEW_TABLES = [
  "patients",
  "patient_identifiers",
  "tenant_sequences",
  "audit_logs",
  "platform_settings",
];

dbDescribe("tenant data tables", () => {
  it("creates all five with row-level security enabled", async () => {
    const rows = await query<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any ($1)
        order by c.relname`,
      [NEW_TABLES],
    );
    expect(rows.map((r) => r.relname)).toEqual([...NEW_TABLES].sort());
    for (const row of rows) expect(row.rls, `${row.relname} must have RLS enabled`).toBe(true);
  });

  it("scopes a patient to a clinic in its own organization, and an identifier to its own patient", async () => {
    const rows = await query<{
      conname: string;
      n_keys: number;
      columns: string;
      on_delete: string;
    }>(
      `select conname,
              array_length(conkey, 1) as n_keys,
              confdeltype as on_delete,
              (select string_agg(a.attname, ',' order by k.ord)
                 from unnest(conkey) with ordinality k(attnum, ord)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = conrelid and a.attnum = k.attnum) as columns
         from pg_catalog.pg_constraint
        where conname in ('patients_clinic_fkey', 'patient_identifiers_patient_fkey')
        order by conname`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r]));
    for (const name of ["patients_clinic_fkey", "patient_identifiers_patient_fkey"]) {
      const row = byName.get(name);
      expect(row, `${name} is missing`).toBeDefined();
      expect(row?.n_keys, `${name} must be composite`).toBe(2);
      expect(row?.columns?.split(",")).toContain("organization_id");
    }
    // RESTRICT, not CASCADE: an identifier is part of the patient's record and
    // losing one silently because something touched the parent is worse than
    // blocking the delete.
    expect(byName.get("patient_identifiers_patient_fkey")?.on_delete).toBe("r");
  });

  it("keeps mrn text, and creates no sequence in the schema", async () => {
    const rows = await query<{ type: string }>(
      `select format_type(a.atttypid, a.atttypmod) as type
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.patients'::regclass and a.attname = 'mrn'`,
    );
    // A sequence would make identifiers enumerable across tenants and would
    // hard-code a format into the schema.
    expect(rows[0]?.type).toBe("text");
    const owned = await query<{ seq: string }>(
      `select c.relname as seq
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'S' and c.relowner = 'public.patients'::regclass`,
    );
    expect(owned).toEqual([]);
    // The only sequence in the schema is the audit log's own surrogate key,
    // which is deliberately not tenant data.
    const sequences = await query<{ seq: string }>(
      `select c.relname as seq
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'S'`,
    );
    expect(sequences.map((r) => r.seq)).toEqual(["audit_logs_id_seq"]);
  });

  it("uniquely identifies an MRN per clinic, and an identifier per organization", async () => {
    const rows = await query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def
         from pg_catalog.pg_constraint
        where conrelid in ('public.patients'::regclass, 'public.patient_identifiers'::regclass,
                            'public.tenant_sequences'::regclass)
          and contype in ('u', 'p')`,
    );
    const defs = rows.map((r) => r.def);
    expect(defs).toContain("UNIQUE (organization_id, id)");
    expect(defs).toContain("UNIQUE (organization_id, clinic_id, mrn)");
    expect(defs).toContain("UNIQUE (organization_id, kind, value)");
    expect(defs).toContain("PRIMARY KEY (organization_id, sequence_key)");
  });

  it("indexes the identifier foreign key its own unique cannot serve", async () => {
    const rows = await query<{ indexname: string }>(
      `select indexname from pg_catalog.pg_indexes
        where schemaname = 'public'
          and indexname in ('patient_identifiers_patient_idx', 'patients_clinic_idx',
                            'audit_logs_org_created_idx')
        order by indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "audit_logs_org_created_idx",
      "patient_identifiers_patient_idx",
      "patients_clinic_idx",
    ]);
  });
});

dbDescribe("audit log and platform settings", () => {
  it("gives both tables zero foreign keys, so the trail outlives tenant and actor", async () => {
    const rows = await query<{ tablename: string; fks: string }>(
      `select c.relname as tablename, count(k.oid)::text as fks
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         left join pg_catalog.pg_constraint k on k.conrelid = c.oid and k.contype = 'f'
        where n.nspname = 'public' and c.relname in ('audit_logs', 'platform_settings')
        group by c.relname order by c.relname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Number(row.fks), `${row.tablename} must have no FKs`).toBe(0);
  });

  it("revokes direct mutation, so append-only survives a mistyped policy", async () => {
    const rows = await query<{
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_select: boolean;
    }>(
      `select has_table_privilege('authenticated', 'public.audit_logs', 'insert') as can_insert,
              has_table_privilege('authenticated', 'public.audit_logs', 'update') as can_update,
              has_table_privilege('authenticated', 'public.audit_logs', 'delete') as can_delete,
              has_table_privilege('authenticated', 'public.audit_logs', 'select') as can_select`,
    );
    expect(rows[0]?.can_insert).toBe(false);
    expect(rows[0]?.can_update).toBe(false);
    expect(rows[0]?.can_delete).toBe(false);
    // Task 9's select-only policy is still reachable.
    expect(rows[0]?.can_select).toBe(true);
  });

  it("gives audit_logs a bigserial surrogate id", async () => {
    const rows = await query<{ type: string }>(
      `select format_type(a.atttypid, a.atttypmod) as type
         from pg_catalog.pg_attribute a
        where a.attrelid = 'public.audit_logs'::regclass and a.attname = 'id'`,
    );
    expect(rows[0]?.type).toBe("bigint");
  });
});
