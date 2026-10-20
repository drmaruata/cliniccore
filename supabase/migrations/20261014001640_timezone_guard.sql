-- Validate the time zone on EVERY write path, not only the one the browser uses.
--
-- WHY A SEPARATE FILE. 01600, 01610, 01620 and 01630 are applied, and an applied
-- migration is never edited.
--
-- WHAT 01630 GOT RIGHT AND WHAT IT MISSED. 01630 added CHECK constraints for the slug and
-- the two names, and a zone check INSIDE the public wrapper. The review found the gap:
-- the wrapper is the CREATE door, and a tenant's fields are also written by the settings
-- UPDATE path.
--
-- MEASURED over real HTTPS, as `authenticated`, as the tenant owner:
--
--   PATCH /rest/v1/organizations?id=eq.<org>  {"timezone":"Not/AZone"}  ->  200, stored
--   PATCH /rest/v1/clinics?id=eq.<clinic>     {"timezone":"Not/AZone"}  ->  200, stored
--
-- Neither `organizations.timezone` nor `clinics.timezone` has a CHECK, and neither is
-- touched by the wrapper, and `organizations_update` / `clinics_update` let any
-- `settings.manage` holder write it. So the same defect class 01630 was written to close
-- was still reachable through the other write path - and the consequence is concrete:
-- `clinicDayBounds` and `formatInClinicTz` THROW `RangeError: Invalid time zone specified`
-- inside billing-window code for that tenant.
--
-- A CHECK CONSTRAINT CANNOT DO THIS. A check may not call a function that reads a table,
-- and the list of installed zones lives in `pg_catalog.pg_timezone_names`. So this is a
-- TRIGGER, which fires on every INSERT and every UPDATE regardless of the door.
--
-- ---------------------------------------------------------------------------
-- THE RULE, and why it is not merely "the name must exist".
--
-- MEASURED: `pg_timezone_names` has 598 entries. 553 are canonical IANA names - they all
-- contain a slash - and 45 do not. Of those 45, ICU accepts 44 and rejects exactly ONE:
-- 'Factory', which is PostgreSQL's own placeholder for a machine with no configured zone.
--
-- So "is the name in pg_timezone_names" is NOT sufficient: it admits 'Factory', and
-- `new Intl.DateTimeFormat("en-CA", { timeZone: "Factory" })` throws. MEASURED over the
-- full list.
--
-- The rule applied here is therefore STRICTER, and stricter on purpose:
--
--   the zone must be a CANONICAL IANA name - it contains a slash - or be exactly 'UTC' or
--   'GMT'.
--
-- That rejects 'Factory' because it is rejected, and it also rejects the 42 other
-- zone-less names, which are legacy aliases and abbreviations: 'CST', 'IST', 'EET',
-- 'Cuba', 'Zulu', 'Universal' and the rest. For a clinic whose BILLING DAY is computed in
-- that zone, an abbreviation is not merely inelegant - 'CST' is ambiguous between Central
-- and China Standard, and 'IST' between India and Israel. A canonical name is the only
-- thing that cannot be misread, and it is the only form that is stable across tzdata
-- releases. A tenant that genuinely wants UTC has 'UTC', or 'Etc/UTC'.
--
-- This also means the rule does not depend on which ICU build is deployed: every canonical
-- name is accepted by every ICU, and every name this rejects is either the one ICU rejects
-- or an ambiguous alias. The one thing that is NOT guaranteed is that a future tzdata
-- release will not add a canonical name ICU has not heard of - which is why the trigger
-- also checks `pg_timezone_names`, so a name the DATABASE does not know is refused rather
-- than stored.

-- ---------------------------------------------------------------------------
-- 1. The guard.

create or replace function private.guard_timezone()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.timezone is null then
    raise exception 'a time zone is required' using errcode = '22023';
  end if;

  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'unknown time zone: %', new.timezone using errcode = '22023';
  end if;

  if new.timezone not like '%/%' and new.timezone not in ('UTC', 'GMT') then
    raise exception 'time zone must be a canonical IANA zone name such as Asia/Kolkata, or UTC; % is an abbreviation or a legacy alias', new.timezone
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

comment on function private.guard_timezone() is
  'Rejects a time zone that is not a canonical IANA name (or UTC/GMT), on every INSERT and UPDATE of organizations and clinics.';

drop trigger if exists organizations_guard_timezone on public.organizations;
create trigger organizations_guard_timezone
  before insert or update on public.organizations
  for each row execute function private.guard_timezone();

drop trigger if exists clinics_guard_timezone on public.clinics;
create trigger clinics_guard_timezone
  before insert or update on public.clinics
  for each row execute function private.guard_timezone();

-- ---------------------------------------------------------------------------
-- 2. The public wrapper, so the CREATE door and the UPDATE door agree.
--
-- The wrapper's own check is now the same rule as the trigger's. The trigger alone would
-- be enough, because it fires on the wrapper's INSERT too - but the wrapper is the door
-- the browser comes through, and a rejection there carries a message the caller can act
-- on, whereas a trigger's message arrives wrapped in a database error. Both are kept
-- because they are the same rule stated twice, and the trigger is the one that cannot be
-- bypassed.

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

  return private.create_organization_with_owner(p_name, p_slug, p_clinic_name, p_timezone);
end;
$fn$;

comment on function public.create_organization_with_owner(text, text, text, text) is
  'Creates an organization, its first clinic and the calling user as owner. The caller must be authenticated. The slug, name, clinic name and time zone are validated HERE as well as by the table constraints and the time zone trigger, because this is the only path a browser can take to create a tenant.';

revoke execute on function public.create_organization_with_owner(text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text) to authenticated;
