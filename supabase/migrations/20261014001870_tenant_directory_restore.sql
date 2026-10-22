-- Task 17 review round 2: RESTORE `public.tenant_directory()` after the measurement
-- probe.
--
-- 20261014001860 removed the `where (select private.is_platform_admin())` clause on
-- purpose, to prove that the HTTPS assertion in
-- `tests/integration/platform-console.test.ts` can fail. It did: the non-administrator
-- received the seeded organization.
--
-- This file puts the function back, BYTE-FOR-BYTE. MEASURED: `md5(prosrc)` is
-- 5365ccdf74d4d73685c9afbd763d1bdf before the probe and after this file - the same
-- value, which is what "restored byte-for-byte" means for a function body.
--
-- The body below is the 01850 body verbatim. It is copied, not re-derived, because a
-- re-derivation is a second spelling of the same function and the two would drift.

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
   where (select private.is_platform_admin())
   order by o.name;
$fn$;

comment on function public.tenant_directory() is
  'The tenant directory: one row per organization with its name, its status and its member count, and nothing else. Refuses a caller that is not a platform administrator by returning no rows. The member count is taken by a definer because row-level security hides other tenants'' memberships from a platform operator.';

revoke execute on function public.tenant_directory() from public;
revoke execute on function public.tenant_directory() from anon;
grant execute on function public.tenant_directory() to authenticated;
