// @vitest-environment node
import { expect, it } from "vitest";

import { dbDescribe, query } from "./helpers/database";

/*
 * Task 5 - the private schema and its core functions, asserted against the live
 * catalogue.
 *
 * The load-bearing property here is that guard_platform_admin is SECURITY INVOKER
 * while its sibling is SECURITY DEFINER. That asymmetry is deliberate and is the
 * one sanctioned exception to the project's definer rule: a definer function
 * cannot see the caller's real role, and the obvious alternative signal (the
 * request.jwt.claim.role GUC) is forgeable via set_config, which is
 * PUBLIC-executable. It is defence-in-depth against the PostgREST table-endpoint
 * path, NOT an unforgeable boundary - no database-layer check can identify the
 * service role under PostgREST, because the authenticator role holds SET on it by
 * design. See docs/IMPLEMENTATION_STATUS.md, Task 5.
 */

dbDescribe("extensions", () => {
  it("installs citext into public, pinned rather than left to the applier's search_path", async () => {
    const rows = await query<{ extname: string; schema: string }>(
      `select e.extname, n.nspname as schema
         from pg_catalog.pg_extension e
         join pg_catalog.pg_namespace n on n.oid = e.extnamespace
        where e.extname in ('citext', 'pgcrypto')`,
    );
    const byName = new Map(rows.map((r) => [r.extname, r.schema]));
    // Without `with schema public` placement follows the applier's search_path
    // and becomes environment-dependent - citext landed in public only by luck.
    expect(byName.get("citext")).toBe("public");
    expect(byName.has("pgcrypto")).toBe(true);
  });
});

dbDescribe("the private schema", () => {
  it("exists and is closed to anon at the schema level", async () => {
    const rows = await query<{ exists: boolean; anon_usage: boolean }>(
      `select exists (select 1 from pg_catalog.pg_namespace where nspname = 'private') as exists,
              has_schema_privilege('anon', 'private', 'usage') as anon_usage`,
    );
    expect(rows[0]?.exists).toBe(true);
    expect(rows[0]?.anon_usage).toBe(false);
  });
});

dbDescribe("core trigger functions", () => {
  it("makes set_updated_at a definer with an empty search_path", async () => {
    const rows = await query<{ prosecdef: boolean; proconfig: string }>(
      `select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as proconfig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'set_updated_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prosecdef).toBe(true);
    expect(rows[0]?.proconfig).toBe('search_path=""');
  });

  it("makes guard_platform_admin an INVOKER - the one sanctioned exception", async () => {
    const rows = await query<{ prosecdef: boolean; proconfig: string }>(
      `select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as proconfig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'guard_platform_admin'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prosecdef).toBe(false);
    expect(rows[0]?.proconfig).toBe('search_path=""');
  });

  it("grants neither function to public, and grants neither to anon", async () => {
    const rows = await query<{ fn: string; public_exec: boolean; anon_exec: boolean }>(
      `select p.proname as fn,
              has_function_privilege('public', p.oid, 'execute') as public_exec,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('set_updated_at', 'guard_platform_admin')
        order by p.proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.public_exec, `public must not execute ${row.fn}`).toBe(false);
      expect(row.anon_exec, `anon must not execute ${row.fn}`).toBe(false);
    }
  });
});
