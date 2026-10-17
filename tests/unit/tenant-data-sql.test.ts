import { describe, expect, it } from "vitest";

import {
  ALL_MIGRATION_SQL as ALL,
  latestDefinition,
  readMigration as read,
} from "../helpers/migration-text";

/*
 * Task 8 - tenant data, audit and platform invariants.
 *
 * patients is the first table holding PHI, so the assertions that matter most are
 * the composite foreign keys: a patient row must not be attachable to another
 * organization's clinic, and an identifier must not point at another
 * organization's patient. audit_logs is the opposite requirement - it must NOT
 * have foreign keys at all, because a cascade would erase the trail when the
 * tenant or the actor is deleted, which is exactly when you most want it.
 */

const TENANT_DATA = read("20261014000700_tenant_data.sql");
const AUDIT = read("20261014000800_audit_and_platform.sql");

describe("tenant data schema", () => {
  it("declares the three tenant-data tables and enables RLS on each", () => {
    for (const table of ["patients", "patient_identifiers", "tenant_sequences"]) {
      expect(TENANT_DATA).toContain(`create table if not exists public.${table} (`);
      expect(TENANT_DATA).toContain(`alter table public.${table} enable row level security;`);
    }
    expect(TENANT_DATA.match(/enable row level security/g)).toHaveLength(3);
  });

  it("scopes a patient to a clinic in its own organization by composite key", () => {
    expect(TENANT_DATA).toContain(
      "constraint patients_clinic_fkey foreign key (organization_id, clinic_id) references public.clinics (organization_id, id)",
    );
    expect(TENANT_DATA).toContain("unique (organization_id, id)");
    expect(TENANT_DATA).toContain("unique (organization_id, clinic_id, mrn)");
  });

  it("keeps mrn text, with no sequence anywhere in the file", () => {
    // A sequence would make identifiers enumerable across tenants and would
    // hard-code a format into the schema. next_sequence_value is per-tenant and
    // returns bigint for the application to format.
    expect(TENANT_DATA).toContain("mrn text not null");
    expect(TENANT_DATA).not.toContain("create sequence");
    expect(TENANT_DATA).not.toContain("nextval");
  });

  it("restricts an identifier's parent rather than cascading", () => {
    expect(TENANT_DATA).toContain(
      "constraint patient_identifiers_patient_fkey foreign key (organization_id, patient_id) references public.patients (organization_id, id) on delete restrict",
    );
    expect(TENANT_DATA).toContain("unique (organization_id, kind, value)");
  });

  it("indexes the identifier foreign key its own unique cannot serve", () => {
    expect(TENANT_DATA).toContain("on public.patient_identifiers (organization_id, patient_id)");
  });

  it("maintains patients.updated_at through the shared trigger", () => {
    expect(TENANT_DATA).toContain("create trigger set_updated_at before update on public.patients");
  });

  it("hands out sequence values atomically", () => {
    const body = latestDefinition("next_sequence_value");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    // One upsert, not select-then-update: the conflicting branch row-locks the
    // existing row, so two concurrent callers cannot receive the same number.
    expect(body).toContain("on conflict (organization_id, sequence_key)");
    expect(body).toContain("do update set next_value = ts.next_value + 1");
    expect(body).not.toContain("select next_value");
    expect(ALL).toContain(
      "revoke execute on function private.next_sequence_value(uuid, text) from public;",
    );
    expect(ALL).toContain(
      "grant execute on function private.next_sequence_value(uuid, text) to authenticated;",
    );
  });
});

describe("audit log and platform settings", () => {
  it("creates both tables with RLS enabled and no foreign keys at all", () => {
    expect(AUDIT).toContain("create table if not exists public.audit_logs (");
    expect(AUDIT).toContain("create table if not exists public.platform_settings (");
    expect(AUDIT).toContain("alter table public.audit_logs enable row level security;");
    expect(AUDIT).toContain("alter table public.platform_settings enable row level security;");
    // Deliberate, and a whole-file prohibition on purpose: an audit trail must
    // outlive the tenant and the actor, so any cascade here would erase it exactly
    // when it matters. A future foreign key on these tables needs the ruling
    // revisited, not a test edit.
    expect(AUDIT).not.toContain("foreign key");
    expect(AUDIT).not.toContain("references public.");
    expect(AUDIT).not.toContain("references auth.");
  });

  it("revokes direct mutation of audit_logs, so append-only survives a bad policy", () => {
    // Supabase's default grants give authenticated INSERT/UPDATE/DELETE, and the
    // 00400 default-ACL revoke covers only truncate/references/trigger. Append-only
    // would otherwise rest entirely on Task 9 mistyping no update policy.
    expect(ALL).toContain(
      "revoke insert, update, delete on table public.audit_logs from anon, authenticated;",
    );
  });

  it("makes write_audit the only guarded writer of audit rows", () => {
    const body = latestDefinition("write_audit");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("insert into public.audit_logs");
    expect(body).toContain("(select auth.uid())");
    expect(ALL).toContain(
      "revoke execute on function private.write_audit(uuid, text, text, uuid, jsonb) from public;",
    );
    expect(ALL).toContain(
      "grant execute on function private.write_audit(uuid, text, text, uuid, jsonb) to authenticated;",
    );
  });

  it("refuses to write another tenant's trail", () => {
    // SECURITY DEFINER owned by postgres with relforcerowsecurity = false, so
    // this function bypasses RLS entirely: Task 9's policies are no backstop.
    // Without the guard any authenticated user could falsify another tenant's
    // audit history, with unconstrained action text.
    expect(latestDefinition("write_audit")).toContain(
      "if p_org_id is not null and not (select private.is_member(p_org_id)) then",
    );
    expect(latestDefinition("next_sequence_value")).toContain(
      "if not (select private.is_member(p_org_id)) then",
    );
  });

  it("bounds the metadata walk by size, not by depth", () => {
    const body = latestDefinition("write_audit");
    expect(body).toContain("octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192");
    // jsonb is a tree and cannot be cyclic, so the recursion terminates on its
    // own. The old `depth < 32` was not a safety net, only a hole.
    expect(body).not.toContain("w.depth");
  });

  it("walks objects AND arrays when screening metadata for free text", () => {
    const body = latestDefinition("write_audit");
    // A jsonpath wildcard silently skips array elements, so a
    // {"items":[{"note":...}]} payload passed a jsonpath check. The recursive
    // walk is why both accessors are present.
    expect(body).toContain("with recursive walk(obj) as (");
    expect(body).toContain("from jsonb_each(");
    expect(body).toContain("from jsonb_array_elements(");
    expect(body).toContain("lower(k) in ('note', 'notes', 'content')");
  });

  it("reserves platform-scoped audit events for platform administrators", () => {
    // Same reasoning that keeps private.can away from platform.* permissions: a
    // tenant must not be able to forge platform audit entries.
    expect(latestDefinition("write_audit")).toContain(
      "if p_org_id is null and not (select private.is_platform_admin()) then",
    );
  });
});

describe("onboarding RPC", () => {
  it("is a definer function with closed grants", () => {
    const body = latestDefinition("create_organization_with_owner");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("p_timezone text default 'asia/kolkata'");
    expect(ALL).toContain(
      "revoke execute on function private.create_organization_with_owner(text, text, text, text) from public;",
    );
    expect(ALL).toContain(
      "grant execute on function private.create_organization_with_owner(text, text, text, text) to authenticated;",
    );
  });

  it("requires an authenticated caller", () => {
    expect(latestDefinition("create_organization_with_owner")).toContain("if v_uid is null then");
  });

  it("creates the organization, the caller's membership and the first clinic", () => {
    const body = latestDefinition("create_organization_with_owner");
    expect(body).toContain("insert into public.organizations (id, name, slug, timezone)");
    expect(body).toContain("values (v_membership_id, v_org_id, v_uid, 'active');");
    expect(body).toContain("insert into public.clinics (id, organization_id, name, timezone)");
  });

  it("gives the owner an org-wide assignment, not a clinic-scoped one", () => {
    const body = latestDefinition("create_organization_with_owner");
    // No clinic_id in the column list: an owner administers the organization.
    expect(body).toContain(
      "insert into public.user_role_assignments (organization_id, user_id, role_id)",
    );
    expect(body).toContain("and r.key = 'organization_owner'");
  });
});
