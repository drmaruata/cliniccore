-- Task 8 hardening: the two definer functions were missing their membership check,
-- the audit screen had a depth hole and no size cap, and audit_logs was one policy
-- typo away from being mutable.
--
-- New file rather than edits to 00700/00800: the migration-edit exception closed
-- once 00300 landed, so corrections are additive from here on. Both functions are
-- re-created here; the tests read the LAST definition of each, so they pick this
-- up automatically.
--
-- 1. private.write_audit accepted any p_org_id. It is SECURITY DEFINER owned by
--    postgres with relforcerowsecurity = false on every table, so it bypasses RLS
--    entirely and Task 9's policies are no backstop: any authenticated user of the
--    SaaS could plant fabricated rows in another tenant's audit trail, with
--    unconstrained action/resource_type text that would read as though the tenant
--    had exported its patients, and with the free-text screen bypassed wholesale by
--    simply using a different column. For a PHI product that is audit
--    falsification. private.is_member now gates it, and because is_member honours
--    organizations.status it also refuses writes for a suspended tenant.
--
-- 2. private.next_sequence_value had the same hole: any authenticated user could
--    bump any organization's counter, which the plan's own standing rule calls out
--    as the thing RLS on tenant_sequences exists to prevent. Same guard.
--
-- 3. The audit screen's depth bound was defeatable AND the header claimed the walk
--    descended "at any depth". jsonb is a tree and cannot be cyclic, so the
--    recursion always terminates - the depth predicate was buying nothing except a
--    hole - and it is gone. The size cap below now bounds the work.
--
-- 4. authenticated holds INSERT/UPDATE/DELETE on audit_logs from Supabase's
--    default grants (00400 revoked only truncate/references/trigger). Append-only
--    currently rests entirely on Task 9 writing no update or delete policy; that is
--    a promise about a future file. Revoked at the table, so the property survives
--    a mistyped policy. Task 9's SELECT policy is unaffected, and
--    private.write_audit still writes because it runs as the owner.
--
-- PARTIALLY SUPERSEDED by 20261014000820_audit_writer_and_caps.sql, which widens
-- the writer predicate to admit a platform administrator (so a suspension event
-- has a writer) and bounds p_action and p_resource_type as well as metadata.
-- Read this header with that file in hand.
--
-- The free-text screen remains a key-name blocklist and the header says so:
-- `summary`, `narrative`, a misspelling, or a key with surrounding whitespace all
-- pass it. It catches casual smuggling, not a determined one.

revoke insert, update, delete on table public.audit_logs from anon, authenticated;

create or replace function private.next_sequence_value(p_org_id uuid, p_sequence_key text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_next bigint;
begin
  if not (select private.is_member(p_org_id)) then
    raise exception 'sequence values may only be drawn for your own organization'
      using errcode = '42501';
  end if;

  insert into public.tenant_sequences as ts (organization_id, sequence_key, next_value)
  values (p_org_id, p_sequence_key, 1)
  on conflict (organization_id, sequence_key)
  do update set next_value = ts.next_value + 1, updated_at = now()
  returning ts.next_value into v_next;

  return v_next;
end;
$fn$;

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
  -- Two refusals, and both matter. A tenant may only write its own trail, and a
  -- platform-scoped entry (organization_id NULL) is reserved for platform
  -- operators. Without the first, any authenticated user could falsify another
  -- tenant's audit history; without the second, they could forge platform events.
  if p_org_id is not null and not (select private.is_member(p_org_id)) then
    raise exception 'audit events may only be written for your own organization'
      using errcode = '42501';
  end if;

  if p_org_id is null and not (select private.is_platform_admin()) then
    raise exception 'platform audit events require a platform administrator'
      using errcode = '42501';
  end if;

  -- Bound the work before walking it: each node becomes two CTE rows carrying a
  -- jsonb copy, so an unbounded array is a denial-of-service vector reachable by
  -- any authenticated user, and a single huge string value would otherwise be
  -- stored as one enormous audit row.
  if octet_length(coalesce(p_metadata, '{}'::jsonb)::text) > 8192 then
    raise exception 'audit metadata exceeds 8 KiB'
      using errcode = 'check_violation';
  end if;

  -- No depth bound: jsonb is a tree and cannot be cyclic, so the recursion always
  -- terminates. The previous `depth < 32` was not a safety net, only a hole - a
  -- key nested 33 levels deep passed the screen.
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
