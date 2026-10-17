-- Task 8: the audit log and platform settings.
--
-- audit_logs is append-only, and that is a POLICY property rather than a
-- database guarantee: Task 9 gives authenticated users a SELECT policy and no
-- UPDATE or DELETE policy, so no application path can mutate a row. It is not
-- tamper-proof - a service-role connection can rewrite anything, and the role
-- that applies these migrations is exactly that. Read "append-only" as "no
-- application path to change a row", never as "immutable".
--
-- Neither organization_id nor actor_user_id carries a foreign key, deliberately.
-- An audit trail has to outlive the row it describes: a cascade from organizations
-- would erase a tenant's history the moment the tenant was deleted, and a cascade
-- from auth.users would erase it when the actor's account was closed - which is
-- exactly when you most want to know what they did.
--
-- private.write_audit is the only supported way to write a row, and it refuses
-- metadata carrying a key named note, notes or content. Audit metadata records
-- WHICH patient and WHEN; a note field is how clinical free text ends up in a
-- table with a different access and retention story from the chart. The walk
-- descends into objects AND arrays at any depth, because a jsonpath wildcard
-- silently skips array elements - a `{"items":[{"note":...}]}` payload would have
-- passed a jsonpath check.
--
-- It is a KEY-NAME blocklist, so it is a speed bump against accidental or casual
-- smuggling, not a guarantee: `summary`, `narrative` or a misspelling passes it,
-- and so does clinical text placed under an approved key. Payload discipline
-- remains the application's responsibility, and this function is not the place
-- to look for one.

create table if not exists public.audit_logs (
  id bigserial primary key,
  organization_id uuid,
  actor_user_id uuid,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create index if not exists audit_logs_org_created_idx
  on public.audit_logs (organization_id, created_at desc);

alter table public.audit_logs enable row level security;
alter table public.platform_settings enable row level security;

create or replace function private.write_audit(
  p_org_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid default null,
  p_metadata jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_free_text_found boolean;
begin
  -- Platform-scoped events (organization_id NULL) are reserved for platform
  -- operators. Platform authority is the profiles.is_platform_admin boolean and
  -- nothing else, and the same reasoning that keeps private.can away from
  -- platform.* permissions keeps a tenant from forging platform audit entries.
  if p_org_id is null and not (select private.is_platform_admin()) then
    raise exception 'platform audit events require a platform administrator'
      using errcode = '42501';
  end if;

  with recursive walk(obj, depth) as (
    select coalesce(p_metadata, '{}'::jsonb), 0
    union all
    select child, w.depth + 1
      from walk w
     cross join lateral (
        select e.value as child
          from jsonb_each(case when jsonb_typeof(w.obj) = 'object' then w.obj else '{}'::jsonb end) e
       union all
        select el.value
          from jsonb_array_elements(case when jsonb_typeof(w.obj) = 'array' then w.obj else '[]'::jsonb end) el
     ) c
     where w.depth < 32
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

revoke execute on function private.write_audit(uuid, text, text, uuid, jsonb) from public;
grant execute on function private.write_audit(uuid, text, text, uuid, jsonb) to authenticated;
