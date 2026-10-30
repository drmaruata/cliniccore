// @vitest-environment node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { dbDescribe, closePool, query } from "./helpers/database";

/*
 * Task 6 - identity and tenancy schema, asserted against the live catalogue.
 *
 * This is the file the plan named and the one the controller rehearsals stood in
 * for. It reaches Postgres directly because PostgREST cannot return any of it:
 * pg_proc, pg_policies, pg_constraint and pg_index are all invisible over REST.
 *
 * Read this as a CATALOGUE test, not an isolation test. The connection is the
 * database owner and therefore bypasses RLS; nothing here proves a tenant cannot
 * read another tenant's rows. Behaviour belongs to a PostgREST suite signing in
 * as a real user.
 *
 * The skip policy lives in `dbDescribe` - see the comment there.
 */

const TENANCY_TABLES = [
  "profiles",
  "organizations",
  "organization_memberships",
  "clinics",
  "clinic_memberships",
  "invitations",
];

/** The query returns rows ordered by name, so the expectation must be too. */
const TENANCY_TABLES_BY_NAME = [...TENANCY_TABLES].sort();

afterAll(async () => {
  // Safe when the suite skipped: the pool is created lazily, so a never-created
  // pool means `closePool` is a no-op.
  await closePool();
});

dbDescribe("tenancy tables", () => {
  it("creates all six with row-level security enabled", async () => {
    const rows = await query<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any ($1)
        order by c.relname`,
      [TENANCY_TABLES],
    );
    expect(rows.map((r) => r.relname)).toEqual(TENANCY_TABLES_BY_NAME);
    for (const row of rows) expect(row.rls, `${row.relname} must have RLS enabled`).toBe(true);
  });

  it("scopes both clinic_memberships foreign keys to the organization", async () => {
    const rows = await query<{ conname: string; n_keys: number; columns: string }>(
      `select conname,
              array_length(conkey, 1) as n_keys,
              (select string_agg(a.attname, ',' order by k.ord)
                 from unnest(conkey) with ordinality k(attnum, ord)
                 join pg_catalog.pg_attribute a
                   on a.attrelid = conrelid and a.attnum = k.attnum) as columns
         from pg_catalog.pg_constraint
        where conrelid = 'public.clinic_memberships'::regclass and contype = 'f'
        order by conname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // A single-column FK here would silently reopen the cross-tenant hole.
      expect(row.n_keys, `${row.conname} must be composite`).toBe(2);
      expect(row.columns.split(",")).toContain("organization_id");
    }
  });

  it("keeps organizations.slug a unique citext", async () => {
    const rows = await query<{ type: string; unique_defs: number }>(
      `select (select format_type(a.atttypid, a.atttypmod)
                  from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.organizations'::regclass and a.attname = 'slug') as type,
             (select count(*) from pg_catalog.pg_constraint
               where conrelid = 'public.organizations'::regclass
                 and contype = 'u'
                 and pg_get_constraintdef(oid) like '%slug%') as unique_defs`,
    );
    expect(rows[0]?.type).toBe("citext");
    expect(Number(rows[0]?.unique_defs)).toBe(1);
  });
});

dbDescribe("nulls not distinct uniques", () => {
  it("makes the platform role and every org-wide assignment conflict", async () => {
    const rows = await query<{ tablename: string; nulls_not_distinct: boolean }>(
      `select t.relname as tablename, ix.indnullsnotdistinct as nulls_not_distinct
         from pg_catalog.pg_index ix
         join pg_catalog.pg_class i on i.oid = ix.indexrelid
         join pg_catalog.pg_class t on t.oid = ix.indrelid
        where (t.relname, ix.indisunique) in (('roles', true), ('user_role_assignments', true))
          and ix.indnullsnotdistinct`,
    );
    const tables = rows.map((r) => r.tablename).sort();
    expect(tables).toEqual(["roles", "user_role_assignments"]);
  });
});

dbDescribe("triggers", () => {
  it("attaches the platform-admin guard to UPDATE only", async () => {
    const rows = await query<{ tgname: string; def: string }>(
      `select t.tgname, pg_get_triggerdef(t.oid) as def
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and t.tgname = 'guard_platform_admin'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.def).toMatch(/BEFORE UPDATE/);
    // OLD is null on INSERT, so the predicate would reject every signup.
    expect(rows[0]?.def).not.toMatch(/INSERT/);
  });

  it("maintains updated_at on every table that carries the column", async () => {
    const rows = await query<{ tablename: string }>(
      `select c.relname as tablename
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and t.tgname = 'set_updated_at'
        order by c.relname`,
    );
    // patients joined this list in Task 8; a new updated_at table must be added
    // here or this assertion is the thing that notices it was forgotten.
    // `appointments` and `encounters` joined this list with the clinical schema
    // (20261029001900); a new updated_at table must be added here or this
    // assertion is the thing that notices it was forgotten.
    expect(rows.map((r) => r.tablename)).toEqual([
      "appointments",
      "clinics",
      "encounters",
      "organization_memberships",
      "organizations",
      "patients",
      "profiles",
    ]);
  });
});

dbDescribe("the private schema", () => {
  it("pins current_org_ids to a stable definer with an empty search_path", async () => {
    const rows = await query<{
      prosecdef: boolean;
      provolatile: string;
      search_path: string;
    }>(
      `select p.prosecdef, p.provolatile,
              coalesce(array_to_string(p.proconfig, ','), '') as search_path
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'current_org_ids'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prosecdef).toBe(true);
    expect(rows[0]?.provolatile).toBe("s");
    expect(rows[0]?.search_path).toBe('search_path=""');
  });

  it("denies anon and grants authenticated", async () => {
    const rows = await query<{ anon: boolean; authenticated: boolean }>(
      `select has_function_privilege('anon', 'private.current_org_ids()', 'execute') as anon,
              has_function_privilege('authenticated', 'private.current_org_ids()', 'execute') as authenticated`,
    );
    expect(rows[0]?.anon).toBe(false);
    expect(rows[0]?.authenticated).toBe(true);
  });

  it("is unreachable from anon at the schema level", async () => {
    const rows = await query<{ anon_usage: boolean }>(
      `select has_schema_privilege('anon', 'private', 'usage') as anon_usage`,
    );
    expect(rows[0]?.anon_usage).toBe(false);
  });
});

dbDescribe("privileges RLS does not cover", () => {
  it("revokes TRUNCATE, REFERENCES and TRIGGER from anon and authenticated", async () => {
    const rows = await query<{ tablename: string; truncate: boolean; trigger: boolean }>(
      `select c.relname as tablename,
              has_table_privilege('anon', c.oid, 'TRUNCATE') as truncate,
              has_table_privilege('authenticated', c.oid, 'TRIGGER') as trigger
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any ($1)
        order by c.relname`,
      [TENANCY_TABLES],
    );
    expect(rows).toHaveLength(TENANCY_TABLES.length);
    for (const row of rows) {
      expect(row.truncate, `${row.tablename}: anon holds TRUNCATE`).toBe(false);
      expect(row.trigger, `${row.tablename}: authenticated holds TRIGGER`).toBe(false);
    }
  });
});

dbDescribe("migration history", () => {
  it("records every migration file exactly once", async () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const rows = await query<{ name: string }>(
      "select name from supabase_migrations.schema_migrations order by name",
    );
    // The applier does NOT dedupe by idempotency_key - it re-executes - so this
    // is the only thing keeping a replayed migration from running twice.
    expect(rows.map((r) => r.name)).toEqual(files);
  });
});
