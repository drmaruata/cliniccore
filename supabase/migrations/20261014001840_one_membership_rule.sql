-- Task 16 review, round 3: ONE membership rule, and the shell can tell "no
-- membership" from "membership the RLS hides".
--
-- ---------------------------------------------------------------------------
-- 1. `private.clinic_ids` RE-DERIVED THE MEMBERSHIP RULE.
--
-- Its `mine` CTE asked for "an active membership in an active organization" itself:
--
--     from public.organization_memberships m
--     join public.organizations o on o.id = m.organization_id
--     where ... and m.status = 'active' and o.status = 'active'
--
-- and `private.is_member_for` now owns exactly that rule. So the membership rule had
-- two copies - and the unit assertion PINNED the duplicate, which made the
-- duplication a requirement rather than an accident.
--
-- The CTE now asks `is_member_for`. The rule lives in one place, and the set version
-- and the boolean version cannot disagree.
--
-- ---------------------------------------------------------------------------
-- 2. THE SHELL COULD NOT TELL "NO MEMBERSHIP" FROM "HIDDEN MEMBERSHIP".
--
-- `organization_memberships_select`'s USING is `private.is_member(organization_id)`,
-- and `is_member` requires an ACTIVE membership in an ACTIVE organization. So a
-- member of a SUSPENDED tenant, and a member whose own membership is suspended, see
-- NO rows at all - their membership row is filtered out by RLS.
--
-- `listMemberOrgs` therefore returned an empty list for them, and the shell's first
-- branch - "no memberships" - rendered the ONBOARDING screen: "create your
-- organization". A member of a suspended tenant was being offered the creation of a
-- second tenant, by a screen whose premise ("you belong to nothing") the database was
-- hiding from it.
--
-- THE FIX. `public.has_any_membership()` answers the question RLS cannot: does the
-- CALLER have any membership row AT ALL, in any state? It is a definer, so it sees
-- the rows the policies hide, and it answers about the caller only - so it is not an
-- oracle about anybody else.
--
-- The shell then has THREE states it can tell apart:
--
--   1. memberships, at least one ACTIVE  -> the shell
--   2. memberships, but ALL hidden        -> "your access is suspended", NOT onboarding
--   3. no memberships at all              -> onboarding
--
-- The second state is the one that was wrong, and it is now a refusal to create a
-- tenant for somebody the database is hiding.

-- ---------------------------------------------------------------------------
-- 1. The membership rule, in one place.

create or replace function private.clinic_ids(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  with mine as (
    select m.id
    from public.organization_memberships m
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      -- THE MEMBERSHIP RULE, asked of the function that owns it: an active membership
      -- in an active organization. It used to be re-derived here, which is how the
      -- rule ended up with two copies.
      and private.is_member_for((select auth.uid()), p_org_id)
  ),
  scoped as (
    select cm.clinic_id
    from public.clinic_memberships cm
    join mine on mine.id = cm.membership_id
  )
  select c.id
  from public.clinics c
  where c.organization_id = p_org_id
    and exists (select 1 from mine)
    and (
      (select count(*) from scoped) = 0
      or c.id in (select clinic_id from scoped)
    );
$fn$;

comment on function private.clinic_ids(uuid) is
  'The clinics the calling user may reach in the given organization. The membership rule is asked of private.is_member_for, which owns it.';

revoke execute on function private.clinic_ids(uuid) from public;
grant execute on function private.clinic_ids(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Does the caller have ANY membership, in any state?

create or replace function public.has_any_membership()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.organization_memberships m
     where m.user_id = (select auth.uid())
  );
$fn$;

comment on function public.has_any_membership() is
  'Whether the calling user has any membership of any organization, in any state - including the memberships that row-level security hides from them. It answers about the CALLER only, so it is not an oracle about anybody else, and the shell uses it to tell "you belong to nothing" from "your access is suspended".';

revoke execute on function public.has_any_membership() from public;
revoke execute on function public.has_any_membership() from anon;
grant execute on function public.has_any_membership() to authenticated;
