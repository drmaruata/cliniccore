-- Task 16 review, round 2: the grant ceiling on EVERY path that grants a role, and
-- ONE membership rule.
--
-- ---------------------------------------------------------------------------
-- 1. THE SIBLING PATH WAS STILL OPEN.
--
-- The ceiling was introduced in `invitations_write` and `invitations_update` by
-- 20261014001760, but the DIRECT assignment path - `user_role_assignments_write` and
-- `user_role_assignments_update` - still called `private.can_grant`, which is the
-- SUBSET rule alone: every permission of the target role must already be held by the
-- granter.
--
-- The subset rule cannot tell an `organization_admin` from an `organization_owner`,
-- because they carry BYTE-IDENTICAL permission sets - MEASURED by 01240 itself, in
-- the live database. So the sibling path was an escalation with one statement:
--
--   insert into public.user_role_assignments (organization_id, user_id, role_id)
--   select <org>, <self>, <the organization_owner role>
--
-- and the granter became the tenant's owner - with `settings.manage` (which rewrites
-- the slug, the currency and the timezone), `patients.export` and
-- `subscription.manage` - and could then mint owners through the invitation path
-- that the last round closed.
--
-- THE FIX. Both policies now call `private.can_assign_role`, which is `can_grant` AND
-- the owner-only clause: only an existing `organization_owner` may grant
-- `organization_owner`. The SUBSET rule is unchanged and still holds - it is the first
-- half of `can_assign_role`.
--
-- WHY THIS IS THE SAME RULE AND NOT A NEW ONE. `can_assign_role` is the rule the
-- invitation path uses. Using it on the direct path too is what makes "one ceiling"
-- true rather than two ceilings that contradict each other - and two contradicting
-- ceilings is how a tenant administrator became the owner in the first place.
--
-- ---------------------------------------------------------------------------
-- 2. AN ACCEPTED INVITATION IS NOW IMMUTABLE.
--
-- `invitations.accepted_at` is writable, so a staff manager could clear it and
-- re-issue an invitation that had already been redeemed - and the raw token is the
-- credential, so the same link would work again. It is not intended: one invitation
-- means one membership. The UPDATE policy now refuses any change to an invitation
-- that has been accepted.
--
-- ---------------------------------------------------------------------------
-- 3. ONE MEMBERSHIP RULE.
--
-- `private.current_org_ids` was a THIRD copy of "is this user an active member of
-- this organization" - the copy that the RLS policies call. `private.is_member_for`
-- owns that rule now, so the set version asks it rather than re-deriving it.
--
-- THE SET IS THE SAME. The old version joined memberships to organizations and
-- returned the organizations where the membership is active and the organization is
-- active; the new one asks `is_member_for` for each organization, which is the same
-- predicate. The policies wrap the call in `(select ...)`, so it is evaluated once
-- per statement, as before.

-- ---------------------------------------------------------------------------
-- 1. The direct assignment path.

drop policy if exists user_role_assignments_write on public.user_role_assignments;
drop policy if exists user_role_assignments_update on public.user_role_assignments;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_write') then
    create policy user_role_assignments_write on public.user_role_assignments
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
        -- THE WHOLE CEILING, not half of it. `can_grant` is the subset rule, and the
        -- subset rule cannot tell an organization_admin from an organization_owner -
        -- they carry the same permissions. `can_assign_role` is the subset rule AND
        -- the owner-only clause, and it is the same rule the invitation path uses.
        and private.can_assign_role(organization_id, role_id)
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = user_role_assignments.organization_id
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_update') then
    create policy user_role_assignments_update on public.user_role_assignments
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
        -- The same whole ceiling as the insert path, so an assignment cannot be
        -- created for a role the granter may not grant and then MOVED to one they
        -- may not.
        and private.can_assign_role(organization_id, role_id)
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = user_role_assignments.organization_id
        )
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. An accepted invitation cannot be re-opened.

drop policy if exists invitations_update on public.invitations;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'invitations'
                    and policyname = 'invitations_update') then
    create policy invitations_update on public.invitations
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        -- The grant ceiling, on UPDATE as well as on INSERT.
        and private.can_assign_role(organization_id, role_id)
        -- AND AN ACCEPTED INVITATION IS IMMUTABLE. `accepted_at` is writable, and the
        -- raw token is the credential: an invitation that could be re-opened could be
        -- redeemed again. One invitation means one membership.
        and accepted_at is null
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = invitations.organization_id
        )
        and (
          coalesce(array_length(clinic_ids, 1), 0) = 0
          or not exists (
            select 1
              from unnest(clinic_ids) as requested_clinic
             where not exists (
               select 1 from public.clinics cl
                where cl.id = requested_clinic
                  and cl.organization_id = invitations.organization_id
             )
          )
        )
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. One membership rule.

create or replace function private.current_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select o.id
  from public.organizations o
  where private.is_member_for((select auth.uid()), o.id);
$fn$;

comment on function private.current_org_ids() is
  'The organizations the calling user is an active member of, and whose status is active. Delegates the membership rule to private.is_member_for, which owns it.';

revoke execute on function private.current_org_ids() from public;
grant execute on function private.current_org_ids() to authenticated;
