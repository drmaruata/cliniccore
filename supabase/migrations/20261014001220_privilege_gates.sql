-- Task 9 review fixes - privilege gates, and the invariants the schema cannot carry.
--
-- Every change here came out of an independent review that EXECUTED each exploit
-- against the live database rather than reasoning about it, or of my own probe
-- doing the same. Corrections are new files, never edits, so 00900-01210 stand as
-- applied and this file supersedes five of their policies.
--
-- The common thread: a USING clause that was loose enough to be harmless only
-- because the WITH CHECK happened to be tight, or a WITH CHECK that was tight
-- enough to hide a row without ever being reached. Both read as safe on inspection.

-- 1. organization_memberships UPDATE. Gated on bare is_member, with is_member in
--    the WITH CHECK too.
--
--    This table IS the tenant boundary: current_org_ids, is_member and clinic_ids
--    all read it. Measured: a member holding NO role at all - zero permissions -
--    rewrote another member's row's user_id to an arbitrary auth.users id, 1 row
--    changed. The outsider then read the tenant's organizations, its clinics and
--    its entire staff roster. The attacker could equally restore a deliberately
--    revoked employee, or suspend the administrator who locked them out. No
--    audit_logs row: tenant writes to it were revoked in Task 8, so there was no
--    trace at all.
--
--    INSERT was already closed, and it was that closure's stated intent - "stops a
--    tenant from manufacturing a membership" - that UPDATE defeated. staff.manage
--    is the permission that means "manages staff", so it is the correct gate.
drop policy if exists organization_memberships_update on public.organization_memberships;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organization_memberships'
                    and policyname = 'organization_memberships_update') then
    create policy organization_memberships_update on public.organization_memberships
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
      );
  end if;
end
$$;

-- 2. organizations UPDATE. Also bare is_member. The plan specified is_member for
--    this table, which is right for SELECT and wrong for UPDATE, because the row
--    holds tenant-wide settings rather than tenancy facts.
--
--    Measured: a clinician with no permissions set currency to 'XXX' and timezone
--    to 'UTC'. Neither is cosmetic. Money is bigint minor units OF the tenant's
--    currency, so flipping currency relabels every stored amount in the product;
--    timezone is the input to the clinicDayBounds report windows, so it moves every
--    day boundary for the tenant; slug is the tenant's public identifier.
--
--    status was already safe by accident: the WITH CHECK's is_member requires
--    status = 'active' on the NEW row, so a member's own suspension is refused.
--    The platform branch stays unconditional, or an operator could not restore a
--    tenant - which is the one write on this row they exist to perform.
drop policy if exists organizations_update on public.organizations;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organizations'
                    and policyname = 'organizations_update') then
    create policy organizations_update on public.organizations
      for update to authenticated
      using (private.can(id, 'settings.manage') or (select private.is_platform_admin()))
      with check (private.can(id, 'settings.manage') or (select private.is_platform_admin()));
  end if;
end
$$;

-- 3. roles DELETE had no is_system floor. Measured: an org_admin deleting the
--    org_admin role cascaded away six role_permissions and its assignments,
--    dropping the deleter's own settings.manage and staff.manage. Re-creating the
--    role then failed, because creating a role REQUIRES settings.manage - the
--    delete had just taken it. The tenant had no administrators and no client path
--    to repair that.
drop policy if exists roles_delete on public.roles;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_delete') then
    create policy roles_delete on public.roles
      for delete to authenticated
      using (
        is_system is not true
        and organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      );
  end if;
end
$$;

-- 4. roles UPDATE carried settings.manage in its WITH CHECK but not its USING. Not
--    a hole - it is the only asymmetric policy in the set - but it makes an
--    unprivileged UPDATE raise 42501 where every other policy silently filters the
--    row out, so a caller cannot tell "not permitted" from "no such row".
drop policy if exists roles_update on public.roles;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_update') then
    create policy roles_update on public.roles
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      )
      with check (
        organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      );
  end if;
end
$$;

-- 5. An assignment or an invitation may name any role id, including a platform role
--    with organization_id NULL. Measured: a tenant org_admin inserted both, naming
--    the platform role.
--
--    Inert today, because private.can refuses platform keys and platform_settings
--    stays empty. What actually prevents abuse is incidental - roles_select hides
--    the platform role so a tenant cannot discover the id, and UUIDs are
--    unguessable. Neither is a control. The acceptance RPC that would resolve this
--    is Task 12, so this says no at the policy layer now rather than relying on a
--    later task to remember.
--
--    The EXISTS reaches roles through the roles policies, which is the intended
--    fail-closed intersection, and requires a non-NULL organization matching the
--    row's own - so a tenant can only ever name its own organization's roles.
drop policy if exists user_role_assignments_write on public.user_role_assignments;
drop policy if exists invitations_write on public.invitations;

do $$
begin
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
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = user_role_assignments.organization_id
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'invitations'
                    and policyname = 'invitations_write') then
    create policy invitations_write on public.invitations
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = invitations.organization_id
        )
        and (
          coalesce(array_length(clinic_ids, 1), 0) = 0
          or not exists (
            select 1
              from unnest(clinic_ids) as requested_clinic
             where not exists (
               select 1 from public.clinics cl
                where cl.id = requested_clinic
                  and cl.organization_id = invitations.organization_id
             )
          )
        )
      );
  end if;
end
$$;

-- 6. invitations UPDATE, same two additions: the role must belong to the
--    invitation's organization, and every clinic named must belong to it too.
drop policy if exists invitations_update on public.invitations;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'invitations'
                    and policyname = 'invitations_update') then
    create policy invitations_update on public.invitations
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = invitations.organization_id
        )
        and (
          coalesce(array_length(clinic_ids, 1), 0) = 0
          or not exists (
            select 1
              from unnest(clinic_ids) as requested_clinic
             where not exists (
               select 1 from public.clinics cl
                where cl.id = requested_clinic
                  and cl.organization_id = invitations.organization_id
             )
          )
        )
      );
  end if;
end
$$;

-- 7. Documented, not changed: clinics has NO INSERT policy, so a client cannot
--    create a clinic. That is deliberate - clinic creation belongs with the
--    onboarding and invitation flows, which do not exist yet - but it was the only
--    client-side closure with nothing recording it, so the next person to hit a
--    42501 on clinic creation would add a policy under time pressure.