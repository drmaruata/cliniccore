-- Let a tenant administrator delete a departed user's documents, and record every
-- storage deletion in the audit trail.
--
-- ---------------------------------------------------------------------------
-- C3. A DEPARTED USER'S DOCUMENTS WERE UNDELETABLE BY EVERY APPLICATION ROLE.
--
-- MEASURED, and it is a consequence of the uploader-only decision rather than a bug in it:
-- every storage delete policy required
--
--   owner_id = auth.uid()::text and (owner is null or owner = auth.uid())
--
-- so when a clinician left the organization, the documents they uploaded became
-- undeletable by anyone - the uploader had gone, and no other role could satisfy the
-- ownership clause. For a PHI system that may have to erase a patient's documents on
-- request, "nobody can delete this" is the worst possible answer.
--
-- The fix keeps uploader-only ownership for the ordinary case and adds the one role that
-- should be able to clean up after a departure: a holder of `settings.manage` in the
-- organization the object belongs to. That is a strictly NARROWER permission than the
-- write permission each bucket's own policy already demands, so it adds an administrator's
-- ability to delete and changes nothing else.
--
-- The path is still checked, and the organization is still derived from the PATH, so the
-- relaxation cannot be used to reach another tenant's objects: `storage_org_id(name)` is the
-- organization in the object NAME, and `settings.manage` is checked against THAT
-- organization.
--
-- The policy bodies below were produced by taking the DEPLOYED expression verbatim and
-- replacing the ownership clause, rather than by retyping them. Hand-retyping them is how
-- this file first went wrong twice - once adding a cast that turned `owner = auth.uid()`
-- into `uuid = text`, and once passing the raw object NAME to `clinic_ids` where the
-- deployed policy passed the ORGANIZATION id. Both were caught by the database refusing the
-- migration, which is the right place for that to be caught.
--
-- ---------------------------------------------------------------------------
-- C4. A DOCUMENT REMOVED THROUGH THE STORAGE API LEFT NO TRAIL.
--
-- MEASURED: `storage-api` deletions wrote nothing to `audit_logs`, so a PHI document
-- removed through the Storage API - which is how the browser removes one - left no record
-- in the project's own audit log. The table's foreign keys are deliberately absent, so
-- nothing else would have recorded it either.
--
-- The trigger fires AFTER the delete, so it cannot block it, and it writes the actor as
-- `auth.uid()` - the user the Storage API was acting for.
--
-- It writes only when there IS an actor. A service-role delete is the platform's own
-- erasure rather than a tenant action, and it is recorded on the tenant's own row; a
-- platform action would otherwise leave a trail attributed to nobody.
--
-- A CAVEAT WORTH RECORDING. `storage.objects` is a Supabase-managed table, and a Supabase
-- migration could in principle replace the trigger. The audit trail for storage deletions
-- is therefore not as durable as the audit trail for everything else, which is written
-- through a function this project owns.

-- ---------------------------------------------------------------------------
-- 1. C3. The relaxed delete policies.

drop policy if exists clinical_attachments_delete on storage.objects;
create policy clinical_attachments_delete
  on storage.objects
  for delete
  using ((bucket_id = 'clinical-attachments'::text) AND private.storage_path_is_safe(name) AND (((owner_id = (( SELECT auth.uid() AS uid))::text) AND ((owner IS NULL) OR (owner = ( SELECT auth.uid() AS uid)))) OR private.can(private.storage_org_id(name), 'settings.manage'::text)) AND (archived_at IS NULL) AND (is_delete_marker IS FALSE) AND private.is_member(private.storage_org_id(name)) AND private.can(private.storage_org_id(name), 'encounters.write'::text, private.storage_clinic_id(name)) AND (private.storage_clinic_id(name) IN ( SELECT private.clinic_ids(private.storage_org_id(objects.name)) AS clinic_ids)));

drop policy if exists investigation_reports_delete on storage.objects;
create policy investigation_reports_delete
  on storage.objects
  for delete
  using ((bucket_id = 'investigation-reports'::text) AND private.storage_path_is_safe(name) AND (((owner_id = (( SELECT auth.uid() AS uid))::text) AND ((owner IS NULL) OR (owner = ( SELECT auth.uid() AS uid)))) OR private.can(private.storage_org_id(name), 'settings.manage'::text)) AND (archived_at IS NULL) AND (is_delete_marker IS FALSE) AND private.is_member(private.storage_org_id(name)) AND private.can(private.storage_org_id(name), 'investigations.verify'::text, private.storage_clinic_id(name)) AND (private.storage_clinic_id(name) IN ( SELECT private.clinic_ids(private.storage_org_id(objects.name)) AS clinic_ids)));

drop policy if exists org_assets_delete on storage.objects;
create policy org_assets_delete
  on storage.objects
  for delete
  using ((bucket_id = 'org-assets'::text) AND private.storage_path_is_safe(name) AND (((owner_id = (( SELECT auth.uid() AS uid))::text) AND ((owner IS NULL) OR (owner = ( SELECT auth.uid() AS uid)))) OR private.can(private.storage_org_id(name), 'settings.manage'::text)) AND private.is_member(private.storage_org_id(name)) AND private.can(private.storage_org_id(name), 'settings.manage'::text));

drop policy if exists patient_documents_delete on storage.objects;
create policy patient_documents_delete
  on storage.objects
  for delete
  using ((bucket_id = 'patient-documents'::text) AND private.storage_path_is_safe(name) AND (((owner_id = (( SELECT auth.uid() AS uid))::text) AND ((owner IS NULL) OR (owner = ( SELECT auth.uid() AS uid)))) OR private.can(private.storage_org_id(name), 'settings.manage'::text)) AND (archived_at IS NULL) AND (is_delete_marker IS FALSE) AND private.is_member(private.storage_org_id(name)) AND private.can(private.storage_org_id(name), 'patients.update'::text, private.storage_clinic_id(name)) AND (private.storage_clinic_id(name) IN ( SELECT private.clinic_ids(private.storage_org_id(objects.name)) AS clinic_ids)));

drop policy if exists prescription_documents_delete on storage.objects;
create policy prescription_documents_delete
  on storage.objects
  for delete
  using ((bucket_id = 'prescription-documents'::text) AND private.storage_path_is_safe(name) AND (((owner_id = (( SELECT auth.uid() AS uid))::text) AND ((owner IS NULL) OR (owner = ( SELECT auth.uid() AS uid)))) OR private.can(private.storage_org_id(name), 'settings.manage'::text)) AND (archived_at IS NULL) AND (is_delete_marker IS FALSE) AND private.is_member(private.storage_org_id(name)) AND private.can(private.storage_org_id(name), 'prescriptions.create'::text, private.storage_clinic_id(name)) AND (private.storage_clinic_id(name) IN ( SELECT private.clinic_ids(private.storage_org_id(objects.name)) AS clinic_ids)));

-- ---------------------------------------------------------------------------
-- 2. C4. The storage audit trail.

create or replace function private.write_storage_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    return old;
  end if;

  insert into public.audit_logs (
    organization_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    metadata
  )
  values (
    private.storage_org_id(old.name),
    (select auth.uid()),
    'storage.object_deleted',
    old.bucket_id,
    old.id,
    jsonb_build_object('name', old.name, 'bucket', old.bucket_id)
  );

  return old;
end;
$fn$;

comment on function private.write_storage_audit() is
  'Records a storage object deletion in the audit trail, with the user the Storage API was acting for as the actor. Fires AFTER the delete, so it cannot block it.';

drop trigger if exists storage_objects_audit_delete on storage.objects;
create trigger storage_objects_audit_delete
  after delete on storage.objects
  for each row execute function private.write_storage_audit();
