-- Validate what the browser can now write, at BOTH the door and the table.
--
-- WHY THIS FILE EXISTS. The public RPC surface made tenant creation reachable by any
-- signed-in browser, and the review found that it was the ONLY way to create a tenant -
-- and that it bypassed the application's only input validation.
-- `lib/validation/auth.ts` says of the slug:
--
--   "The slug is the tenant key used in URLs, so it is constrained to lowercase kebab-case
--    rather than left free - a slug containing a slash or an uppercase letter breaks routing
--    later, far from here."
--
-- MEASURED over real HTTPS, as `authenticated`, against the public RPC:
--
--   p_slug = 'a/b/../1792483964879'   -> 200, stored VERBATIM
--   p_timezone = 'Not/AZone'            -> 200, stored
--   p_name of 2 000 000 characters      -> 200, stored
--   p_slug of 100 000 characters        -> 200, stored
--
-- And MEASURED in the catalogue: `organizations.slug` has NO CHECK constraint - only
-- `organizations_slug_key UNIQUE (slug)` - and `timezone` is bare text. So the database
-- enforced nothing, and the zod schema was the only validation in the system, on the
-- client, which is exactly where validation does not belong.
--
-- ---------------------------------------------------------------------------
-- 1. THE CONSTRAINTS, because they apply to EVERY write path.
--
-- A constraint is stronger than a function check, because it holds for a migration, for
-- service_role, and for anything that writes the table by another route. The slug
-- constraint is the important one: the slug IS the tenant key, so a slash in it is not a
-- cosmetic problem but a routing one, and Task 17 is the task that builds those routes.
--
-- `slug` is `citext`, and `slug::text` yields the value AS ENTERED rather than a
-- lowercased one, so the constraint is on the spelling the caller actually chose. The
-- application's schema lowercases before sending, so a conforming caller is unaffected,
-- and a caller that sends 'Northside-Clinic' is now refused rather than quietly
-- creating a second tenant that differs only in case.
--
-- The existing table is empty, so the constraints validate immediately.
--
-- ---------------------------------------------------------------------------
-- 2. THE TIME ZONE, which cannot be a constraint.
--
-- A CHECK constraint may not call a function that reads a table, and the list of
-- installed zones lives in `pg_catalog.pg_timezone_names`. So the zone is checked in the
-- PUBLIC wrapper - which is the door the browser comes through, and which is now the only
-- reachable path to the private function, since `authenticated` no longer has EXECUTE on it.
--
-- An unknown zone is not a cosmetic problem either: `Intl.DateTimeFormat` THROWS on an
-- unknown zone, so a tenant with one would make `clinicDayBounds` and `formatInClinicTz`
-- throw a RangeError inside billing-window code.
--
-- The validation lives in the wrapper rather than in the private function for a practical
-- reason: the private function's body is long, and replacing it wholesale to add four
-- guards would be a large, hard-to-review diff for a change that is four conditions long.
-- The private function is no longer reachable by `authenticated`, so validating at the
-- public door is sufficient - and the constraints above cover the table regardless.

-- ---------------------------------------------------------------------------
-- 3. The constraints.

alter table public.organizations
  add constraint organizations_slug_format_check
  check ((slug::text) ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  add constraint organizations_slug_length_check
  check (length(slug::text) between 3 and 48),
  add constraint organizations_name_length_check
  check (length(name) between 1 and 120);

alter table public.clinics
  add constraint clinics_name_length_check
  check (length(name) between 1 and 120);

-- ---------------------------------------------------------------------------
-- 4. The wrapper, which now validates the timezone.

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

  -- An unknown zone makes Intl.DateTimeFormat THROW, so a tenant with one would break
  -- clinicDayBounds and formatInClinicTz inside billing-window code. The zone list is a
  -- view, so this cannot be a CHECK constraint.
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'unknown time zone: %', p_timezone using errcode = '22023';
  end if;

  return private.create_organization_with_owner(p_name, p_slug, p_clinic_name, p_timezone);
end;
$fn$;

comment on function public.create_organization_with_owner(text, text, text, text) is
  'Creates an organization, its first clinic and the calling user as owner. The caller must be authenticated. The slug, name, clinic name and time zone are validated HERE as well as by CHECK constraints, because this is the only path a browser can take to create a tenant.';

revoke execute on function public.create_organization_with_owner(text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text) to authenticated;
