-- Record a storage deletion even when there is no user behind it.
--
-- WHY THIS FILE EXISTS. 20261014001694 added `private.write_storage_audit`, which wrote
-- an audit row for a storage deletion, but SKIPPED the write when `auth.uid()` was NULL:
--
--   if (select auth.uid()) is null then
--     return old;
--   end if;
--
-- MEASURED, and the early return was wrong twice over. It meant a deletion made by
-- `service_role` - the platform's own erasure, and exactly the operation a PHI retention
-- policy might require - left NO trail at all. And the skip was not even doing what it
-- claimed: the row it would have written has a NULL actor and is invisible to every
-- tenant-scoped reader anyway, because `audit_logs_select` exposes a tenant's events by
-- `organization_id IN current_org_ids()`, and a platform event carries no organization.
--
-- So the skip bought nothing and cost the one case that mattered. A service-role deletion
-- is now recorded with a NULL actor, which is honest - it says the platform did this, and
-- names nobody - and it is visible to a platform administrator through the
-- `organization_id IS NULL` branch of the select policy.
--
-- A NOTE ON WHAT THE TRAIL PROVES. The organization is derived from the OBJECT PATH
-- (`private.storage_org_id(old.name)`), not from the row's own `organization_id` column,
-- because the path is what the policies are written against - a forged column would move
-- the event into another tenant's trail.

create or replace function private.write_storage_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
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
  'Records a storage object deletion in the audit trail. The actor is the user the Storage API was acting for, and is NULL when the deletion was made by service_role - a platform erasure, which is recorded on the tenant own row and must not leave a trail attributed to nobody. The organization comes from the object PATH, not from the row own column, because the path is what the policies are written against.';
