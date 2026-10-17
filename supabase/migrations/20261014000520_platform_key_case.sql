-- Task 7 addendum: refuse platform keys regardless of case.
--
-- Task 7's fix round 2 made private.can refuse platform.* keys, which closed the
-- escalation route where a tenant attached a platform permission to one of its own
-- roles. That refusal was case-SENSITIVE while the grant match is exact text, so a
-- key spelled `Platform.tenants.manage` would both insert and match.
--
-- The chain needs `permissions` to be writable by authenticated - and it is a
-- reference table that Task 9 must leave deny-all or read-only - so this is
-- defence in depth rather than a live hole today. It is enforced here anyway
-- because this exact escalation was found twice already (Task 7 review rounds 1
-- and 2), and because a guard that only holds while a future policy happens to
-- behave is not a guard.
--
-- lower() can only ever refuse more: a legitimate platform key is still refused,
-- and a case-varied request cannot match a seeded grant either.

create or replace function private.can(p_org_id uuid, p_permission text, p_clinic_id uuid default null)
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select lower(p_permission) not like 'platform.%'
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
