-- Task 10 review fix: normalise storage policy names.
--
-- 01300 built the four clinical policy names from the bucket id verbatim
-- (patient-documents_select) while its hand-written org-assets block spelled them
-- org_assets_select. Two conventions in one schema is exactly what makes the next
-- person grep for a name that does not exist. Underscore wins, because that is what
-- the mapping table in the test suite is keyed on.
--
-- ALTER POLICY ... RENAME TO is the obvious one-liner and does NOT work here: it
-- requires ownership of storage.objects, which belongs to supabase_storage_admin.
-- MEASURED: 42501 "must be owner of table objects". So this drops and recreates,
-- using the same loop shape as 01400 - the only change is the name construction.

do $$
declare
  r record;
  read_predicate  text;
  write_predicate text;
  policy_name     text;
  old_name        text;
begin
  for r in
    select * from (values
      ('patient-documents',     'patients.read',        'patients.update'),
      ('clinical-attachments',  'encounters.read',      'encounters.write'),
      ('investigation-reports', 'investigations.order', 'investigations.verify'),
      ('prescription-documents','prescriptions.create', 'prescriptions.create')
    ) as t(bucket, read_perm, write_perm)
  loop
    read_predicate := format($p$
      bucket_id = %L
      and private.storage_path_is_safe(name)
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), %L, private.storage_clinic_id(name))
      and private.storage_clinic_id(name) in
            (select private.clinic_ids(private.storage_org_id(name)))
    $p$, r.bucket, r.read_perm);

    write_predicate := format($p$
      bucket_id = %L
      and private.storage_path_is_safe(name)
      and owner_id = (select auth.uid())::text
      and (owner is null or owner = (select auth.uid()))
      and archived_at is null
      and is_delete_marker is false
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), %L, private.storage_clinic_id(name))
      and private.storage_clinic_id(name) in
            (select private.clinic_ids(private.storage_org_id(name)))
    $p$, r.bucket, r.write_perm);

    -- Remove BOTH spellings, so this is re-runnable and so a partially-applied
    -- predecessor cannot leave both behind.
    foreach policy_name in array array[
      r.bucket || '_select', r.bucket || '_insert',
      r.bucket || '_update', r.bucket || '_delete'
    ] loop
      execute format('drop policy if exists %I on storage.objects', policy_name);
    end loop;

    foreach policy_name in array array[
      replace(r.bucket, '-', '_') || '_select',
      replace(r.bucket, '-', '_') || '_insert',
      replace(r.bucket, '-', '_') || '_update',
      replace(r.bucket, '-', '_') || '_delete'
    ] loop
      if policy_name like '%\_select' then
        execute format(
          'create policy %I on storage.objects for select to authenticated using (%s)',
          policy_name, read_predicate);
      elsif policy_name like '%\_insert' then
        execute format(
          'create policy %I on storage.objects for insert to authenticated with check (%s)',
          policy_name, write_predicate);
      elsif policy_name like '%\_delete' then
        execute format(
          'create policy %I on storage.objects for delete to authenticated using (%s)',
          policy_name, write_predicate);
      else
        execute format(
          'create policy %I on storage.objects for update to authenticated using (%s) with check (%s)',
          policy_name, write_predicate, write_predicate);
      end if;
    end loop;
  end loop;
end
$$;