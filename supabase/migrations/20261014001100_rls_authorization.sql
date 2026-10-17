-- Task 9c - RLS on the authorization tables.
--
-- These four tables are where privilege escalation would live, so every policy
-- here is a statement about who may mint authority rather than who may read rows.

-- permissions is the registry's reference table, seeded once by migration and
-- re-seeded by private.create_organization_with_owner (a definer, so it does not
-- need this table to be writable). authenticated holds table-level INSERT on it by
-- default, and a tenant able to insert a key is the whole reason private.can
-- bothers to lower-case its argument: a key spelled Platform.tenants.manage would
-- otherwise both insert and match. Read-only, enforced by policy AND by grant.
revoke insert, update, delete on public.permissions from authenticated;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'permissions'
                    and policyname = 'permissions_select') then
    create policy permissions_select on public.permissions
      for select to authenticated
      using (true);
  end if;
end
$$;

-- roles must never become tenant-writable in a way that reaches platform scope.
-- private.guard_role_org_scope deliberately permits a platform role in ANY
-- organization, so without an 'organization_id is not null' floor here a tenant
-- admin could create an organization_id-null role and assign it to anyone.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_select') then
    create policy roles_select on public.roles
      for select to authenticated
      using (organization_id in (select private.current_org_ids()));
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_write') then
    create policy roles_write on public.roles
      for insert to authenticated
      with check (
        organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_update') then
    create policy roles_update on public.roles
      for update to authenticated
      using (organization_id in (select private.current_org_ids()))
      with check (
        organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_delete') then
    -- DELETE has no WITH CHECK: the USING clause is the only filter, so it must
    -- carry the whole predicate.
    create policy roles_delete on public.roles
      for delete to authenticated
      using (
        organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      );
  end if;
end
$$;

-- role_permissions has no organization_id column of its own, so every policy on it
-- has to reach the organization THROUGH roles. That subquery runs as authenticated
-- and is therefore subject to the roles policies above - which is the intended
-- fail-closed intersection, not an accident.
--
-- The permission_key floor is lower-cased for the same reason private.can's is: a
-- plain 'not like 'platform.%'' would admit Platform.tenants.manage and leave the
-- case-variant defence to be the only thing standing between it and a match.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'role_permissions'
                    and policyname = 'role_permissions_select') then
    create policy role_permissions_select on public.role_permissions
      for select to authenticated
      using (
        exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id in (select private.current_org_ids())
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'role_permissions'
                    and policyname = 'role_permissions_write') then
    create policy role_permissions_write on public.role_permissions
      for insert to authenticated
      with check (
        lower(permission_key) not like 'platform.%'
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id in (select private.current_org_ids())
             and private.can(r.organization_id, 'settings.manage')
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'role_permissions'
                    and policyname = 'role_permissions_update') then
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
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'role_permissions'
                    and policyname = 'role_permissions_delete') then
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
      );
  end if;
end
$$;

-- user_role_assignments is clinic-scoped AND the one table every principal must be
-- able to read their own row of, or the app cannot render what they may do. So the
-- SELECT predicate is "my own assignments, or the ones an org-wide staff manager
-- may see".
--
-- The staff branch deliberately uses the TWO-ARGUMENT can() paired with an explicit
-- NULL-tolerant reach clause. The three-clause conjunction fails closed for
-- org-wide assignments, which is right for clinical data but wrong here: an
-- org-wide administrator must see the clinic-scoped assignments of their own staff,
-- and rows where clinic_id is null have no clinic to pass. The reach dimension is
-- supplied by the 'clinic_id is null or ...' clause instead, which keeps the same
-- two-authority shape without dropping either one.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_select') then
    create policy user_role_assignments_select on public.user_role_assignments
      for select to authenticated
      using (
        user_id = (select auth.uid())
        or (
          organization_id in (select private.current_org_ids())
          and private.can(organization_id, 'staff.manage')
          and (clinic_id is null
               or clinic_id in (select private.clinic_ids(organization_id)))
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_write') then
    create policy user_role_assignments_write on public.user_role_assignments
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_update') then
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
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_delete') then
    create policy user_role_assignments_delete on public.user_role_assignments
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
      );
  end if;
end
$$;