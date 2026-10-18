-- Task 9 third-review fixes: the grant ceiling, the clear-all lockout, and the oracle.
--
-- HEADER CORRECTION FIRST, because a false statement is still sitting in 01230.
-- 01230 line 25 says "The intended workflow is unaffected: revoke the assignments,
-- then drop the role." That is wrong. private.role_in_use counts role_permissions
-- rows as well as assignments, so you must delete EVERY grant AND every assignment
-- before the role can go. Measured with two admins: remove the other admin's
-- assignment (1 row), then delete the role -> 0 rows, still blocked. That is the
-- THIRD false claim recorded as fact in this task, and the file is left unedited
-- because applied migrations are never edited - corrections are new files.
--
-- ---------------------------------------------------------------------------
-- 1. THE GRANT CEILING. I declined this twice, and both times on a premise I never
--    measured: that a subset ceiling "would break the legitimate admin-creates-owner
--    flow". Measurement refutes it. organization_owner and organization_admin carry
--    BYTE-IDENTICAL 17-permission sets - confirmed in the live database against a
--    tenant built by the real private.create_organization_with_owner (both sets
--    identical, owner-only keys: none). So an org_admin holding all seventeen passes
--    a subset ceiling completely unchanged, and the flow it was supposed to break
--    does not exist.
--
--    This was the top open CRITICAL and it was closable the whole time. I do not need
--    a role hierarchy; the registry's own grant-ceiling obligation is about the
--    CLIENT model, and this is the database half of the same rule.
--
--    Before the ceiling, measured as medical_director (staff.manage, no
--    settings.manage): assign organization_owner to self -> OK. Four statements
--    later it held settings.manage, patients.export and a rewritten slug.
create or replace function private.can_grant(p_org_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select not exists (
    select 1
      from public.role_permissions rp
     where rp.role_id = p_role_id
       and not private.can(p_org_id, rp.permission_key, null)
  );
$fn$;

-- The permission-level half, which the third review found and nobody had recorded: a
-- settings.manage holder could mint ANY key, including one its own role deliberately
-- withholds. Measured as clinic_admin: add subscription.manage to its own role,
-- assign it to itself -> OK. Two statements, and clinic_admin is a clinic-level
-- tenant role, so the blast radius is wider than the staff.manage one.
--
-- It is NOT a separate function: role_permissions has no organization_id column -
-- that is the entire reason its policies reach through roles - so the check is
-- private.can(r.organization_id, permission_key) inside the EXISTS below. One fewer
-- helper to keep correct, and it cannot be called with a mismatched organization.

-- Whether the caller personally holds this role. Used only to stop the role
-- editor's "clear all permissions" button from deleting the caller's own route to
-- the permission that button is protected by.
create or replace function private.assigned_to_self(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.user_role_assignments a
     where a.role_id = p_role_id
       and a.user_id = (select auth.uid())
  );
$fn$;

revoke execute on function private.can_grant(uuid, uuid) from public;
grant execute on function private.can_grant(uuid, uuid) to authenticated;
revoke execute on function private.assigned_to_self(uuid) from public;
grant execute on function private.assigned_to_self(uuid) to authenticated;

-- 2. THE CLEAR-ALL LOCKOUT, which 01230's guard missed because it was on the wrong
--    table for the invariant. Measured, single-member tenant, one statement:
--    delete from role_permissions where role_id = <own admin role> -> 3 rows gone.
--    Then can(settings.manage) is false, can(patients.read) is false, the role cannot
--    be deleted (role_in_use), the assignment cannot be removed (needs
--    staff.manage), and re-adding the grant or minting a replacement role is refused.
--    A tenant with zero grants and no client repair path - reached through a button
--    the role editor is going to ship.
create or replace function private.guard_role_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if private.role_in_use(old.id) then
    raise exception 'role % is still in use', old.key;
  end if;
  return old;
end;
$fn$;

revoke execute on function private.guard_role_delete() from public;

-- 3. THE ORACLE. private.role_in_use took a role_id and returned a boolean about
--    ANY role, so a member of one tenant could probe another's: measured, carol
--    (org B) reading true for an org A role, false for an unused one and true for
--    the platform role. It was the only helper whose answer was not scoped to
--    auth.uid(), and 01230 introduced it.
--
--    PostgreSQL does not check EXECUTE when invoking a TRIGGER function, so moving
--    the check out of the policy and into BEFORE DELETE removes the grant entirely.
--    Measured after the move: the delete raises "role org_admin is still in use",
--    a direct call returns permission denied, and an unused role still deletes.

drop policy if exists roles_delete on public.roles;
drop policy if exists user_role_assignments_write on public.user_role_assignments;
drop policy if exists user_role_assignments_update on public.user_role_assignments;
drop policy if exists role_permissions_write on public.role_permissions;
drop policy if exists role_permissions_update on public.role_permissions;
drop policy if exists role_permissions_delete on public.role_permissions;

do $do$
begin
  -- pg_catalog.pg_triggers does not exist on this PostgreSQL 17.11 build.
  if not exists (
    select 1
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'roles'
       and t.tgname = 'guard_role_delete_trigger'
  ) then
    create trigger guard_role_delete_trigger
      before delete on public.roles
      for each row execute function private.guard_role_delete();
  end if;

  -- role_in_use moved into the trigger, so the policy no longer needs it and the
  -- grant is revoked below.
  create policy roles_delete on public.roles
    for delete to authenticated
    using (
      organization_id is not null
      and organization_id in (select private.current_org_ids())
      and private.can(organization_id, 'settings.manage')
    );

  create policy user_role_assignments_write on public.user_role_assignments
    for insert to authenticated
    with check (
      organization_id in (select private.current_org_ids())
      and private.can(organization_id, 'staff.manage')
      and (clinic_id is null
           or clinic_id in (select private.clinic_ids(organization_id)))
      and private.can_grant(organization_id, role_id)
      and exists (
        select 1 from public.roles r
         where r.id = role_id
           and r.organization_id is not null
           and r.organization_id = user_role_assignments.organization_id
      )
    );

  create policy user_role_assignments_update on public.user_role_assignments
    for update to authenticated
    using (
      organization_id in (select private.current_org_ids())
      and private.can(organization_id, 'staff.manage')
      and (clinic_id is null
           or clinic_id in (select private.clinic_ids(organization_id)))
    )
    with check (
      organization_id in (select private.current_org_ids())
      and private.can(organization_id, 'staff.manage')
      and (clinic_id is null
           or clinic_id in (select private.clinic_ids(organization_id)))
      and private.can_grant(organization_id, role_id)
      and exists (
        select 1 from public.roles r
         where r.id = role_id
           and r.organization_id is not null
           and r.organization_id = user_role_assignments.organization_id
      )
    );

  create policy role_permissions_write on public.role_permissions
    for insert to authenticated
    with check (
      lower(permission_key) not like 'platform.%'
      -- role_permissions has NO organization_id column - that is the whole reason its
      -- policies reach through roles - so the ceiling is evaluated against the role's
      -- organization rather than a column that does not exist here.
      and exists (
        select 1 from public.roles r
         where r.id = role_id
           and r.organization_id is not null
           and r.organization_id in (select private.current_org_ids())
           and private.can(r.organization_id, 'settings.manage')
           and private.can(r.organization_id, permission_key)
      )
    );

  create policy role_permissions_update on public.role_permissions
    for update to authenticated
    using (
      lower(permission_key) not like 'platform.%'
      and exists (
        select 1 from public.roles r
         where r.id = role_id
           and r.organization_id is not null
           and r.organization_id in (select private.current_org_ids())
           and private.can(r.organization_id, 'settings.manage')
      )
    )
    with check (
      lower(permission_key) not like 'platform.%'
      and exists (
        select 1 from public.roles r
         where r.id = role_id
           and r.organization_id is not null
           and r.organization_id in (select private.current_org_ids())
           and private.can(r.organization_id, 'settings.manage')
           and private.can(r.organization_id, permission_key)
      )
    );

  create policy role_permissions_delete on public.role_permissions
    for delete to authenticated
    using (
      exists (
        select 1 from public.roles r
         where r.id = role_id
           and r.organization_id is not null
           and r.organization_id in (select private.current_org_ids())
           and private.can(r.organization_id, 'settings.manage')
      )
      -- You may not strip the grants from a role you hold yourself. Revoke your
      -- assignments first; then this passes and the role editor's clear-all works
      -- for every role you are not currently relying on.
      and not private.assigned_to_self(role_id)
    );
end
$do$;

revoke execute on function private.role_in_use(uuid) from authenticated;