-- Task 10 re-review fixes: MIME allowlists, and a path guard that matches more than
-- the two literal dot segments.
--
-- 1. allowed_mime_types is NULL on all five buckets, and `metadata` is deliberately NOT
--    pinned in the write predicates - it cannot be, because the Storage API writes
--    metadata server-side during upload as the request's role, so a pin rejecting it
--    would fail every legitimate upload. That leaves the mimetype settable by any
--    write-permission holder: `metadata->>'mimetype'` is what the API serves as
--    Content-Type, so a holder could make their own object serve as text/html.
--
--    The constraint belongs on the BUCKET, not the policy. Operator-confirmed list.
--    Not applied to org-assets beyond the same list: a tenant logo or template is just
--    as likely to be a PDF or an image, and a narrower list there would break branding
--    uploads for no security gain.
--
-- 2. private.storage_path_is_safe matched only the literal segments '.' and '..'.
--    MEASURED accepted as real rows: '...', '....//', '.. ' (trailing space), '. .',
--    '..;' and '%2e%2e'. Traversal via the non-literal forms is unproven and not
--    provable from the database, but the fix is free: reject ANY segment made only of
--    dots. '%2e%2e' still passes, and that is provably safe rather than merely
--    unrefuted - S3 keys are not URL-decoded, so it is a six-character literal at the
--    storage layer, and foldername()'s [1] and [2] indices are fixed, so extra
--    TRAILING segments can never shift which segment is read as the organization.
--
-- 3. CORRECTION to a comment in 01410, which said its drop loop made the file
--    re-runnable. It is not: the create loop has no `exists` guard, so a second
--    create policy with the same name raises 42710. Harmless - all drops and creates
--    are inside one DO block and therefore one transaction, so a re-apply rolls back
--    whole and there is never a window in which a policy is absent - but the comment
--    was wrong.
--
-- 4. RECORDED, NOT CHANGED: pinning archived_at on the clinical UPDATE and DELETE
--    predicates means that if the SERVICE ROLE ever archives a clinical object for
--    retention or legal hold, no authenticated principal can rename or delete it
--    again. That is the same lockout shape Task 9 hit with private.role_in_use, and
--    it is the price of preventing a client from archiving PHI out of sight while the
--    row and blob remain. Operator-confirmed as the intended trade: service_role SQL
--    is the recovery path.

update storage.buckets
   set allowed_mime_types = array[
         'application/pdf',
         'image/jpeg',
         'image/png',
         'application/dicom',
         'text/plain'
       ]
 where id = any (array[
         'patient-documents',
         'clinical-attachments',
         'investigation-reports',
         'org-assets',
         'prescription-documents'
       ]);

create or replace function private.storage_path_is_safe(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  -- string_to_array over the WHOLE name, not storage.foldername(), because
  -- foldername() drops the last segment - so a name ENDING in '..' would slip past.
  --
  -- The pattern is ^\.\+$ rather than membership in ('.', '..'): a segment made
  -- ENTIRELY of dots is refused, which covers '...' and '....' as well. There is no
  -- legitimate object name whose directory or file is only dots.
  select not exists (
    select 1
      from unnest(string_to_array(p_name, '/')) as segment
     where segment ~ '^\.+$'
  )
$fn$;

revoke execute on function private.storage_path_is_safe(text) from public;
grant execute on function private.storage_path_is_safe(text) to authenticated;