-- Let a clinic have no time zone, because the schema says it may, and reject a time zone
-- that is invalid either way.
--
-- WHY A SEPARATE FILE. 20261014001640_timezone_guard.sql is applied, and an applied
-- migration is never edited.
--
-- WHAT 01640 GOT WRONG, AND HOW IT SHOWED. 01640's trigger raised 'a time zone is
-- required' for a NULL zone, on BOTH tables. MEASURED against the catalogue:
--
--   organizations.timezone   NOT NULL, DEFAULT 'Asia/Kolkata'
--   clinics.timezone         NULLABLE, no default
--
-- `clinics.timezone` is NULLABLE BY DESIGN - migration 00300 created it that way - so
-- refusing a NULL there rejected a state the schema permits, and 50 tests in
-- tests/security/rls-policies.test.ts and tests/security/storage-policies.test.ts failed
-- with 'a time zone is required'. They insert clinics without a zone:
--
--   insert into public.clinics (id, organization_id, name) values ($1,$4,'Clinic 1'), ...
--
-- So the guard was wrong, not the tests. A validation rule that refuses a state the
-- database is designed to hold is not a stricter rule; it is a broken one, and it shows up
-- as fifty unrelated failures.
--
-- WHAT IS UNCHANGED. A zone that is PRESENT and invalid is still refused, on both tables,
-- on every write path. That is the defect 01640 was written to close - the settings UPDATE
-- path accepting 'Not/AZone' - and it stays closed.
--
-- WHAT REMAINS OPEN, and it is pre-existing rather than introduced here. A clinic with NO
-- zone is a landmine: `clinicDayBounds` and `formatInClinicTz` take a zone string, and
-- `Intl.DateTimeFormat` treats a nullish zone as "use the runtime's default", so a clinic
-- with no zone would silently bill in the SERVER's day rather than its own. MEASURED:
-- `new Intl.DateTimeFormat("en-CA", { timeZone: null })` does not throw - it uses the
-- system zone. The correct fix is to make `clinics.timezone` NOT NULL with a default, the
-- way `organizations.timezone` already is, which is a schema change and therefore its own
-- piece of work. Recorded in docs/IMPLEMENTATION_STATUS.md rather than smuggled in here,
-- because a nullability change is a product decision about what a clinic is, not a
 * validation detail.

create or replace function private.guard_timezone()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.timezone is null then
    -- organizations.timezone is NOT NULL, so this cannot happen there; the check is
    -- defence in depth. clinics.timezone is NULLABLE by design, so a clinic with no zone
    -- is a permitted state and this trigger must not refuse it.
    if TG_TABLE_NAME = 'organizations' then
      raise exception 'a time zone is required' using errcode = '22023';
    end if;
    return new;
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
  'Rejects a time zone that is present and is not a canonical IANA name (or UTC/GMT), on every INSERT and UPDATE of organizations and clinics. A null zone is refused for organizations, whose column is NOT NULL, and permitted for clinics, whose column is nullable by design.';

drop trigger if exists organizations_guard_timezone on public.organizations;
create trigger organizations_guard_timezone
  before insert or update on public.organizations
  for each row execute function private.guard_timezone();

drop trigger if exists clinics_guard_timezone on public.clinics;
create trigger clinics_guard_timezone
  before insert or update on public.clinics
  for each row execute function private.guard_timezone();
