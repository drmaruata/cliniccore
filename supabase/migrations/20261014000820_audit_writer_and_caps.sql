-- Task 8 hardening, second pass: close the last two review Minors.
--
-- New file again, because 00800/00810 are applied and the edit exception closed
-- once 00300 landed.
--
-- 1. N1 - the C1 guard is organization-strict, which left one audit event with no
--    writer: a platform operator suspending a tenant. Writing that event means
--    writing an org-scoped row for an organization the operator is not (and must
--    not be) an active member of, so the guard refused exactly the case the audit
--    trail exists to record. The predicate now also admits a platform
--    administrator, whose authority is the profiles.is_platform_admin boolean and
--    not a role. A tenant still cannot write outside its own organization, because
--    a tenant can never satisfy is_platform_admin.
--
-- 2. N2 - the 8 KiB cap bounded metadata only, while p_action and p_resource_type
--    are unconstrained text and were always the free-text bypass the metadata
--    screen concedes it cannot close. A member could store an arbitrarily large
--    row in its OWN trail through them, and the 00810 comment implied the row was
--    capped. Both are now bounded. 128 and 64 bytes are far above any real action
--    ('patient.read') or resource type ('patient'), so this cannot reject a
--    legitimate entry.
--
-- The metadata screen itself is unchanged and remains a key-name blocklist:
-- `summary`, `narrative`, a misspelling, or a key with surrounding whitespace all
-- pass it. It catches casual smuggling, not a determined one.

create or replace function private.write_audit(
  p_org_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid default null,
  p_metadata jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_free_text_found boolean;
begin
  -- Three refusals, and each closes a different route. A tenant may only write its
  -- own trail; a platform administrator may write any organization's, which is
  -- what makes a suspension recordable; and a platform-scoped entry
  -- (organization_id NULL) is reserved for platform administrators too.
  if not ((select private.is_member(p_org_id)) or (select private.is_platform_admin())) then
    raise exception 'audit events may only be written for your own organization, or by a platform administrator'
      using errcode = '42501';
  end if;

  if p_org_id is null and not (select private.is_platform_admin()) then
    raise exception 'platform audit events require a platform administrator'
      using errcode = '42501';
  end if;

  -- Bound every text the caller supplies, not just metadata: action and
  -- resource_type are the columns the metadata screen cannot police, so an
  -- unbounded value there is an unbounded row here.
  if octet_length(p_action) > 128 or octet_length(p_resource_type) > 64 then
    raise exception 'audit action exceeds 128 bytes or resource_type exceeds 64'
      using errcode = 'check_violation';
  end if;

  if octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192 then
    raise exception 'audit metadata exceeds 8 KiB'
      using errcode = 'check_violation';
  end if;

  -- No depth bound: jsonb is a tree and cannot be cyclic, so the recursion always
  -- terminates. The `depth < 32` that used to be here was not a safety net, only a
  -- hole - a key nested 33 levels deep passed the screen.
  with recursive walk(obj) as (
    select coalesce(p_metadata, '{}'::jsonb)
    union all
    select child
      from walk w
     cross join lateral (
        select e.value as child
          from jsonb_each(case when jsonb_typeof(w.obj) = 'object' then w.obj else '{}'::jsonb end) e
       union all
        select el.value
          from jsonb_array_elements(case when jsonb_typeof(w.obj) = 'array' then w.obj else '[]'::jsonb end) el
     ) c
  )
  select exists (
           select 1
             from walk w,
                  lateral jsonb_object_keys(
                    case when jsonb_typeof(w.obj) = 'object' then w.obj else '{}'::jsonb end
                  ) as k
            where lower(k) in ('note', 'notes', 'content')
         )
    into v_free_text_found;

  if v_free_text_found then
    raise exception 'audit metadata must not carry clinical free-text keys (note, notes, content)'
      using errcode = 'check_violation';
  end if;

  insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_org_id,
    (select auth.uid()),
    p_action,
    p_resource_type,
    p_resource_id,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$fn$;
