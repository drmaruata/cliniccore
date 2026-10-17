-- Task 9d correction - patient_identifiers delegates both its permission and its
-- clinic dimension to the patients policies.
--
-- 01200 gave these policies their own `private.can(organization_id,
-- 'patients.read')` clause alongside the EXISTS on the parent patient. That was
-- redundant AND wrong. Redundant because the patients SELECT policy already
-- encodes membership, patients.read for that row's clinic, and clinic reach.
--
-- Wrong because the two-argument can() passes only an ORG-WIDE assignment:
-- its predicate is `a.clinic_id is null or a.clinic_id = NULL`, so a clinician
-- scoped to one clinic gets false for every clinic. The consequence was the worst
-- kind of bug: a clinic-scoped doctor could read their patients and then found
-- none of their identifiers - an MRN present on one screen and absent from the
-- other, with no error anywhere. MEASURED: the identifiers suite failed with
-- `expected [] to deeply equal [ 'X-1' ]` for exactly that user.
--
-- The fix is to delete the redundant clause and let the EXISTS carry the whole
-- decision, which is what the write paths do now: they ask can() with the
-- PATIENT'S clinic rather than the identifier's, because the identifier has none.

drop policy if exists patient_identifiers_select on public.patient_identifiers;
drop policy if exists patient_identifiers_write on public.patient_identifiers;
drop policy if exists patient_identifiers_update on public.patient_identifiers;
drop policy if exists patient_identifiers_delete on public.patient_identifiers;

do $$
begin
  -- Read permission, and the clinic dimension, are entirely the patients policy's
  -- decision. A principal who cannot see the patient cannot see its identifiers.
  create policy patient_identifiers_select on public.patient_identifiers
    for select to authenticated
    using (
      exists (select 1 from public.patients p where p.id = patient_id)
    );

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_write') then
    create policy patient_identifiers_write on public.patient_identifiers
      for insert to authenticated
      with check (
        exists (
          select 1 from public.patients p
           where p.id = patient_id
             and private.can(p.organization_id, 'patients.create', p.clinic_id)
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_update') then
    create policy patient_identifiers_update on public.patient_identifiers
      for update to authenticated
      using (
        exists (
          select 1 from public.patients p
           where p.id = patient_id
             and private.can(p.organization_id, 'patients.update', p.clinic_id)
        )
      )
      with check (
        exists (
          select 1 from public.patients p
           where p.id = patient_id
             and private.can(p.organization_id, 'patients.update', p.clinic_id)
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'patient_identifiers'
                    and policyname = 'patient_identifiers_delete') then
    create policy patient_identifiers_delete on public.patient_identifiers
      for delete to authenticated
      using (
        exists (
          select 1 from public.patients p
           where p.id = patient_id
             and private.can(p.organization_id, 'patients.update', p.clinic_id)
        )
      );
  end if;
end
$$;