import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Task 6 - tenancy migration invariants.
 *
 * The migrations in supabase/migrations/ are the source of truth, and there is
 * no database connection a vitest process can reach (migrations are applied
 * agent-side through the Composio MCP). These assertions therefore guard the
 * SQL text itself for the properties the live catalogue was measured against:
 * composite tenant foreign keys, RLS enabled per table, the UPDATE-only
 * platform-admin guard, and the definer current_org_ids. A future edit that
 * rewrites an FK to a single column, drops an RLS enable, or re-attaches the
 * guard to INSERT fails here even though nothing else in CI would notice.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), "utf8")
    .replace(/^\s*--.*$/gm, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const TENANCY = read("20261014000300_identity_and_tenancy.sql");
const HARDENING = read("20261014000310_tenancy_indexes_and_hardening.sql");

const TABLES = [
  "profiles",
  "organizations",
  "organization_memberships",
  "clinics",
  "clinic_memberships",
  "invitations",
];

describe("tenancy schema migration", () => {
  it("declares all six tables", () => {
    for (const table of TABLES) {
      expect(TENANCY).toContain(`create table if not exists public.${table} (`);
    }
  });

  it("enables RLS, deny-all, on every table in the same file that creates it", () => {
    for (const table of TABLES) {
      expect(TENANCY).toContain(`alter table public.${table} enable row level security;`);
    }
    expect(TENANCY.match(/enable row level security/g)).toHaveLength(TABLES.length);
  });

  it("creates no policies here - policies belong to Task 9", () => {
    expect(TENANCY).not.toContain("create policy");
  });

  it("makes both clinic_memberships foreign keys composite and cascading, including organization_id", () => {
    expect(TENANCY).toContain(
      "foreign key (organization_id, membership_id) references public.organization_memberships (organization_id, id) on delete cascade",
    );
    expect(TENANCY).toContain(
      "foreign key (organization_id, clinic_id) references public.clinics (organization_id, id) on delete cascade",
    );
    expect(TENANCY.match(/foreign key \(organization_id,/g)).toHaveLength(2);
  });

  it("exposes the (organization_id, id) uniques the composite foreign keys require", () => {
    expect(TENANCY).toContain("unique (organization_id, id)");
    expect(TENANCY).toContain("unique (organization_id, user_id)");
    expect(TENANCY.match(/unique \(organization_id, id\)/g)).toHaveLength(2);
  });

  it("keeps organizations.slug a unique citext", () => {
    expect(TENANCY).toContain("slug citext not null unique");
  });

  it("attaches the platform-admin guard to UPDATE only", () => {
    expect(TENANCY).toContain(
      "create trigger guard_platform_admin before update on public.profiles",
    );
    expect(TENANCY).not.toMatch(/guard_platform_admin before insert/);
  });

  it("scopes current_org_ids to the caller's active memberships with a stable definer and closed grants", () => {
    expect(TENANCY).toContain(
      "create or replace function private.current_org_ids() returns setof uuid language sql security definer stable set search_path = ''",
    );
    expect(TENANCY).toContain("where user_id = (select auth.uid()) and status = 'active';");
    expect(TENANCY).toContain("revoke execute on function private.current_org_ids() from public;");
    expect(TENANCY).toContain(
      "grant execute on function private.current_org_ids() to authenticated;",
    );
  });
});

describe("tenancy hardening migration", () => {
  it("indexes every foreign-key cascade path and the current_org_ids lookup", () => {
    expect(HARDENING).toContain("on public.organization_memberships (user_id);");
    expect(HARDENING).toContain("on public.clinic_memberships (organization_id, membership_id);");
    expect(HARDENING).toContain("on public.clinic_memberships (organization_id, clinic_id);");
    expect(HARDENING).toContain("on public.invitations (organization_id);");
  });

  it("revokes the table-wide operations RLS does not cover", () => {
    for (const table of TABLES) {
      expect(HARDENING).toContain(
        `revoke truncate, references, trigger on public.${table} from anon, authenticated;`,
      );
    }
  });

  it("closes the profile-trigger function's PUBLIC execute grant", () => {
    expect(HARDENING).toContain(
      "revoke execute on function private.create_profile_for_new_user() from public;",
    );
  });
});
