-- Check the 8 KiB metadata bound BEFORE the value rule, so its own bound is the one reported.
--
-- WHY THIS FILE EXISTS. 20261014001700 introduced the value rule - a string value must be
-- identifier-shaped - and that rule also refuses a value longer than 64 characters. It
-- therefore refused a 9 000-character value FIRST, and the test that was proving the 8 KiB
-- metadata cap was proving the wrong bound: it expected the message "exceeds 8 KiB" and got
-- "the value of ... is longer than 64 characters" instead.
--
-- Both refusals are correct - but they are DIFFERENT bounds, and a caller who sends too much
-- metadata should be told that it is too much, not that one of its values is long. The
-- total-size check now runs first, so each bound reports itself.
--
-- The 8 KiB cap is not new: `private.write_audit` has always applied it. This file only
-- ensures the check happens before the newer, finer-grained screen, so the message names the
-- bound the caller actually tripped.

create or replace function public.write_audit(
  p_org_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_violation text;
begin
  if p_resource_id is not null
     and not private.audit_resource_belongs_to_org(p_org_id, p_resource_id) then
    raise exception 'an audit event may not reference a resource in another organization'
      using errcode = '42501';
  end if;

  -- The total size first, so ITS bound is the one reported.
  if octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192 then
    raise exception 'audit metadata exceeds 8 KiB' using errcode = 'check_violation';
  end if;

  v_violation := private.audit_metadata_violation(p_metadata);
  if v_violation is not null then
    raise exception 'audit metadata rejected: %', v_violation
      using errcode = 'check_violation';
  end if;

  perform private.write_audit(p_org_id, p_action, p_resource_type, p_resource_id, p_metadata);
end;
$fn$;

comment on function public.write_audit(uuid, text, text, uuid, jsonb) is
  'Appends one row to the audit trail for the calling user. The resource id is optional and may not name a row in another organization. Metadata is bounded at 8 KiB, and must describe what HAPPENED in identifiers and codes: a string value with whitespace in it, or a key that names clinical free text, is refused. private.write_audit owns the membership check.';
