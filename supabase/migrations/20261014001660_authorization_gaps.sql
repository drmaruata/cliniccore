-- Close the authorization gaps that survived: self-suspension, privilege pre-staging, and a
-- platform administrator's own profile row.
--
-- Every finding below was MEASURED, not inferred, and the measurements that disagree with
-- the old records are noted.
--
-- ---------------------------------------------------------------------------
-- A2. A settings.manage HOLDER CAN SUSPEND THEIR OWN TENANT.
--
-- MEASURED, as a settings.manage holder:
--
--   update public.organizations set status = 'suspended' where id = <their org>;
--
-- is ALLOWED, and the tenant then VANISHES from every subsequent query. The reason is
-- `private.current_org_ids()`, which joins organizations for `status = 'active'`: once the
-- org is suspended the holder is no longer a member of it, so they cannot read it, cannot
-- reactivate it, and cannot see that it exists. It is not a denial, it is a disappearance.
--
-- The reviewer disagreed with the previous reasoning that "RLS cannot express a column
-- rule", and was right: `private.guard_role_identity` is already exactly this pattern - a
-- BEFORE UPDATE trigger that refuses a change the caller may not make - so a
-- `private.guard_organization_status` in the same shape closes this without touching a
-- single grant and without breaking the operator's restore path.
--
-- The operator's SUSPEND and RESTORE both still work, because a platform administrator is
-- exempt. That is the point: the operation is a platform operation, and the guard says so
-- in the one place that can enforce it.
--
-- ---------------------------------------------------------------------------
-- A3. PRIVILEGE PRE-STAGING.
--
-- MEASURED: as a staff.manage holder,
--
--   insert into public.user_role_assignments (organization_id, user_id, role_id)
--   values (<their org>, <a user id belonging to NO organization>, <a role>);
--
-- is ALLOWED. The assignment is inert until that account gains membership by ANY route -
-- including the invitation-acceptance RPC - and then it is live, with no grant step in
-- between. Writing the assignment only for a user who is ALREADY an active member of the
-- organization closes it, and it does not break the legitimate flow: the acceptance RPC
-- creates the membership and the assignment together, in that order, so the target is a
-- member by the time the assignment is written.
--
-- The helper is SECURITY DEFINER because the writer is not the target: a staff.manage
-- holder legitimately assigns a role to somebody else, and cannot read that person's
-- memberships under RLS. The function returns a boolean and is only ever used in a policy,
-- so it discloses nothing.
--
-- ---------------------------------------------------------------------------
-- A5. A PLATFORM ADMINISTRATOR CANNOT EDIT THEIR OWN profiles ROW.
--
-- MEASURED: `update public.profiles set full_name = ... where id = <their own id>` is
-- REFUSED, because `profiles_update_self`'s WITH CHECK carries `is_platform_admin IS NOT
-- TRUE`. The intent was to stop a user flipping their own flag, and it does - but it also
-- stops the operator from fixing their own name, which is the safe direction to refuse and
-- was always recorded as cosmetic.
--
-- The flag itself does not need the policy to protect it: `private.guard_platform_admin`
-- is already a trigger that refuses a change to `is_platform_admin` by anyone who is not
-- `service_role`. So the policy can simply stop second-guessing the trigger.
--
-- ---------------------------------------------------------------------------
-- A1 and A4, re-measured: BOTH ARE ALREADY CLOSED, and the records were stale.
--
-- A1 (a staff.manage holder self-granting `organization_owner`) is REFUSED at the first
-- statement, because `private.can_grant` - rewritten in 01240 - requires the granter to
-- hold EVERY permission of the role being granted. The old record predates that.
--
-- A4 (a platform operator writing an org-scoped audit row for a tenant they are not a
-- member of) is ALLOWED, because `public.write_audit` - added with the public RPC surface
-- - delegates to `private.write_audit`, which exempts a platform administrator. The old
-- record predates the public surface.
--
-- Both are closed by code that already existed, so what they need is a REGRESSION TEST, and
-- that is in tests/integration/authorization-gaps.test.ts rather than here.

-- ---------------------------------------------------------------------------
-- 1. A2. The status guard.

create or replace function private.guard_organization_status()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status is distinct from old.status
     and not (select private.is_platform_admin()) then
    raise exception 'only a platform administrator may change a tenant''s status; suspending your own tenant would hide it from you'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

comment on function private.guard_organization_status() is
  'Refuses a status change on organizations by anyone who is not a platform administrator. Without it a settings.manage holder can suspend their own tenant, which then vanishes from every query because current_org_ids only counts active organizations.';

drop trigger if exists organizations_guard_status on public.organizations;
create trigger organizations_guard_status
  before update on public.organizations
  for each row execute function private.guard_organization_status();

-- ---------------------------------------------------------------------------
-- 2. A3. The target must already be a member.

create or replace function private.assignment_target_is_member(
  p_org_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.organization_memberships m
     where m.organization_id = p_org_id
       and m.user_id = p_user_id
       and m.status = 'active'
  );
$fn$;

comment on function private.assignment_target_is_member(uuid, uuid) is
  'Whether the user an assignment names is already an active member of the organization. Without it an assignment can be pre-staged for an account that belongs to no organization, and it becomes live the moment that account joins by any route.';

-- The policies are recreated because a WITH CHECK cannot be added to an existing policy.
drop policy if exists user_role_assignments_write on public.user_role_assignments;
create policy user_role_assignments_write
  on public.user_role_assignments
  for insert
  with check (
    (organization_id in (select private.current_org_ids()))
    and private.can(organization_id, 'staff.manage'::text)
    and ((clinic_id is null) or (clinic_id in (select private.clinic_ids(user_role_assignments.organization_id))))
    and private.can_grant(organization_id, role_id)
    and private.assignment_target_is_member(organization_id, user_id)
    and (exists (
      select 1
        from public.roles r
       where r.id = user_role_assignments.role_id
         and r.organization_id is not null
         and r.organization_id = user_role_assignments.organization_id
    ))
  );

drop policy if exists user_role_assignments_update on public.user_role_assignments;
create policy user_role_assignments_update
  on public.user_role_assignments
  for update
  using (
    (organization_id in (select private.current_org_ids()))
    and private.can(organization_id, 'staff.manage'::text)
    and ((clinic_id is null) or (clinic_id in (select private.clinic_ids(user_role_assignments.organization_id))))
  )
  with check (
    (organization_id in (select private.current_org_ids()))
    and private.can(organization_id, 'staff.manage'::text)
    and ((clinic_id is null) or (clinic_id in (select private.clinic_ids(user_role_assignments.organization_id))))
    and private.can_grant(organization_id, role_id)
    and private.assignment_target_is_member(organization_id, user_id)
    and (exists (
      select 1
        from public.roles r
       where r.id = user_role_assignments.role_id
         and r.organization_id is not null
         and r.organization_id = user_role_assignments.organization_id
    ))
  );

-- ---------------------------------------------------------------------------
-- 3. A5. A platform administrator may edit their own profile row.
--
-- The flag is protected by the `private.guard_platform_admin` TRIGGER, which refuses a
-- change to `is_platform_admin` by anyone who is not `service_role`. The policy does not
-- need to second-guess it, and its `is_platform_admin IS NOT TRUE` clause was refusing a
-- harmless update of the operator's own row.

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles
  for update
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
