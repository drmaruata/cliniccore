-- Task 17: the platform console's door into the database.
--
-- TWO FUNCTIONS, AND WHY THE PLATFORM CONSOLE CANNOT WORK WITHOUT THEM.
--
-- `private.is_platform_admin()` is the predicate the design spec names: it answers
-- "is the CALLING user a platform administrator" from `profiles.is_platform_admin`,
-- and it deliberately does NOT check the organization's status, because a platform
-- operator has to keep seeing suspended and archived tenants in order to restore
-- them.
--
-- But the browser - and the Next.js server, which talks to Postgres over the same
-- PostgREST - CANNOT REACH THE `private` SCHEMA. MEASURED, twice: `GET /rest/v1/`
-- reports "standard public schema", and a POST to `/rest/v1/rpc/<fn>` naming any
-- `private.*` function answers PGRST202 naming `public` as the schema it searched.
-- So the gate the `/platform` segment needs was, before this file, unreachable from
-- the only place that could evaluate it.
--
-- The alternative - reading `profiles.is_platform_admin` in TypeScript and deciding
-- the question there - would put the rule in the application as well as in the
-- database, and this repository has already been bitten twice by a rule that
-- existed in two places (the platform-key clause, and the grant ceiling). The
-- house rule is that the rules live in ONE place and the application asks.
--
-- `public.is_platform_admin()` is therefore a THIN WRAPPER, exactly as
-- `public.can` and `public.has_any_membership()` are: it adds no decision of its
-- own, and the rule stays in `private`.
--
-- `public.tenant_directory()` is the console's data access, and it is a definer
-- for a reason that is NOT about privilege escalation - it is about VISIBILITY.
--
-- `organization_memberships_select`'s row filter is `private.is_member(organization_id)`,
-- and `is_member` requires an ACTIVE membership in an ACTIVE organization. A
-- platform operator belongs to no tenant, so the membership rows of every tenant
-- are filtered out of their view - and a member count taken from an ordinary
-- read of that table would be ZERO for every tenant, including the ones the
-- operator exists to inspect. The count therefore has to be taken by a definer,
-- which sees the rows the policies hide.
--
-- WHAT IT RETURNS, AND WHY IT IS EXACTLY THREE COLUMNS. The brief names three
-- things - organization names, statuses and member counts - and this function
-- returns exactly those. It cannot return an id, a slug, a clinic or a patient,
-- so the "no patient data is reachable from this route" property is a property of
-- the FUNCTION'S SIGNATURE and not of a reviewer's reading of the page. The
-- membership count is an aggregate: it discloses that a tenant has N staff, and
-- not who they are.
--
-- The count is of membership ROWS in any state. A suspended membership is still a
-- membership, and how a tenant chooses to suspend its staff is the tenant's own
-- business - the platform console is a directory, not a tenant's roster.

-- ---------------------------------------------------------------------------
-- 1. The predicate, exposed once.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.is_platform_admin();
$fn$;

comment on function public.is_platform_admin() is
  'Whether the calling user is a platform administrator. Delegates to private.is_platform_admin, which owns the rule, and deliberately ignores the organization''s status so that an operator can still see a suspended tenant.';

revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.is_platform_admin() from anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The tenant directory.

create or replace function public.tenant_directory()
returns table (
  name text,
  status text,
  member_count integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select o.name,
         o.status,
         (
           select count(*)::integer
             from public.organization_memberships m
            where m.organization_id = o.id
         )
    from public.organizations o
   -- THE GATE IS IN HERE TOO, not only in the route that calls this function. A
   -- definer bypasses row-level security, so the function that reads the
   -- directory has to check the caller's authority itself - and a caller that is
   -- not a platform administrator gets an empty directory rather than the
   -- tenants.
   where (select private.is_platform_admin())
   order by o.name;
$fn$;

comment on function public.tenant_directory() is
  'The tenant directory: one row per organization with its name, its status and its member count, and nothing else. Refuses a caller that is not a platform administrator by returning no rows. The member count is taken by a definer because row-level security hides other tenants'' memberships from a platform operator.';

revoke execute on function public.tenant_directory() from public;
revoke execute on function public.tenant_directory() from anon;
grant execute on function public.tenant_directory() to authenticated;
