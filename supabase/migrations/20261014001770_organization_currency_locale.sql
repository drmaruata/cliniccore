-- Task 16 review fix 4: the tenant's currency and locale are collected, so they are
-- applied.
--
-- WHY. The onboarding form has always asked for a currency and a locale, and the
-- creation RPC - which takes neither - inserted the column defaults. So a clinic that
-- typed USD got INR, with no error and no way to tell. That is not a cosmetic gap:
-- money is stored in the TENANT's currency, so the currency a tenant is born with
-- decides the unit of every amount it will ever hold.
--
-- WHY THE PUBLIC FUNCTION IS THE ONE THAT CHANGES. The browser's only door into
-- tenant creation is `public.create_organization_with_owner`, and PostgREST matches a
-- function on the EXACT set of supplied parameter names - so the two new parameters
-- have to be on the public function, with defaults so that a caller which does not
-- know about them still works.
--
-- WHY THE PRIVATE CREATOR IS UNCHANGED. Its body holds the generated organization
-- role seed, and that block's canonical home is
-- `20261014000600_onboarding_rpc.sql` - the drift guard
-- (`tests/unit/onboarding-seed.test.ts`) reads THAT file. Re-inlining a 250-line
-- generated block into a second migration would leave the guard watching a
-- historical definition rather than the effective one, which is the exact failure the
-- guard exists to catch. So the wrapper creates the tenant and then applies the two
-- settings, in the SAME transaction: no other session can observe the default, and a
-- tenant is never born with a currency it did not ask for.
--
-- The validation stays here, where the rest of the input validation lives: the
-- wrapper is the door, and it has always checked the shape of what it is given
-- before the private creator sees it.

create or replace function public.create_organization_with_owner(
  p_name text,
  p_slug text,
  p_clinic_name text,
  p_timezone text default 'Asia/Kolkata',
  p_currency text default 'INR',
  p_locale text default 'en-IN'
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

  -- THE TENANT'S MONEY. A three-letter code, upper-cased: the column is char(3),
  -- so a two-letter or four-letter code would be padded or truncated into a currency
  -- nobody meant.
  if p_currency is null or (p_currency::text) !~ '^[A-Za-z]{3}$' then
    raise exception 'currency must be a three-letter code such as INR or USD'
      using errcode = '22023';
  end if;

  if p_locale is null or length(p_locale) < 2 or length(p_locale) > 35 then
    raise exception 'locale must be 2 to 35 characters, such as en-IN'
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

  -- THE TENANT'S MONEY AND LOCALE, applied. See the header: the private creator's
  -- signature is fixed by the file that owns the generated role seed, so the two
  -- settings are applied here - in the same transaction as the creation, so no other
  -- session can observe the default.
  update public.organizations
     set currency = upper(p_currency),
         locale = p_locale
   where id = v_org_id;

  insert into public.tenant_creation_events (user_id) values ((select auth.uid()));

  return v_org_id;
end;
$fn$;

comment on function public.create_organization_with_owner(text, text, text, text, text, text) is
  'Creates an organization, its first clinic and the calling user as owner, with the tenant''s currency and locale. The caller must be authenticated, and is limited to five organizations in any 24-hour window.';

revoke execute on function public.create_organization_with_owner(text, text, text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The four-argument version, retired.
--
-- `create or replace` does not replace a function whose signature has changed - it
-- CREATES A NEW OVERLOAD - so the old one has to go, or the public schema would
-- carry two functions with the same name and the generated types would have to pick
-- one. The drop comes AFTER the create on purpose: if the create had failed, the
-- old function would still be there and the feature would still work.
--
-- While both existed, a call with four arguments resolved to the four-argument one -
-- PostgreSQL prefers the candidate that uses FEWER defaults - so the new function was
-- only reachable with all six arguments. After the drop, the six-argument function
-- serves every call, with the two new parameters defaulted.
drop function if exists public.create_organization_with_owner(text, text, text, text);
