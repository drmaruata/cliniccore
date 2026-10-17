-- Task 9a - RLS on the identity and tenancy tables.
--
-- Every table so far has been RLS-enabled with zero policies, which is deny-all:
-- safe and useless. These policies open exactly the paths a signed-in principal
-- needs and leave everything else closed.
--
-- Three rules hold across all four Task 9 migrations:
--
--   1. Every helper call is wrapped in (select ...) so it is an InitPlan, evaluated
--      once per statement rather than once per row. The clinic-scoped predicates
--      join organizations and role_permissions per candidate row otherwise.
--
--   2. RLS is enabled with NO FORCE, and these functions are SECURITY DEFINER owned
--      by postgres. That is what lets private.can read user_role_assignments and
--      roles from inside a policy on those same tables instead of recursing. It is
--      also why every one of those helpers must check membership itself - a
--      policy is not a backstop for a definer function.
--
--   3. Policy DDL is guarded in a DO block against pg_catalog. A bare
--      IF NOT EXISTS on CREATE POLICY is rejected with SQLSTATE 42601.

-- profiles is not organization-scoped: a user must be able to read and edit their
-- own row before they belong to anything. It gets no INSERT policy at all, because
-- rows are created by the auth.users trigger - and a client INSERT would be the
-- INSERT-side route to is_platform_admin, which the UPDATE-only guard trigger does
-- not cover.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'profiles'
                    and policyname = 'profiles_select_self') then
    create policy profiles_select_self on public.profiles
      for select to authenticated
      using (id = (select auth.uid()));
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'profiles'
                    and policyname = 'profiles_update_self') then
    create policy profiles_update_self on public.profiles
      for update to authenticated
      using (id = (select auth.uid()))
      with check (
        id = (select auth.uid())
        and is_platform_admin is not true
      );
  end if;
end
$$;

-- organizations: membership OR platform. The platform branch is not decoration.
-- private.is_member joins organizations for status = 'active', so suspending a
-- tenant makes is_member false for its own members - and an operator reading the
-- tenant directory through is_member alone would see zero rows, including the
-- suspended tenants they exist to restore.
--
-- No INSERT policy: organizations are created by private.create_organization_with_owner,
-- which is a definer and does not depend on this table being writable. No DELETE
-- policy either.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organizations'
                    and policyname = 'organizations_select') then
    create policy organizations_select on public.organizations
      for select to authenticated
      using (private.is_member(id) or (select private.is_platform_admin()));
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organizations'
                    and policyname = 'organizations_update') then
    create policy organizations_update on public.organizations
      for update to authenticated
      using (private.is_member(id) or (select private.is_platform_admin()))
      with check (private.is_member(id) or (select private.is_platform_admin()));
  end if;
end
$$;

-- organization_memberships: any member may read the roster, and may update rows in
-- their own organization. INSERT and DELETE stay closed - adding and removing staff
-- is an invitation and staff.manage operation, not a direct table write, and
-- closing them here is what stops a tenant from manufacturing a membership for
-- themselves in an organization they do not belong to.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organization_memberships'
                    and policyname = 'organization_memberships_select') then
    create policy organization_memberships_select on public.organization_memberships
      for select to authenticated
      using (private.is_member(organization_id));
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organization_memberships'
                    and policyname = 'organization_memberships_update') then
    create policy organization_memberships_update on public.organization_memberships
      for update to authenticated
      using (private.is_member(organization_id))
      with check (private.is_member(organization_id));
  end if;
end
$$;