-- Task 7: authorization schema and the platform permission seed.
--
-- The four tables every permission check reads: permissions (the keys the
-- registry defines), roles (one row per organization, plus platform roles at
-- organization_id NULL), role_permissions (the role x permission matrix) and
-- user_role_assignments (who holds which role, optionally scoped to one clinic).
--
-- Tenant isolation is structural, not procedural, so the two integrity rules
-- that matter are expressed as constraints rather than as checks in application
-- code:
--   * roles is unique nulls not distinct (organization_id, key). A plain unique
--     index treats NULLs as distinct, so the platform row would never conflict,
--     on conflict (organization_id, key) would never fire for it, and re-seeding
--     would duplicate it.
--   * user_role_assignments is unique nulls not distinct on the same principle
--     for its nullable clinic_id: without it an org-wide assignment never
--     conflicts and an on conflict do nothing cannot dedupe it. Its clinic_id
--     carries a COMPOSITE foreign key to clinics (organization_id, id). MATCH
--     SIMPLE does not enforce such a key when any column is NULL, so an org-wide
--     row (clinic_id NULL) stays unconstrained while a clinic-scoped row must
--     name a clinic in its own organization.
--
-- private.guard_role_org_scope() closes what no foreign key can express: the
-- referenced role must belong to the row's organization, or be a platform role.
-- A composite foreign key cannot carry "platform role OR same organization"
-- because roles.organization_id is NULL for platform roles and a composite key
-- never matches NULL. The NULL allowance is deliberate - platform roles confer
-- no organization-scoped authority, and platform authority is the
-- profiles.is_platform_admin boolean rather than any role - so this must not be
-- tightened into a strict organization match.
--
-- The platform permission seed at the foot of this file is GENERATED from
-- lib/permissions/registry.ts and inlined rather than applied by a script: a Node
-- script cannot reach the MCP applier, and the emitted statements carry
-- on-conflict clauses, so re-running this migration is how the seed is
-- refreshed. tests/unit/permissions-seed.test.ts fails if the block below drifts
-- from the registry.
--
-- RLS is enabled here (deny-all, no policies) with policies in Task 10, for the
-- same reason as Task 6: Supabase grants anon/authenticated access to new public
-- tables by default, so a table created here without RLS is reachable through
-- PostgREST in the meantime. The table-wide privileges RLS does not cover are
-- revoked from the default ACL instead of per table, so later migrations need no
-- per-table revokes. Note that a default ACL binds only objects created by the
-- role that issued the statement - here postgres, which is what the MCP applier
-- uses. A table created by any other role would not inherit it.
--
-- Two referential decisions worth stating rather than leaving to be discovered:
--   * invitations_role_id_fkey is ON DELETE CASCADE. Without it, deleting an
--     organization cascades to its roles and then fails, because the invitations
--     being deleted in the same cascade may still reference them. The cost is
--     that deleting a role voids its pending invitations.
--   * user_role_assignments_clinic_fkey is ON DELETE NO ACTION, so deleting a
--     clinic raises once any assignment names it. Clinics are deactivated
--     (clinics.is_active), not deleted; a hard delete must clear assignments
--     first. This is deliberately the fail-safe direction.

alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

create table if not exists public.permissions (
  key text primary key,
  description text not null
);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  key text not null,
  name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, key)
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete cascade,
  clinic_id uuid,
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, user_id, role_id, clinic_id),
  constraint user_role_assignments_clinic_fkey
    foreign key (organization_id, clinic_id) references public.clinics (organization_id, id)
);

alter table public.permissions enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_role_assignments enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'invitations_role_id_fkey'
      and conrelid = 'public.invitations'::regclass
  ) then
    alter table public.invitations
      add constraint invitations_role_id_fkey
      foreign key (role_id) references public.roles (id) on delete cascade;
  end if;
end
$$;

create or replace function private.guard_role_org_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_role_org uuid;
begin
  select r.organization_id into v_role_org from public.roles r where r.id = new.role_id;

  if v_role_org is distinct from new.organization_id and v_role_org is not null then
    raise exception 'role % belongs to another organization', new.role_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke execute on function private.guard_role_org_scope() from public;
grant execute on function private.guard_role_org_scope() to authenticated;

drop trigger if exists guard_role_org_scope on public.invitations;
create trigger guard_role_org_scope
  before insert or update on public.invitations
  for each row execute function private.guard_role_org_scope();

drop trigger if exists guard_role_org_scope on public.user_role_assignments;
create trigger guard_role_org_scope
  before insert or update on public.user_role_assignments
  for each row execute function private.guard_role_org_scope();

-- BEGIN GENERATED PLATFORM SEED
-- Generated by scripts/gen-permissions-sql.ts. Do not edit by hand.
-- Scope: platform (seeded once; organization_id is null)
-- Source of truth: lib/permissions/registry.ts. Change the registry, regenerate.

insert into public.permissions (key, description) values
  ('appointments.manage', 'Book, reschedule, cancel and confirm appointments'),
  ('audit.read', 'Read the organization audit log'),
  ('billing.manage', 'Create invoices, record payments and issue refunds'),
  ('encounters.read', 'View clinical encounter records'),
  ('encounters.write', 'Create, edit and finalize clinical encounter records'),
  ('inventory.manage', 'Manage stock, batches, suppliers and adjustments'),
  ('investigations.order', 'Order laboratory and diagnostic investigations'),
  ('investigations.verify', 'Verify and release laboratory and diagnostic results'),
  ('patients.create', 'Register new patients'),
  ('patients.export', 'Export patient data from the organization'),
  ('patients.read', 'View patient records'),
  ('patients.update', 'Edit patient demographic and clinical details'),
  ('platform.audit.read', 'Read platform-level audit events'),
  ('platform.subscriptions.manage', 'Manage any tenant subscription state'),
  ('platform.tenants.manage', 'Suspend, archive and support any tenant'),
  ('platform.tenants.read', 'View the platform tenant directory'),
  ('prescriptions.create', 'Create and sign prescriptions'),
  ('reports.view', 'View operational and clinical reports'),
  ('settings.manage', 'Change organization, clinic and application settings'),
  ('staff.manage', 'Invite staff, assign clinics and grant roles'),
  ('subscription.manage', 'View and change the organization subscription')
on conflict (key) do update set description = excluded.description;

insert into public.roles (organization_id, key, name, is_system) values
  (null, 'platform_super_admin', 'Platform Super Admin', true)
on conflict (organization_id, key) do update
  set name = excluded.name, is_system = excluded.is_system;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from (values
  ('platform_super_admin', 'platform.audit.read')
  ,
  ('platform_super_admin', 'platform.subscriptions.manage')
  ,
  ('platform_super_admin', 'platform.tenants.manage')
  ,
  ('platform_super_admin', 'platform.tenants.read')
) as seed(role_key, permission_key)
join public.roles r on r.organization_id is null and r.key = seed.role_key
join public.permissions p on p.key = seed.permission_key
on conflict (role_id, permission_key) do nothing;
-- END GENERATED PLATFORM SEED
