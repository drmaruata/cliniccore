-- Task 16 review, round 2: the creation cap gets its OWN SQLSTATE.
--
-- WHY. The onboarding action mapped PostgREST error code 23514 - which is
-- `check_violation`, a CLASS and not a cause - to "you have created five clinics in
-- the last day". Every check violation in the database shares that code, so the
-- message was about what the cap does rather than about what happened: a different
-- check violation in the same path would have been reported as the cap.
--
-- THE CAP NOW RAISES 53400, `configuration_limit_exceeded` - a class of its own, and
-- a truer description of a rate limit than a check violation is.
--
-- THE CAP'S RULE MOVES INTO ITS OWN FUNCTION, so the rule and the code that reports
-- it live in one place and a later change to either does not have to hunt for the
-- other. The public creation function is redefined here for that reason: the check
-- was inline in its body, and the body is what has to change.
--
-- The four-argument signature is untouched - this is a redefinition of the same
-- function, not a new one, so the generated types and the wrapper's argument
-- contract are unaffected.

create or replace function private.creation_cap_reached()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select (
    select count(*)
      from public.tenant_creation_events
     where user_id = (select auth.uid())
       and created_at > now() - interval '24 hours'
  ) >= 5;
$fn$;

comment on function private.creation_cap_reached() is
  'Whether the calling user has already created five organizations in the last 24 hours. The cap, in one place, so the rule and the code that reports it cannot drift apart.';

revoke execute on function private.creation_cap_reached() from public;

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

  -- C1. The cap. Taken in the same transaction as the creation, so a creation that
  -- fails does not consume the allowance, and reported with its OWN code, so the
  -- client can say what actually happened.
  if private.creation_cap_reached() then
    raise exception 'too many organizations created in the last 24 hours; contact support if you need more'
      using errcode = '53400';
  end if;

  v_org_id := private.create_organization_with_owner(p_name, p_slug, p_clinic_name, p_timezone);

  -- THE TENANT'S MONEY AND LOCALE, applied. See 01770: the private creator's signature
  -- is fixed by the file that owns the generated role seed, so the two settings are
  -- applied here - in the same transaction as the creation, so no other session can
  -- observe the default.
  update public.organizations
     set currency = upper(p_currency),
         locale = p_locale
   where id = v_org_id;

  insert into public.tenant_creation_events (user_id) values ((select auth.uid()));

  return v_org_id;
end;
$fn$;

comment on function public.create_organization_with_owner(text, text, text, text, text, text) is
  'Creates an organization, its first clinic and the calling user as owner, with the tenant''s currency and locale. The caller must be authenticated, and is limited to five organizations in any 24-hour window - which is reported as 53400, configuration_limit_exceeded.';

revoke execute on function public.create_organization_with_owner(text, text, text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text, text, text) to authenticated;
