-- Give `patients.export` an enforcement point, settle what `roles.is_system` means, and
-- stop the audit metadata screen from being evadable with a key name.
--
-- ---------------------------------------------------------------------------
-- B4. `patients.export` HAD NO ENFORCEMENT POINT ANYWHERE.
--
-- The registry carries `patients.export` - "Export patient data from the organization" - and
-- the plan records the concern: "RLS is row-level and grants no column or aggregate
-- control; `patient_identifiers_select` hands a read-only holder every identifier value,
-- one row at a time."
--
-- That is not fixable by a policy, and pretending otherwise would be the wrong answer: RLS
-- cannot distinguish a clinician reading one patient from an export of every patient. The
-- enforcement point for an EXPORT is a definer function, and there was none - so the
-- permission existed in the registry, in the seed and in the role matrix, and did nothing.
--
-- `public.export_patients` is that point. It requires `patients.export` explicitly, and
-- because it is a definer it is the ONLY gate - which is why the permission check is
-- inside it and not merely in the row policies underneath.
--
-- Reading a patient's identifiers one at a time stays as it was: a clinician who may read
-- a patient may read that patient's identifiers, which is the clinical need. What is now
-- bounded is the BULK read, and it is bounded by a permission that had no enforcement
-- point before.
--
-- ---------------------------------------------------------------------------
-- B5. `roles.is_system` HAD THREE DESCRIPTIONS AND NO TWO AGREED.
--
-- The plan says "marks seeded roles". The generator's HEADER says the same thing. The
-- generator's CODE writes `role.isPlatform`, and the column therefore marks a PLATFORM
-- role - one with `organization_id IS NULL` - and not a seeded one, since every tenant role
-- is seeded too.
--
-- The disagreement is not harmless: it is what let a defect hide from two review passes.
--
-- The column is also WRITE-ONLY and INERT - nothing reads it. `01230` stopped relying on it
-- and uses the real invariant instead, `not private.role_in_use(id)`: a role nobody holds
-- can be deleted. `guard_role_identity` freezes it.
--
-- So the fix is to make the CODE and its comment agree, and to state the meaning ONCE, on
-- the column itself, where anyone reading the schema will find it. The plan's sentence is a
-- historical document and is not rewritten; this comment supersedes it.
--
-- ---------------------------------------------------------------------------
-- B6. THE AUDIT FREE-TEXT SCREEN WAS A BLOCKLIST, AND THE BLOCKLIST HAD HOLES.
--
-- MEASURED: `private.write_audit` refuses metadata carrying a key named `note`, `notes` or
-- `content`. But a key named `summary` or `narrative` passes it, a MISSPELLED key passes
-- it, and - because the comparison was on the raw key - a key with SURROUNDING WHITESPACE
-- passes it. So the screen was not "clinical free text is refused" but "these three
-- spellings are refused".
--
-- The keys are normalised before the check - trimmed and lower-cased - and the blocklist is
-- widened to the words that carry clinical prose. That is still a blocklist, and it is still
-- evadable by a word nobody thought of; the real closure is an ALLOWLIST of the metadata
-- keys the application actually emits, which cannot be written until the application
-- defines that shape. Recorded, not pretended away.

-- ---------------------------------------------------------------------------
-- 1. B4. The export seam.

create or replace function public.export_patients(
  p_org_id uuid,
  p_clinic_id uuid default null
)
returns setof public.patients
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.*
    from public.patients p
   where p.organization_id = p_org_id
     and (p_clinic_id is null or p.clinic_id = p_clinic_id)
     and private.can(p_org_id, 'patients.export', p_clinic_id)
     and (p_clinic_id is null or p_clinic_id in (select private.clinic_ids(p_org_id)));
$fn$;

comment on function public.export_patients(uuid, uuid) is
  'Bulk export of a tenant''s patients, gated on the patients.export permission. A definer function, because RLS is row-level and cannot distinguish reading one patient from exporting every patient - so this is the enforcement point for that permission.';

revoke execute on function public.export_patients(uuid, uuid) from public;
revoke execute on function public.export_patients(uuid, uuid) from anon;
grant execute on function public.export_patients(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. B5. One meaning, stated on the column.

comment on column public.roles.is_system is
  'Marks a PLATFORM role - one whose organization_id is NULL - not a seeded role: every tenant role is seeded too. Supersedes the plan''s earlier wording, which said "marks seeded roles" while the seed wrote isPlatform, and which is what let a defect hide from two review passes. WRITE-ONLY and INERT: nothing reads it. 01230 replaced its use with the real invariant, not private.role_in_use(id) - a role nobody holds can be deleted - and guard_role_identity freezes the value.';

-- ---------------------------------------------------------------------------
-- 3. B6. Normalise the metadata keys, and widen the blocklist.

create or replace function private.audit_metadata_has_free_text(p_metadata jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_key text;
  v_blocked text[] := array[
    'note', 'notes', 'content', 'summary', 'narrative', 'comment', 'comments',
    'remarks', 'history', 'story', 'complaint', 'symptoms', 'diagnosis', 'prescription',
    'text', 'body', 'transcript', 'message', 'email_body', 'letter', 'referral'
  ];
begin
  if p_metadata is null then
    return false;
  end if;

  -- Every key, at every depth, NORMALISED: trimmed and lower-cased. The original compared
  -- the raw key, so a key with surrounding whitespace or a capital letter walked straight
  -- past it.
  for v_key in
    select k
      from jsonb_path_query(p_metadata, 'strict $.**.keyvalue()') as j
      cross join lateral jsonb_each_text(j.value) as e(k, v)
  loop
    if lower(btrim(v_key)) = any (v_blocked) then
      return true;
    end if;
  end loop;

  return false;
end;
$fn$;

comment on function private.audit_metadata_has_free_text(jsonb) is
  'Whether audit metadata carries a key that smells of clinical free text. Keys are normalised - trimmed and lower-cased - before the check, because the original compared the raw key and a key with surrounding whitespace or a capital letter passed it. Still a blocklist: an ALLOWLIST of the keys the application emits is the real closure, and cannot be written until that shape exists.';

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
begin
  if p_resource_id is not null
     and not private.audit_resource_belongs_to_org(p_org_id, p_resource_id) then
    raise exception 'an audit event may not reference a resource in another organization'
      using errcode = '42501';
  end if;

  if private.audit_metadata_has_free_text(p_metadata) then
    raise exception 'audit metadata must not carry clinical free-text keys (note, notes, content, summary, narrative, and the rest of the list)'
      using errcode = 'check_violation';
  end if;

  perform private.write_audit(p_org_id, p_action, p_resource_type, p_resource_id, p_metadata);
end;
$fn$;

comment on function public.write_audit(uuid, text, text, uuid, jsonb) is
  'Appends one row to the audit trail for the calling user. The resource id is optional and may not name a row in another organization. Metadata is screened for clinical free-text keys before the row is written. private.write_audit owns the membership check and the length caps.';

revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from public;
revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from anon;
grant execute on function public.write_audit(uuid, text, text, uuid, jsonb) to authenticated;
