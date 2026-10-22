-- Task 17 review round 2: RESTORE `public.tenant_directory()` after the measurement
-- probe.
--
-- 20261014001860 removed the `where (select private.is_platform_admin())` clause on
-- purpose, to prove that the HTTPS assertion in
-- `tests/integration/platform-console.test.ts` can fail. It did: the non-administrator
-- received the seeded organization.
--
-- This file puts the function back FUNCTIONALLY IDENTICAL to the 01850 body: the same
-- guard, the same SECURITY DEFINER, the same search_path and the same grants, all
-- confirmed live. It is NOT byte-identical, and the earlier version of this comment
-- said it was. MEASURED: 01850's body carried an inline SQL comment inside the
-- function's dollar-quotes, so its md5(prosrc) was f4ca0a10932b35517f42fed887a3b82d
-- (615 characters); this file dropped that comment, so the body is 288 characters and
-- its md5(prosrc) is 5365ccdf74d4d73685c9afbd763d1bdf - the live value. A comment
-- inside a function body is prosrc, so "restored" here means the BEHAVIOUR and the
-- definitions, not the bytes. The body is copied from 01850 rather than re-derived,
-- because a re-derivation would be a second spelling of the same function and the two
-- would drift.

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
