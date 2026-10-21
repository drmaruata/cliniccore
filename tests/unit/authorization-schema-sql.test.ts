import { describe, expect, it } from "vitest";

import {
  ALL_MIGRATION_SQL as ALL,
  latestDefinition,
  readMigration as read,
} from "../helpers/migration-text";

/*
 * Task 7 - authorization invariants.
 *
 * The migrations are the source of truth and vitest cannot reach the database,
 * so these assertions guard the SQL text for the properties the live catalogue
 * was measured against: the nulls-not-distinct uniques, the composite clinic
 * foreign key, RLS per table, the role org-scope guard, and the four helpers'
 * security properties.
 *
 * Function bodies are read through `latestDefinition`, which models what
 * Postgres actually does with `create or replace`: the LAST definition in
 * filename order wins. A later correction migration therefore supersedes the
 * earlier file rather than being missed by it - the mistake that would happen if
 * these tests read 00500 directly once a correction file exists.
 *
 * Two assertions here are prohibitions rather than shapes, because both mistakes
 * leave a function that still works: private.can must never mention
 * private.is_platform_admin, and must never admit a NULL-organization role or a
 * platform.* permission key. Either would hand a tenant principal platform
 * authority while profiles.is_platform_admin stayed false.
 */

const SCHEMA = read("20261014000400_authorization.sql");

const HELPERS = ["is_member", "is_platform_admin", "clinic_ids", "can"];
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

describe("authorization helper functions", () => {
  it("makes every helper a stable security-definer with an empty search_path", () => {
    for (const name of HELPERS) {
      const body = latestDefinition(name);
      expect(body, `${name} must be SECURITY DEFINER`).toContain("security definer");
      expect(body, `${name} must be STABLE`).toContain("stable");
      expect(body, `${name} must pin search_path`).toContain("set search_path = ''");
    }
  });

  it("closes each helper's grants to authenticated only", () => {
    for (const name of HELPERS) {
      expect(ALL).toContain(`revoke execute on function private.${name}(`);
      expect(ALL).toContain(`grant execute on function private.${name}(`);
    }
  });

  it("requires the organization to be active before granting anything", () => {
    // organizations.status existed but was read by nothing, so suspending a
    // tenant left can() and clinic_ids() returning exactly what they returned
    // before - which undercuts platform.tenants.manage's own description.
    //
    // THE MEMBERSHIP RULE - "an active membership in an active organization" - lives
    // in `private.is_member_for` and NOWHERE ELSE. `is_member`, `current_org_ids` and
    // `clinic_ids` all ASK it, so the three of them cannot drift apart: a copy of the
    // rule in any one of them is a second version of the question, and the version
    // that drifts is the one nobody looks at.
    //
    // `clinic_ids` used to re-derive it - its `mine` CTE joined memberships to
    // organizations and checked both statuses - and the unit assertion PINNED the
    // duplicate, which made the duplication a requirement rather than an accident.
    expect(latestDefinition("is_member_for")).toContain("o.status = 'active'");
    expect(latestDefinition("is_member")).toContain(
      "private.is_member_for((select auth.uid()), p_org_id)",
    );
    expect(latestDefinition("current_org_ids")).toContain(
      "private.is_member_for((select auth.uid()), o.id)",
    );
    expect(latestDefinition("clinic_ids")).toContain(
      "private.is_member_for((select auth.uid()), p_org_id)",
    );
    // And none of them re-derives it.
    for (const name of ["is_member", "current_org_ids", "clinic_ids"]) {
      expect(
        latestDefinition(name),
        `${name} must not re-derive the membership rule`,
      ).not.toContain("m.status = 'active'");
    }
  });
});

describe("private.can scope", () => {
  // The rule lives in `private.can_for`, which takes the user as a parameter so that
  // the invitation path can ask it about the INVITER; `private.can` delegates to it
  // with `auth.uid()`. The assertions below read the rule where it lives AND pin the
  // delegation, because a second copy of this rule is how the platform-key clause came
  // to exist twice and drift once.
  const rule = () => latestDefinition("can_for");

  it("never consults platform administration", () => {
    expect(rule()).not.toContain("is_platform_admin");
  });

  it("refuses platform.* keys, whoever attached them and whatever the case", () => {
    // permissions is one global table with no scope column, so a tenant could
    // attach platform.tenants.manage to its OWN role and satisfy the org check.
    // lower() because the grant match is exact text: without it a key spelled
    // `Platform.tenants.manage` would both insert and match.
    expect(rule()).toContain("lower(p_permission) not like 'platform.%'");
  });

  it("admits only the organization's own roles, never a platform role", () => {
    const body = rule();
    expect(body).toContain("and r.organization_id = p_org_id");
    expect(body).not.toContain("r.organization_id is null");
  });

  it("is bound to the user it is asked about", () => {
    // Without this the function degenerates into "does any member of this org
    // hold this permission", handing patients.read to everyone in an org that
    // has a doctor role. The CALLER is bound by the delegation, below.
    expect(rule()).toContain("and a.user_id = p_user_id");
  });

  it("requires an active membership and honours clinic scope", () => {
    const body = rule();
    expect(body).toContain("(select private.is_member_for(p_user_id, p_org_id))");
    // When p_clinic_id is NULL only an org-wide assignment can satisfy it.
    expect(body).toContain("and (a.clinic_id is null or a.clinic_id = p_clinic_id)");
  });

  it("is reached through a delegation that binds the caller", () => {
    // The wrapper adds no decision of its own, so the rule cannot be re-implemented
    // in it - and the binding to the calling user is here rather than in the rule.
    expect(latestDefinition("can")).toContain(
      "private.can_for((select auth.uid()), p_org_id, p_permission, p_clinic_id)",
    );
  });
});

describe("private.clinic_ids reach", () => {
  it("returns no clinics to a non-member", () => {
    expect(latestDefinition("clinic_ids")).toContain("and exists (select 1 from mine)");
  });

  it("never hides a deactivated clinic's retained records", () => {
    // Deactivating a clinic is a scheduling concern; its records carry retention
    // obligations, so filtering them here would erase access to history.
    expect(latestDefinition("clinic_ids")).not.toContain("is_active");
  });
});
