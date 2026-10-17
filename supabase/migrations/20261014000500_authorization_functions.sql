-- Task 7: the authorization functions every RLS policy calls.
--
-- Four helpers in the private schema, all SECURITY DEFINER because each reads
-- tables the calling role cannot see - that is what breaks the RLS recursion a
-- policy would otherwise hit when it asks "may this user see this row" - and all
-- STABLE because a single statement may call them many times. search_path is
-- pinned to '' on every one, so each reference is schema-qualified.
--
-- private.can is the only entry point for a permission check and it must NOT
-- consult private.is_platform_admin. Platform operators reach tenants through a
-- separate function; granting them can() would expose every tenant's patient
-- records, which the spec forbids as excessive privilege. Platform authority is
-- the profiles.is_platform_admin boolean and nothing else.
--
-- private.can admits ONLY roles of the organization being asked about
-- (r.organization_id = p_org_id), so a platform role is unreachable through it.
-- That is deliberate and load-bearing, not a simplification: staff.manage holders
-- may insert an invitation naming a platform role, and the accept flow turns that
-- into an assignment. Admitting platform roles here would hand a tenant
-- principal platform.tenants.manage and the rest of the platform matrix, which
-- is an escalation even though profiles.is_platform_admin stays false. Platform
-- operators therefore hold their role for the separate platform function, not
-- for can().
--
-- Clinic scope: an assignment with clinic_id NULL covers the whole organization
-- and one with a clinic_id covers only that clinic, so can()'s predicate reduces
-- to (assignment.clinic_id IS NULL OR assignment.clinic_id = p_clinic_id). When
-- p_clinic_id is NULL only org-wide assignments can satisfy it - a
-- clinic-scoped assignment must not answer a question asked about the whole
-- organization. clinic_ids() is the separate question "which clinics may this
-- caller reach at all", and it returns the whole organization only when the
-- caller is an active member with no clinic scoping; a non-member gets the empty
-- set rather than every clinic.
--
-- clinic_ids() deliberately does NOT filter on clinics.is_active. A deactivated
-- clinic's records carry retention obligations, and hiding them would make a
-- deactivation erase access to history; deactivation is a scheduling concern and
-- visibility is a record-retention concern, so they stay separate.

create or replace function private.is_member(p_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$fn$;

create or replace function private.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$fn$;

create or replace function private.clinic_ids(p_org_id uuid)
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $fn$
  with mine as (
    select m.id
    from public.organization_memberships m
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ),
  scoped as (
    select cm.clinic_id
    from public.clinic_memberships cm
    join mine on mine.id = cm.membership_id
  )
  select c.id
  from public.clinics c
  where c.organization_id = p_org_id
    and exists (select 1 from mine)
    and (
      (select count(*) from scoped) = 0
      or c.id in (select clinic_id from scoped)
    );
$fn$;

create or replace function private.can(p_org_id uuid, p_permission text, p_clinic_id uuid default null)
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select (select private.is_member(p_org_id))
     and exists (
       select 1
       from public.user_role_assignments a
       join public.role_permissions rp on rp.role_id = a.role_id
       join public.roles r on r.id = a.role_id
       where a.organization_id = p_org_id
         and a.user_id = (select auth.uid())
         and rp.permission_key = p_permission
         and r.organization_id = p_org_id
         and (a.clinic_id is null or a.clinic_id = p_clinic_id)
     );
$fn$;

revoke execute on function private.is_member(uuid) from public;
grant execute on function private.is_member(uuid) to authenticated;

revoke execute on function private.is_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function private.clinic_ids(uuid) from public;
grant execute on function private.clinic_ids(uuid) to authenticated;

revoke execute on function private.can(uuid, text, uuid) from public;
grant execute on function private.can(uuid, text, uuid) to authenticated;
