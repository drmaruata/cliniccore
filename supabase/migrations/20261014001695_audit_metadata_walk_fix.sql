-- Fix the metadata free-text walk.
--
-- WHY THIS FILE EXISTS. 20261014001693 introduced
-- `private.audit_metadata_has_free_text`, which walked the metadata with
-- `jsonb_path_query(...) as j` and then read `j.value`. That is wrong: an alias on a
-- set-returning function renames the TABLE, not the column, so the column is named after the
-- function and `j.value` does not exist.
--
-- MEASURED: every audit write failed with "column j.value does not exist" - which surfaced as
-- the audit trail being unusable rather than as a broken function, because the private
-- function's own refusal was what the callers were waiting for and something else refused
-- first.
--
-- The walk below is the SAME recursive pattern `private.write_audit` already uses, which is
-- known to work: recurse through objects and arrays, and test the KEY at each level.

create or replace function private.audit_metadata_has_free_text(p_metadata jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_blocked text[] := array[
    'note', 'notes', 'content', 'summary', 'narrative', 'comment', 'comments',
    'remarks', 'history', 'story', 'complaint', 'symptoms', 'diagnosis', 'prescription',
    'text', 'body', 'transcript', 'message', 'email_body', 'letter', 'referral'
  ];
  v_found boolean;
begin
  if p_metadata is null then
    return false;
  end if;

  with recursive walk(obj) as (
    select coalesce(p_metadata, '{}'::jsonb)
    union all
    select child
      from walk w,
           lateral (
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
            where lower(btrim(k)) = any (v_blocked)
         )
    into v_found;

  return coalesce(v_found, false);
end;
$fn$;

comment on function private.audit_metadata_has_free_text(jsonb) is
  'Whether audit metadata carries a key that smells of clinical free text, at any depth. Keys are normalised - trimmed and lower-cased - before the check, because the original compared the raw key and a key with surrounding whitespace or a capital letter passed it. Still a blocklist: an ALLOWLIST of the keys the application emits is the real closure, and cannot be written until that shape exists.';
