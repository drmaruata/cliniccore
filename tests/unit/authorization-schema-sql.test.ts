import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Task 7 - authorization migration invariants.
 *
 * The migrations are the source of truth and vitest cannot reach the database,
 * so these assertions guard the SQL text for the properties the live catalogue
 * was measured against: the nulls-not-distinct uniques that make the seed and
 * the assignment dedupe work, the composite clinic foreign key, RLS enabled per
 * table, the role org-scope guard on both referencing tables, and the four
 * helpers' security properties.
 *
 * The one assertion here is a prohibition rather than a shape: private.can must
 * never mention private.is_platform_admin. Letting platform operators pass the
 * permission check would expose every tenant's patient records, which the spec
 * calls excessive privilege - and that mistake is invisible in review because
 * the function would still work.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), "utf8")
    .replace(/^\s*--.*$/gm, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const SCHEMA = read("20261014000400_authorization.sql");
const FUNCTIONS = read("20261014000500_authorization_functions.sql");

const TABLES = ["permissions", "roles", "role_permissions", "user_role_assignments"];

describe("authorization schema migration", () => {
  it("declares all four tables", () => {
    for (const table of TABLES) {
      expect(SCHEMA).toContain(`create table if not exists public.${table} (`);
    }
  });

  it("enables RLS, deny-all, on every table", () => {
    for (const table of TABLES) {
      expect(SCHEMA).toContain(`alter table public.${table} enable row level security;`);
    }
    expect(SCHEMA.match(/enable row level security/g)).toHaveLength(TABLES.length);
  });

  it("makes roles and user_role_assignments unique nulls not distinct", () => {
    // A plain unique treats the NULLs as distinct, so the platform role row and
    // every org-wide assignment would never conflict.
    expect(SCHEMA).toContain("unique nulls not distinct (organization_id, key)");
    expect(SCHEMA).toContain(
      "unique nulls not distinct (organization_id, user_id, role_id, clinic_id)",
    );
  });

  it("scopes an assignment's clinic to its own organization by composite key", () => {
    expect(SCHEMA).toContain(
      "foreign key (organization_id, clinic_id) references public.clinics (organization_id, id)",
    );
  });

  it("cascades an assignment's organization, user and role away with them", () => {
    expect(SCHEMA).toContain(
      "organization_id uuid not null references public.organizations (id) on delete cascade",
    );
    expect(SCHEMA).toContain("user_id uuid not null references auth.users (id) on delete cascade");
    expect(SCHEMA).toContain(
      "role_id uuid not null references public.roles (id) on delete cascade",
    );
  });

  it("revokes the table-wide operations RLS does not cover, for future tables too", () => {
    expect(SCHEMA).toContain(
      "alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;",
    );
  });

  it("adds the deferred invitations.role_id foreign key", () => {
    expect(SCHEMA).toContain(
      "add constraint invitations_role_id_fkey foreign key (role_id) references public.roles (id) on delete cascade",
    );
  });

  it("guards both role-referencing tables against a cross-organization role", () => {
    expect(SCHEMA).toContain(
      "create or replace function private.guard_role_org_scope() returns trigger",
    );
    expect(SCHEMA).toContain(
      "v_role_org is distinct from new.organization_id and v_role_org is not null",
    );
    for (const table of ["invitations", "user_role_assignments"]) {
      expect(SCHEMA).toContain(
        `create trigger guard_role_org_scope before insert or update on public.${table}`,
      );
    }
  });
});

describe("authorization function migration", () => {
  it("makes all four helpers stable security-definers with an empty search_path", () => {
    expect(FUNCTIONS.match(/security definer/g)).toHaveLength(4);
    expect(FUNCTIONS.match(/stable/g)).toHaveLength(4);
    expect(FUNCTIONS.match(/set search_path = ''/g)).toHaveLength(4);
  });

  it("closes the helpers' grants to authenticated only", () => {
    expect(FUNCTIONS.match(/revoke execute on function private\./g)).toHaveLength(4);
    expect(FUNCTIONS.match(/grant execute on function private\./g)).toHaveLength(4);
  });

  it("never lets private.can consult platform administration", () => {
    const tail = FUNCTIONS.split("create or replace function private.can(")[1] ?? "";
    // Isolate the body: everything after the function is the revoke/grant block,
    // which legitimately names private.is_platform_admin.
    const body = tail.slice(tail.indexOf("as $fn$"), tail.indexOf("$fn$;"));
    expect(body).not.toContain("is_platform_admin");
  });

  it("requires an active membership and honours clinic scope in private.can", () => {
    expect(FUNCTIONS).toContain("select (select private.is_member(p_org_id)) and exists (");
    // When p_clinic_id is NULL only an org-wide assignment can satisfy it.
    expect(FUNCTIONS).toContain("and (a.clinic_id is null or a.clinic_id = p_clinic_id)");
  });

  it("returns no clinics to a non-member, and skips inactive clinics", () => {
    expect(FUNCTIONS).toContain("and exists (select 1 from mine)");
    expect(FUNCTIONS).toContain("and c.is_active");
  });
});
