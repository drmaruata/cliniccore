-- Task 16 review fix 1a: make the grant ceiling answerable FOR A GIVEN USER.
--
-- WHY. The ceiling is `private.can_assign_role(p_org_id, p_role_id)`, and it answers
-- for the CALLER - `auth.uid()`. That is right for a policy, where the caller is the
-- principal being judged. It is wrong for the invitation REDEMPTION path, where the
-- principal being judged is the INVITER: `private.accept_invitation` is a definer, so
-- it bypasses RLS, and the policies that guarded the invitation's creation do not
-- guard its redemption. The stored `role_id` has to be checked against what the
-- INVITER was allowed to grant, and the ceiling could not be asked that question.
--
-- So the rules are PARAMETERISED BY USER, and the existing entry points become thin
-- delegations that supply `auth.uid()`. There is still ONE copy of each rule:
--
--   private.is_member_for(user, org)        <- private.is_member(org)
--   private.can_for(user, org, perm, clinic) <- private.can(org, perm, clinic)
--   private.can_grant_for(user, org, role)   <- private.can_grant(org, role)
--   private.can_assign_role_for(user, org, role)
--                                            <- private.can_assign_role(org, role)
--
-- WHY NOT A SECOND COPY OF THE RULE. `private.can` is the authorisation primitive
-- every policy in this schema calls, and it is org-strict AND refuses platform keys
-- AND carries the clinic scope. Re-deriving "does this user hold this permission"
-- inside a new function would be a second copy of the most important rule in the
-- database, and this repository has already been bitten by exactly that twice: the
-- platform-key clause drifted once, and the grant ceiling drifted once.
--
-- WHY THE DELEGATIONS ARE SAFE. A delegation is one function call, and the new
-- `*_for` functions are SECURITY DEFINER, STABLE and `set search_path = ''` exactly
-- like the originals. `private.can`, `private.is_member`, `private.can_grant` and
-- `private.can_assign_role` keep their signatures, their defaults and their grants,
-- so every policy that calls them is unaffected.
--
-- WHY THE NEW FUNCTIONS ARE NOT GRANTED TO `authenticated`. They answer questions
-- ABOUT OTHER USERS, which is a capability the originals never had. They are called
-- only from other definer functions, which run as their owner.

-- ---------------------------------------------------------------------------
-- 1. Membership, parameterised.

create or replace function private.is_member_for(p_user_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and o.status = 'active'
  );
$fn$;

comment on function private.is_member_for(uuid, uuid) is
  'Whether the given user is an active member of the given organization. The membership rule, parameterised by user: private.is_member is this with auth.uid().';

revoke execute on function private.is_member_for(uuid, uuid) from public;

create or replace function private.is_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.is_member_for((select auth.uid()), p_org_id);
$fn$;

comment on function private.is_member(uuid) is
  'Whether the calling user is an active member of the given organization. Delegates to private.is_member_for.';

revoke execute on function private.is_member(uuid) from public;
grant execute on function private.is_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The permission rule, parameterised.

create or replace function private.can_for(
  p_user_id uuid,
  p_org_id uuid,
  p_permission text,
  p_clinic_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select lower(p_permission) not like 'platform.%'
     and (select private.is_member_for(p_user_id, p_org_id))
     and exists (
       select 1
       from public.user_role_assignments a
       join public.role_permissions rp on rp.role_id = a.role_id
       join public.roles r on r.id = a.role_id
       where a.organization_id = p_org_id
         and a.user_id = p_user_id
         and rp.permission_key = p_permission
         and r.organization_id = p_org_id
         and (a.clinic_id is null or a.clinic_id = p_clinic_id)
     );
$fn$;

comment on function private.can_for(uuid, uuid, text, uuid) is
  'Whether the given user holds the given permission in the given organization, scoped to a clinic. The authorisation rule, parameterised by user: private.can is this with auth.uid().';

revoke execute on function private.can_for(uuid, uuid, text, uuid) from public;

create or replace function private.can(p_org_id uuid, p_permission text, p_clinic_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.can_for((select auth.uid()), p_org_id, p_permission, p_clinic_id);
$fn$;

comment on function private.can(uuid, text, uuid) is
  'Whether the calling user holds the given permission in the given organization, scoped to a clinic. Delegates to private.can_for, which owns the rule.';

revoke execute on function private.can(uuid, text, uuid) from public;
grant execute on function private.can(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The grant ceiling, parameterised.

create or replace function private.can_grant_for(p_user_id uuid, p_org_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select not exists (
    select 1
      from public.role_permissions rp
     where rp.role_id = p_role_id
       and not private.can_for(p_user_id, p_org_id, rp.permission_key, null)
  );
$fn$;

comment on function private.can_grant_for(uuid, uuid, uuid) is
  'Whether the given user may grant the given role: every permission of the role must already be held by that user. The grant ceiling, parameterised by user.';

revoke execute on function private.can_grant_for(uuid, uuid, uuid) from public;

create or replace function private.can_grant(p_org_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.can_grant_for((select auth.uid()), p_org_id, p_role_id);
$fn$;

comment on function private.can_grant(uuid, uuid) is
  'Whether the calling user may grant the given role in the given organization. Delegates to private.can_grant_for.';

revoke execute on function private.can_grant(uuid, uuid) from public;
grant execute on function private.can_grant(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The ceiling the invitation path uses, parameterised.

create or replace function private.can_assign_role_for(
  p_user_id uuid,
  p_org_id uuid,
  p_role_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.can_grant_for(p_user_id, p_org_id, p_role_id)
     and (
       not exists (
         select 1
           from public.roles r
          where r.id = p_role_id
            and r.key = 'organization_owner'
       )
       or exists (
         select 1
           from public.user_role_assignments a
           join public.roles r on r.id = a.role_id
          where a.organization_id = p_org_id
            and a.user_id = p_user_id
            and r.organization_id = p_org_id
            and r.key = 'organization_owner'
       )
     );
$fn$;

comment on function private.can_assign_role_for(uuid, uuid, uuid) is
  'Whether the given user may grant the given role in the given organization: every permission of the role must already be held by that user, and only an existing organization_owner may grant organization_owner.';

revoke execute on function private.can_assign_role_for(uuid, uuid, uuid) from public;

create or replace function private.can_assign_role(p_org_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.can_assign_role_for((select auth.uid()), p_org_id, p_role_id);
$fn$;

comment on function private.can_assign_role(uuid, uuid) is
  'Whether the calling user may grant the given role in the given organization. Delegates to private.can_assign_role_for, which owns the rule.';

revoke execute on function private.can_assign_role(uuid, uuid) from public;
grant execute on function private.can_assign_role(uuid, uuid) to authenticated;
