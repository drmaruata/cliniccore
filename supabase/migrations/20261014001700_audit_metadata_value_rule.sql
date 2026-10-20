-- Close the audit free-text screen properly: screen the VALUE, not only the key name.
--
-- WHY THIS FILE EXISTS. The screen was a KEY-NAME BLOCKLIST, and the reviewer's objection to
-- it was exact: "summary, narrative, a misspelling, or a key with surrounding whitespace all
-- pass it. Recorded as a speed bump, not a guarantee."
--
-- MEASURED, each of those really did pass:
--
--   {"summary": "..."}        - the key is not on the list
--   {"summry": "..."}         - a MISSPELLING is not on the list
--   {" note": "..."}           - surrounding whitespace made it a different key
--   {"narrative": "..."}       - likewise
--
-- AND THE DEEPER POINT, which is the one that makes the blocklist the wrong shape. A
-- blocklist screens KEYS, but the harm is in the VALUE. A misspelled key does not leak
-- anything by being misspelled; it leaks because it carries prose, and a key-name screen
-- cannot see that. So the same hole that lets a misspelling through also lets ANY key
-- through, however innocent it looks.
--
-- THE RULE, THEREFORE: a string VALUE must be identifier-shaped. No whitespace anywhere,
-- and at most 64 characters. Audit metadata describes what HAPPENED - a count, an id, a
-- code, a status, a boolean - and every one of those is a token. Prose is not, because prose
-- has spaces in it. That single rule closes the whole family of key-name holes at once: a
-- misspelled key carrying prose is refused, a padded key carrying prose is refused, and
-- "summary" and "narrative" are refused because what they carry is prose, not because
-- their names were guessed at.
--
-- The key blocklist STAYS, normalised and widened, because it catches the case a value
-- rule cannot: a key NAMED for free text carrying a short value, such as
-- {"note": "x"}. It is now the SECONDARY screen rather than the only one, and it says
-- which key it objected to.
--
-- WHAT A LEGITIMATE CALLER DOES. It records identifiers and codes, not phrases. A human
-- phrase in an audit trail is a clinical free text by another name, and refusing it is the
-- point: `audit_logs` has no foreign keys precisely so a trail cannot be erased with the
-- record it describes, which also means a note that lands there outlives the patient row it
-- came from. Where a phrase is genuinely wanted, the caller should record a code and
-- resolve it - and `metadata` is tenant-scoped while a platform operator CANNOT read a
-- tenant's trail, so a stray note is not even visible to the people who would spot it.
--
-- The refusal is LOUD, which is the other half of why an allowlist-shaped rule beats a
-- blocklist here: a blocklist fails silently, and this fails with a message naming the
-- key and the reason.

create or replace function private.audit_metadata_violation(p_metadata jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  -- Keys that NAME free text. Secondary to the value rule, and normalised before the
  -- comparison: the original compared the raw key, so ' note ' was a different key.
  v_blocked_keys text[] := array[
    'note', 'notes', 'content', 'summary', 'narrative', 'comment', 'comments',
    'remarks', 'history', 'story', 'complaint', 'symptoms', 'diagnosis', 'prescription',
    'text', 'body', 'transcript', 'message', 'email_body', 'letter', 'referral',
    'description', 'details', 'reason_text', 'free_text', 'clinical_note'
  ];
  v_violation text;
begin
  if p_metadata is null then
    return null;
  end if;

  with recursive walk(k, v) as (
    -- The root object's members.
    select e.key, e.value
      from jsonb_each(case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end) e
    union all
    -- One level deeper, through objects and through arrays. An array element inherits
    -- its parent's key, because an element has no name of its own.
    select child.k, child.v
      from walk w
      cross join lateral (
        select e2.key as k, e2.value as v
          from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e2
        union all
        select w.k, el.value
          from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) el
      ) child
  )
  select
    case
      when lower(btrim(w.k)) = any (v_blocked_keys)
        then 'the key "' || lower(btrim(w.k)) || '" names clinical free text'
      when jsonb_typeof(w.v) = 'string' and (w.v #>> '{}') ~ '\s'
        then 'the value of "' || lower(btrim(w.k)) || '" contains whitespace, which no identifier-shaped value does'
      when jsonb_typeof(w.v) = 'string' and length(w.v #>> '{}') > 64
        then 'the value of "' || lower(btrim(w.k)) || '" is longer than 64 characters'
    end
    into v_violation
    from walk w
   where w.v is not null
     and (
       lower(btrim(w.k)) = any (v_blocked_keys)
       or (jsonb_typeof(w.v) = 'string' and (w.v #>> '{}') ~ '\s')
       or (jsonb_typeof(w.v) = 'string' and length(w.v #>> '{}') > 64)
     )
   limit 1;

  return v_violation;
end;
$fn$;

comment on function private.audit_metadata_violation(jsonb) is
  'Describes the first thing wrong with audit metadata, or returns NULL when it is acceptable. The screen is a VALUE rule first - a string value must be identifier-shaped, with no whitespace and at most 64 characters - because the harm is in the prose, not in the key name, and a key-name screen cannot see it. The key blocklist is secondary, and catches a key NAMED for free text that carries a short value. A misspelling or a padded key carrying prose is refused by the VALUE rule.';

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

  v_violation := private.audit_metadata_violation(p_metadata);
  if v_violation is not null then
    raise exception 'audit metadata rejected: %', v_violation
      using errcode = 'check_violation';
  end if;

  perform private.write_audit(p_org_id, p_action, p_resource_type, p_resource_id, p_metadata);
end;
$fn$;

comment on function public.write_audit(uuid, text, text, uuid, jsonb) is
  'Appends one row to the audit trail for the calling user. The resource id is optional and may not name a row in another organization. Metadata must describe what HAPPENED in identifiers and codes: a string value with whitespace in it, or a key that names clinical free text, is refused. private.write_audit owns the membership check and the length caps.';
