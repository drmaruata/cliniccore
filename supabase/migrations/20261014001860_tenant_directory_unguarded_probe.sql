-- Task 17 review round 2, MEASUREMENT PROBE: `public.tenant_directory()` with its
-- guard removed.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE IS, AND WHY IT IS A MIGRATION AND NOT AN EDIT.
--
-- The applied migration 20261014001850 is never edited, so the mutation is applied
-- here as a CORRECTION - the house way - and the next file restores the function
-- byte-for-byte. Between this file and 20261014001870 the function answers the tenant
-- directory to ANY signed-in caller. The window is the measurement below, and it is
-- recorded rather than glossed over.
--
-- ---------------------------------------------------------------------------
-- WHAT IS MEASURED, AND WHY IT MATTERS.
--
-- `tests/integration/platform-console.test.ts` asserts over real HTTPS that a signed-in
-- user who is not a platform administrator receives an EMPTY directory. That assertion
-- had no positive control: the database held no organization, so an UNGUARDED function
-- would have answered `[]` too, and the test proved the transport rather than the
-- refusal.
--
-- The test now seeds one organization, asserts the predicate over the same token, and
-- asserts that an ADMINISTRATOR's token receives that row. With the guard in place the
-- pair passes. With the guard REMOVED - which is what this file does - the
-- non-administrator receives the seeded row and the assertion FAILS.
--
-- MEASURED: with this file applied, the non-administrator's assertion fails with the
-- seeded organization in the response, and the administrator's still passes. The
-- function body is restored byte-for-byte by 20261014001870 - `md5(prosrc)` back to
-- 5365ccdf74d4d73685c9afbd763d1bdf.
--
-- The body below is the 01850 body with ONE clause removed: the
-- `where (select private.is_platform_admin())` that is the whole guard.

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
   order by o.name;
$fn$;

comment on function public.tenant_directory() is
  'MEASUREMENT PROBE - the guard is removed on purpose, and the next migration restores it. See 20261014001860 and 20261014001870.';
