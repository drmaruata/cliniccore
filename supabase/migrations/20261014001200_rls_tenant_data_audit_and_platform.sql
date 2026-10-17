-- Task 9d - RLS on clinical data, the audit trail and platform settings.
--
-- patients is the canonical three-clause clinic-scoped table, and patient_identifiers
-- is the interesting one: it carries PHI (an MRN identifies a person) but has NO
-- clinic_id column, so clinic reach has to be derived from the patient row.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patients'
                    and policyname = 'patients_select') then
    create policy patients_select on public.patients
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.read', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patients'
                    and policyname = 'patients_write') then
    create policy patients_write on public.patients
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.create', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patients'
                    and policyname = 'patients_update') then
    create policy patients_update on public.patients
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.update', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.update', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patients'
                    and policyname = 'patients_delete') then
    create policy patients_delete on public.patients
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.update', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;
end
$$;

-- patient_identifiers has no clinic of its own. Membership and permission are
-- checked directly; the clinic dimension is delegated to the patients policies by
-- requiring the parent patient row to be visible. That subquery runs as
-- authenticated and is therefore subject to the patients policies above - so if a
-- clinic-scoped principal cannot see the patient, they cannot see its identifiers
-- either. Fail-closed by construction, and it fails closed in exactly the same
-- places the patient read does.
--
-- The alternative - an EXISTS on organizations or a clinic lookup keyed by
-- organization_id alone - would grant an org-wide patients.read holder every
-- identifier in the organization, which is a cross-clinic leak dressed as a
-- convenience.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_select') then
    create policy patient_identifiers_select on public.patient_identifiers
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.read')
        and exists (select 1 from public.patients p where p.id = patient_id)
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_write') then
    create policy patient_identifiers_write on public.patient_identifiers
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.create')
        and exists (select 1 from public.patients p where p.id = patient_id)
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_update') then
    create policy patient_identifiers_update on public.patient_identifiers
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.update')
        and exists (select 1 from public.patients p where p.id = patient_id)
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.update')
        and exists (select 1 from public.patients p where p.id = patient_id)
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_delete') then
    create policy patient_identifiers_delete on public.patient_identifiers
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'patients.update')
        and exists (select 1 from public.patients p where p.id = patient_id)
      );
  end if;
end
$$;

-- tenant_sequences stays completely closed. Its only writer is
-- private.next_sequence_value, a definer that checks membership itself; leaving
-- the table policy-free is what keeps an MRN counter from being bumpable by a
-- tenant. The grant is revoked too, because RLS is one lock and the project's
-- history is a stray GRANT silently reopening a closed table.
revoke insert, update, delete on public.tenant_sequences from authenticated;

-- audit_logs is select-only. authenticated's INSERT/UPDATE/DELETE were revoked in
-- Task 8, so append-only does not depend on this migration writing no policy: a
-- missing policy and a revoked grant both close it.
--
-- A tenant reads its own trail with audit.read. A platform operator reads
-- organization_id is null events, which is the platform-scoped half of the trail
-- that no tenant can ever write.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'audit_logs'
                    and policyname = 'audit_logs_select') then
    create policy audit_logs_select on public.audit_logs
      for select to authenticated
      using (
        (
          organization_id in (select private.current_org_ids())
          and private.can(organization_id, 'audit.read')
        )
        or (
          organization_id is null
          and (select private.is_platform_admin())
        )
      );
  end if;
end
$$;

-- platform_settings is readable only by a platform administrator and writable by
-- nobody through PostgREST: there is no client-side settings writer, and the values
-- are billing and signup behaviour, not tenant data.
revoke insert, update, delete on public.platform_settings from authenticated;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'platform_settings'
                    and policyname = 'platform_settings_select') then
    create policy platform_settings_select on public.platform_settings
      for select to authenticated
      using ((select private.is_platform_admin()));
  end if;
end
$$;