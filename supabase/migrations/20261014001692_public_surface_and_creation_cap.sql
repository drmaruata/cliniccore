-- Complete the public surface, and put bounds on what a signed-in user can do with it.
--
-- ---------------------------------------------------------------------------
-- B2. THE PUBLIC SURFACE CAN CREATE A TENANT BUT NOT DELETE ONE.
--
-- A user who creates a tenant by mistake had no product-level remedy: there was no public
-- counterpart to `public.create_organization_with_owner`. Now there is, and it is
-- deliberately narrow - only a holder of `settings.manage` in THAT organization may delete
-- it, checked with `private.can`, which evaluates `auth.uid()` and so answers for the
-- CALLER even though the wrapper runs as the owner.
--
-- The delete itself now works, because 20261014001670 made `private.guard_role_delete`
-- distinguish a CASCADE from a deliberate role deletion.
--
-- ---------------------------------------------------------------------------
-- C1. ORGANIZATION CREATION WAS UNCAPED.
--
-- MEASURED: a signed-in user could create an unbounded number of tenants, and each call
-- re-upserted the twenty-one global `permissions` rows, taking row locks on them, so
-- concurrent onboardings SERIALIZED. That is write amplification and a global contention
-- point, and the unboundedness is a storage-abuse vector - made worse by the fact that a
-- created tenant was undeletable, which 01670 fixed.
--
-- The cap is per USER over a rolling window, which is the shape that actually matters:
-- a cap per organization would be no cap at all, because the user creates the
-- organizations.
--
-- A cap belongs at the DOOR rather than in the table, and this is the door: the count is
-- taken and the event recorded inside the public wrapper, in the same transaction as the
-- creation, so a failed creation does not consume the user's allowance. A column DEFAULT
-- could not do this - it cannot count rows - and a column CHECK could not either.
--
-- `tenant_creation_events` is RLS deny-all and unwritable by `authenticated`; only the
-- definer writes it, so a user cannot lift their own cap by deleting the evidence.
--
-- ---------------------------------------------------------------------------
-- C2. `public.write_audit` ACCEPTED AN ARBITRARY `p_resource_id`.
--
-- MEASURED: a tenant could file a row in its OWN audit trail referencing another
-- tenant's row id. No disclosure - the trail is the caller's own and the actor is
-- attributed correctly - but the trail pointed at rows it had no business naming, and an
-- audit trail that can be made to lie about what happened to whom is worth fixing.
--
-- The check: if the id matches a row in one of the organization-scoped tables, that row
-- must belong to the organization the event is filed under. Ids that match nothing are
-- allowed, because an audit event may legitimately refer to something that has since been
-- deleted.

-- ---------------------------------------------------------------------------
-- 1. The creation ledger.

create table if not exists public.tenant_creation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists tenant_creation_events_user_recent_idx
  on public.tenant_creation_events (user_id, created_at desc);

alter table public.tenant_creation_events enable row level security;

revoke all on public.tenant_creation_events from anon, authenticated;

comment on table public.tenant_creation_events is
  'One row per organization a user creates, so the creation rate can be capped. Written only by the definer that creates organizations; unwritable by any client.';

-- ---------------------------------------------------------------------------
-- 2. The cap, and the delete counterpart.

create or replace function public.create_organization_with_owner(
  p_name text,
  p_slug text,
  p_clinic_name text,
  p_timezone text default 'Asia/Kolkata'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_org_id uuid;
begin
  if p_slug is null
     or (p_slug::text) !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or length(p_slug) < 3
     or length(p_slug) > 48 then
    raise exception 'organization slug must be lowercase kebab-case, 3 to 48 characters'
      using errcode = '22023';
  end if;

  if p_name is null or length(p_name) < 1 or length(p_name) > 120 then
    raise exception 'organization name must be 1 to 120 characters'
      using errcode = '22023';
  end if;

  if p_clinic_name is null or length(p_clinic_name) < 1 or length(p_clinic_name) > 120 then
    raise exception 'clinic name must be 1 to 120 characters'
      using errcode = '22023';
  end if;

  if p_timezone is null
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'unknown time zone: %', coalesce(p_timezone, 'null')
      using errcode = '22023';
  end if;

  if p_timezone not like '%/%' and p_timezone not in ('UTC', 'GMT') then
    raise exception 'time zone must be a canonical IANA zone name such as Asia/Kolkata, or UTC; % is an abbreviation or a legacy alias', p_timezone
      using errcode = '22023';
  end if;

  -- C1. The cap. Taken in the same transaction as the creation, so a creation that fails
  -- does not consume the allowance.
  if (
    select count(*)
      from public.tenant_creation_events
     where user_id = (select auth.uid())
       and created_at > now() - interval '24 hours'
  ) >= 5 then
    raise exception 'too many organizations created in the last 24 hours; contact support if you need more'
      using errcode = '23514';
  end if;

  v_org_id := private.create_organization_with_owner(p_name, p_slug, p_clinic_name, p_timezone);

  insert into public.tenant_creation_events (user_id) values ((select auth.uid()));

  return v_org_id;
end;
$fn$;

comment on function public.create_organization_with_owner(text, text, text, text) is
  'Creates an organization, its first clinic and the calling user as owner. The caller must be authenticated, and is limited to five organizations in any 24-hour window.';

revoke execute on function public.create_organization_with_owner(text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text) to authenticated;

create or replace function public.delete_organization(p_org_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  if p_org_id is null then
    raise exception 'an organization id is required' using errcode = '22023';
  end if;

  -- private.can evaluates auth.uid(), so this answers for the CALLER even though the
  -- wrapper runs as the owner.
  if not private.can(p_org_id, 'settings.manage') then
    raise exception 'only an administrator of this organization may delete it'
      using errcode = '42501';
  end if;

  delete from public.organizations where id = p_org_id;
  if not found then
    raise exception 'no such organization' using errcode = 'P0002';
  end if;

  return true;
end;
$fn$;

comment on function public.delete_organization(uuid) is
  'Deletes an organization the calling user administers, together with everything under it. Requires settings.manage in that organization.';

revoke execute on function public.delete_organization(uuid) from public;
revoke execute on function public.delete_organization(uuid) from anon;
grant execute on function public.delete_organization(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. C2. An audit event may not point at another tenant's row.

create or replace function private.audit_resource_belongs_to_org(
  p_org_id uuid,
  p_resource_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select not exists (
    select 1 from public.patients x where x.id = p_resource_id and x.organization_id <> p_org_id
    union all
    select 1 from public.clinics x where x.id = p_resource_id and x.organization_id <> p_org_id
    union all
    select 1 from public.organization_memberships x where x.id = p_resource_id and x.organization_id <> p_org_id
    union all
    select 1 from public.user_role_assignments x where x.id = p_resource_id and x.organization_id <> p_org_id
    union all
    select 1 from public.roles x where x.id = p_resource_id and x.organization_id is not null and x.organization_id <> p_org_id
    union all
    select 1 from public.invitations x where x.id = p_resource_id and x.organization_id <> p_org_id
  );
$fn$;

comment on function private.audit_resource_belongs_to_org(uuid, uuid) is
  'Whether an audit event may name a resource id: if the id matches a row in an organization-scoped table, that row must belong to the organization the event is filed under. Ids that match nothing are allowed, because an event may refer to something since deleted.';

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

  perform private.write_audit(p_org_id, p_action, p_resource_type, p_resource_id, p_metadata);
end;
$fn$;

comment on function public.write_audit(uuid, text, text, uuid, jsonb) is
  'Appends one row to the audit trail for the calling user. The resource id is optional, and may not name a row in another organization. private.write_audit owns the membership check, the length caps and the refusal of clinical free-text keys.';

revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from public;
revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from anon;
grant execute on function public.write_audit(uuid, text, text, uuid, jsonb) to authenticated;
