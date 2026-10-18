-- Task 10 review fixes. One of these is a live PHI vulnerability that shipped in 01300.
--
-- 1. CRITICAL: `format()` fills `%s` POSITIONALLY. 01300 built ONE template-selection
--    expression and passed ONE shared argument list to it, so the one-placeholder
--    INSERT and DELETE branches consumed the FIRST argument - the READ predicate.
--    Only UPDATE's three placeholders ever reached `write_predicate`. Measured against
--    the applied catalogue before this file:
--
--        patient-documents_insert      demanded 'patients.read'        (should be patients.update)
--        patient-documents_delete      demanded 'patients.read'        (should be patients.update)
--        clinical-attachments_insert   demanded 'encounters.read'      (should be encounters.write)
--        clinical-attachments_delete   demanded 'encounters.read'      (should be encounters.write)
--        investigation-reports_insert  demanded 'investigations.order' (should be investigations.verify)
--        investigation-reports_delete  demanded 'investigations.order' (should be investigations.verify)
--
--    So a clinician holding a read-only permission set could create and permanently
--    delete PHI on three of the five buckets. The sharpest case is investigation-reports:
--    a doctor holding investigations.order but NOT investigations.verify could file a
--    result document for an investigation they may not verify, and it would sit in the
--    record indistinguishable from a verified result.
--
--    THE FIX IS STRUCTURAL, not clever: one template per call site. Each `execute
--    format(...)` below carries its own template and exactly the arguments that
--    template consumes, so there is no shared argument list for a branch to reach into
--    and no way for the pairing to drift.
--
--    Named format arguments were the obvious fix and are NOT AVAILABLE:
--    PostgreSQL declares format() as `format(text, VARIADIC "any" format_args)`, which
--    has no declared parameter names, so `format($t$ %(bucket)L $t$, bucket => x)` fails
--    with "function format(text, bucket => unknown) does not exist". MEASURED. Do not
--    reach for it again in this codebase.
--
-- 2. Nine columns of storage.objects were unpinned. Owner, archive and delete-marker
--    semantics are now fixed (operator-confirmed):
--      - owner_id must be the caller's, so ownership cannot be forged at creation, and
--        only the uploader may rename, replace or delete their own object.
--      - `owner` is the legacy column and the Storage API may leave it NULL, so the
--        predicate accepts NULL-or-self rather than demanding a value it may not send.
--      - archived_at must be NULL and is_delete_marker must be false, so a client
--        cannot make an object stop being served while the row AND the underlying blob
--        remain - a deletion that leaves PHI in place. SELECT deliberately does NOT
--        filter on them, so an object archived by the service role stays visible for
--        audit rather than hidden from the people who would investigate it.
--
-- 3. `.` and `..` path segments are refused outright. `org/clinic-A/../clinic-B/f.pdf`
--    passed the clinic clause because segment 2 genuinely IS clinic A - but whether the
--    Storage API's S3 backend normalises `..` is outside the database and unverifiable
--    from here. Refusing the segments removes the question.

create or replace function private.storage_path_is_safe(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  -- string_to_array over the WHOLE name, not storage.foldername(), because
  -- foldername() drops the last segment - so a name ENDING in `..` would slip past.
  select not exists (
    select 1
      from unnest(string_to_array(p_name, '/')) as segment
     where segment in ('.', '..')
  )
$fn$;

revoke execute on function private.storage_path_is_safe(text) from public;
grant execute on function private.storage_path_is_safe(text) to authenticated;

do $$
declare
  r record;
  read_predicate  text;
  write_predicate text;
  policy_name     text;
begin
  for r in
    select * from (values
      ('patient-documents',     'patients.read',        'patients.update'),
      ('clinical-attachments',  'encounters.read',      'encounters.write'),
      ('investigation-reports', 'investigations.order', 'investigations.verify'),
      ('prescription-documents','prescriptions.create', 'prescriptions.create')
    ) as t(bucket, read_perm, write_perm)
  loop
    -- Two placeholders, two arguments, in order, in one call. Safe: the failure in
    -- 01300 was never a placeholder count mismatch within one template, it was ONE
    -- template serving four branches with a shared argument list.
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

    foreach policy_name in array array[
      r.bucket || '_select', r.bucket || '_insert',
      r.bucket || '_update', r.bucket || '_delete'
    ] loop
      execute format('drop policy if exists %I on storage.objects', policy_name);

      -- Four statements, four templates, four argument lists. The predicate each one
      -- receives is visible on the line that uses it.
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

-- org-assets is organization-scoped: the path is <org_uuid>/<file>, so segment 2 is
-- part of the filename rather than a clinic, and the two-argument can() is correct here
-- - it passes only ORG-WIDE assignments, which is what settings.manage means.
--
-- An UPDATE policy is OR'd per row, not paired: a patient-documents row matched by one
-- policy's USING can be renamed into org-assets if the DESTINATION policy's WITH CHECK
-- accepts the new row. That is bounded by org-assets' own settings.manage, so it is not
-- an escalation - but 01300's header implied immovability, which was wrong.
do $$
begin
  drop policy if exists org_assets_select on storage.objects;
  drop policy if exists org_assets_insert on storage.objects;
  drop policy if exists org_assets_update on storage.objects;
  drop policy if exists org_assets_delete on storage.objects;

  create policy org_assets_select on storage.objects
    for select to authenticated
    using (
      bucket_id = 'org-assets'
      and private.storage_path_is_safe(name)
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), 'settings.manage')
    );

  create policy org_assets_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'org-assets'
      and private.storage_path_is_safe(name)
      and owner_id = (select auth.uid())::text
      and (owner is null or owner = (select auth.uid()))
      and archived_at is null
      and is_delete_marker is false
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), 'settings.manage')
    );

  create policy org_assets_update on storage.objects
    for update to authenticated
    using (
      bucket_id = 'org-assets'
      and private.storage_path_is_safe(name)
      and owner_id = (select auth.uid())::text
      and (owner is null or owner = (select auth.uid()))
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), 'settings.manage')
    )
    with check (
      bucket_id = 'org-assets'
      and private.storage_path_is_safe(name)
      and owner_id = (select auth.uid())::text
      and (owner is null or owner = (select auth.uid()))
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), 'settings.manage')
    );

  -- No archived_at/is_delete_marker clause on DELETE: refusing to delete something the
  -- service role archived would be a surprising dead end, and delete is already gated on
  -- settings.manage and on being the uploader.
  create policy org_assets_delete on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'org-assets'
      and private.storage_path_is_safe(name)
      and owner_id = (select auth.uid())::text
      and (owner is null or owner = (select auth.uid()))
      and private.is_member(private.storage_org_id(name))
      and private.can(private.storage_org_id(name), 'settings.manage')
    );
end
$$;