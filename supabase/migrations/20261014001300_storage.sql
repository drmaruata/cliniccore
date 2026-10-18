-- Task 10: private storage buckets and tenant-scoped object policies.
--
-- WHY THIS MIGRATION IS THE WHOLE SECURITY STORY FOR FILES. Every table in this schema
-- carries `organization_id` and a composite foreign key, so a row physically cannot
-- reference another tenant. `storage.objects` has neither: its tenancy is carried by the
-- object NAME, a text path whose first segment is the organization id, and a text path
-- cannot carry a foreign key. These policies are the only thing between a member of one
-- tenant and another tenant's documents. The project constraint "composite tenant FKs"
-- is satisfied here by construction and by policy rather than by constraint, and that is
-- worth knowing before anyone relaxes one of these clauses.
--
-- PATH SHAPE (operator-confirmed):
--   clinical buckets   <org_uuid>/<clinic_uuid>/<file>
--   org-assets         <org_uuid>/<file>
--
-- `storage.foldername()` returns every segment EXCEPT the last, so segment 1 is always
-- the organization directory and the last segment is always the filename. That is what
-- makes the shape unambiguous per bucket instead of inferred from whether a segment
-- happens to look like a UUID.
--
-- PERMISSIONS (operator-confirmed, every key is one the matching registry role holds):
--   patient-documents       patients.read           / patients.update
--   clinical-attachments    encounters.read         / encounters.write
--   investigation-reports   investigations.order    / investigations.verify
--   prescription-documents  prescriptions.create    / prescriptions.create
--   org-assets              settings.manage         / settings.manage
--
-- NO BUCKET IS PUBLIC. Every one is created with public = false, and there is no policy
-- that serves anonymous traffic, so an unsigned request cannot read a document.

insert into storage.buckets (id, name, public)
values
  ('patient-documents',     'patient-documents',     false),
  ('clinical-attachments',  'clinical-attachments',  false),
  ('investigation-reports', 'investigation-reports', false),
  ('org-assets',            'org-assets',            false),
  ('prescription-documents','prescription-documents',false)
on conflict (id) do update set public = excluded.public;

-- ---------------------------------------------------------------------------
-- Path parsing. Both helpers are SECURITY INVOKER: they touch no table, only the
-- string they are handed, so there is nothing for a definer to protect.
--
-- They exist to make a bad path DENY rather than ERROR. A naive
-- `(storage.foldername(name))[1]::uuid` raises 22P02 on an object whose first segment
-- is not a uuid, which PostgREST reports as a 500 rather than a 403 - and a 500 on a
-- path an attacker chose is a worse answer than "no rows". The CASE only reaches the
-- cast when the segment already matches the uuid shape.
--
-- NULL is the answer for "this path does not name an organization or a clinic", and
-- every caller treats NULL as denial: `is_member(NULL)` is NULL, and NULL is not true.

create or replace function private.storage_org_id(p_name text)
returns uuid
language sql
stable
set search_path = ''
as $fn$
  select case
           when (storage.foldername(p_name))[1]
                  ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then ((storage.foldername(p_name))[1])::uuid
           else null
         end
$fn$;

create or replace function private.storage_clinic_id(p_name text)
returns uuid
language sql
stable
set search_path = ''
as $fn$
  select case
           when (storage.foldername(p_name))[2]
                  ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then ((storage.foldername(p_name))[2])::uuid
           else null
         end
$fn$;

revoke execute on function private.storage_org_id(text) from public;
grant execute on function private.storage_org_id(text) to authenticated;
revoke execute on function private.storage_clinic_id(text) from public;
grant execute on function private.storage_clinic_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The clinic-scoped predicate: the SAME three-clause conjunction the clinical tables
-- use, for the same reason. `can` is the permission authority and `clinic_ids` is the
-- reach authority, and neither implies the other - a clinic-scoped assignment passes
-- reach for a clinic it was never granted, and an org-wide assignment passes `can` for
-- every clinic in the organization. Only the conjunction closes both.
--
-- A clinical object with no clinic segment is denied, because the third clause is NULL
-- and NULL is not true. That is deliberate: the path shape is the contract.
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
    read_predicate  := format(
      'bucket_id = %L and private.is_member(private.storage_org_id(name))
       and private.can(private.storage_org_id(name), %L, private.storage_clinic_id(name))
       and private.storage_clinic_id(name) in
             (select private.clinic_ids(private.storage_org_id(name)))',
      r.bucket, r.read_perm);

    write_predicate := format(
      'bucket_id = %L and private.is_member(private.storage_org_id(name))
       and private.can(private.storage_org_id(name), %L, private.storage_clinic_id(name))
       and private.storage_clinic_id(name) in
             (select private.clinic_ids(private.storage_org_id(name)))',
      r.bucket, r.write_perm);

    -- WITH CHECK carries the same predicate as USING on UPDATE, so an object cannot be
    -- moved into another tenant's prefix or another clinic's. SELECT-only policies
    -- would not catch that, and it is the obvious second attack after "can I read their
    -- file".
    --
    -- The three commands take three different shapes and PostgreSQL rejects the wrong
    -- ones: INSERT accepts only WITH CHECK, DELETE only USING, UPDATE both. Getting
    -- that wrong is 42601 and it rolls the whole migration back.
    foreach policy_name in array array[
      r.bucket || '_select', r.bucket || '_insert',
      r.bucket || '_update', r.bucket || '_delete'
    ] loop
      if exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'storage' and policyname = policy_name) then
        continue;
      end if;

      execute format(
        case
          when policy_name like '%\_select' then
            'create policy %I on storage.objects for select to authenticated using (%s)'
          when policy_name like '%\_insert' then
            'create policy %I on storage.objects for insert to authenticated with check (%s)'
          when policy_name like '%\_delete' then
            'create policy %I on storage.objects for delete to authenticated using (%s)'
          else
            'create policy %I on storage.objects for update to authenticated using (%s) with check (%s)'
        end,
        policy_name, read_predicate, write_predicate, write_predicate);
    end loop;
  end loop;
end
$$;

-- org-assets is organization-scoped: the path is <org_uuid>/<file>, so segment 2 is
-- part of the filename, not a clinic. The two-argument can() is therefore correct here -
-- and it passes only ORG-WIDE assignments, which is what settings.manage means.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'storage' and policyname = 'org_assets_select') then
    create policy org_assets_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'org-assets'
        and private.is_member(private.storage_org_id(name))
        and private.can(private.storage_org_id(name), 'settings.manage')
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'storage' and policyname = 'org_assets_insert') then
    create policy org_assets_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'org-assets'
        and private.is_member(private.storage_org_id(name))
        and private.can(private.storage_org_id(name), 'settings.manage')
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'storage' and policyname = 'org_assets_update') then
    create policy org_assets_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'org-assets'
        and private.is_member(private.storage_org_id(name))
        and private.can(private.storage_org_id(name), 'settings.manage')
      )
      with check (
        bucket_id = 'org-assets'
        and private.is_member(private.storage_org_id(name))
        and private.can(private.storage_org_id(name), 'settings.manage')
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'storage' and policyname = 'org_assets_delete') then
    create policy org_assets_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'org-assets'
        and private.is_member(private.storage_org_id(name))
        and private.can(private.storage_org_id(name), 'settings.manage')
      );
  end if;
end
$$;