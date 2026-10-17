-- Task 7 addendum: close the second route to the platform escalation, and make a
-- suspended tenant actually suspended.
--
-- Two review findings, both closed here rather than by editing an applied
-- migration (the Task 5 edit exception closed once 00300 landed, so from here on
-- corrections are new files).
--
-- 1. private.can was scope-blind to the permission key. `permissions` is one
--    global table holding all 21 keys, four of them platform-scoped, and
--    role_permissions carries no scope column, so a tenant that attached
--    platform.tenants.manage to one of its OWN roles would satisfy
--    can(org, 'platform.tenants.manage'). Task 7's first fix made can org-strict,
--    which closed the platform-ROLE route but not this one: the role genuinely
--    belongs to the organization. can() now refuses platform.* keys outright.
--    That is the same invariant the header already states - platform authority
--    is the profiles.is_platform_admin boolean, and platform operators reach
--    tenants through a separate function - so making the code enforce it beats
--    relying on the seed never emitting such a grant.
--
-- 2. organizations.status existed and was read by nothing. Suspending or
--    archiving a tenant therefore left can() and clinic_ids() returning exactly
--    what they returned before, which undercuts platform.tenants.manage's own
--    description ("Suspend, archive and support any tenant"). Membership-level
--    status was already honoured; organization-level was not. All four helpers
--    now require organizations.status = 'active', which closes is_member,
--    clinic_ids and current_org_ids together - and can(), because it already
--    requires is_member.

create or replace function private.current_org_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $fn$
  select m.organization_id
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and o.status = 'active';
$fn$;

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
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and o.status = 'active'
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
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and o.status = 'active'
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
  select p_permission not like 'platform.%'
     and (select private.is_member(p_org_id))
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
