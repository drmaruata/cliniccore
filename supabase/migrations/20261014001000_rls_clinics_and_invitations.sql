-- Task 9b - RLS on clinics, clinic memberships and invitations.
--
-- This is where the three-clause clinic predicate is introduced, and it is the
-- shape every clinic-scoped policy in Task 9c follows:
--
--     organization_id in (select private.current_org_ids())   -- membership, active org
--     and private.can(organization_id, '<perm>', <the row's clinic_id>)
--     and <clinic> in (select private.clinic_ids(organization_id))
--
-- The clauses are a CONJUNCTION, not alternatives, because private.can and
-- private.clinic_ids are independent authorities and neither implies the other:
--
--   A clinic-scoped assignment passes clinic_ids for a clinic it was never granted,
--   and only can() stops it.
--
--   An ORG-WIDE assignment passes can() for every clinic in the organization, and
--   only clinic_ids stops it.
--
-- Written with the two-argument can() the first case silently returns no rows.
-- That silence is exactly what gets "fixed" under deadline by loosening can() into
-- a cross-clinic leak, so the row's clinic_id is always passed and never NULL.

do $$
begin
  -- clinics: reading a clinic needs membership and reach, but no permission key.
  -- There is no 'clinics.read' in the registry, and gating the clinic list behind
  -- settings.manage would hide the clinic a doctor is standing in from that doctor.
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'clinics'
                    and policyname = 'clinics_select') then
    create policy clinics_select on public.clinics
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and id in (select private.clinic_ids(organization_id))
      );
  end if;

  -- Changing a clinic's name, timezone or address is administrative.
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'clinics'
                    and policyname = 'clinics_update') then
    create policy clinics_update on public.clinics
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage', id)
        and id in (select private.clinic_ids(organization_id))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage', id)
        and id in (select private.clinic_ids(organization_id))
      );
  end if;
end
$$;

-- clinic_memberships is the table private.clinic_ids reads, so a policy here must
-- not be the thing that breaks it. The policy reaches it through can() and
-- clinic_ids(), both definer functions that bypass RLS entirely, so there is no
-- recursion - and the table feeds reach, so only staff.manage sees its contents.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'clinic_memberships'
                    and policyname = 'clinic_memberships_select') then
    create policy clinic_memberships_select on public.clinic_memberships
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'clinic_memberships'
                    and policyname = 'clinic_memberships_write') then
    create policy clinic_memberships_write on public.clinic_memberships
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'clinic_memberships'
                    and policyname = 'clinic_memberships_update') then
    create policy clinic_memberships_update on public.clinic_memberships
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'clinic_memberships'
                    and policyname = 'clinic_memberships_delete') then
    create policy clinic_memberships_delete on public.clinic_memberships
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;
end
$$;

-- invitations are organization-scoped, not clinic-scoped: an invitation names a
-- role and a list of clinics rather than living in one.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'invitations'
                    and policyname = 'invitations_select') then
    create policy invitations_select on public.invitations
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
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
      );
  end if;

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
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'invitations'
                    and policyname = 'invitations_delete') then
    create policy invitations_delete on public.invitations
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
      );
  end if;
end
$$;