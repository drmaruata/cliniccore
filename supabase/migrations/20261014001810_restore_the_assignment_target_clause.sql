-- Task 16 review, round 2, correction: 20261014001780 dropped a clause it was not
-- supposed to drop.
--
-- WHAT HAPPENED. 01780 recreated `user_role_assignments_write` and
-- `user_role_assignments_update` to carry the whole ceiling, and it wrote the
-- policies out from the version in 20261014001240 - which is NOT the version that was
-- effective. 20261014001660 had recreated them again, with one more clause:
--
--     private.assignment_target_is_member(organization_id, user_id)
--
-- and that clause is the closure of gap A3: an assignment cannot be PRE-STAGED for a
-- user who belongs to no organization, because the assignment would be inert until
-- that account joined the organization by some other route - at which point it would
-- be live, with no grant step in between.
--
-- The suite caught it: `tests/integration/authorization-gaps.test.ts` - "A3: an
-- assignment cannot be pre-staged for a user in no organization" - failed with
-- "expected a failure matching /row-level security|violates/ but the statement
-- succeeded". The policy had become PERMISSIVE, which is the direction that matters.
--
-- So the clause is restored here, with the ceiling 01780 added. Both policies are
-- written out in full again, because a WITH CHECK cannot be added to an existing
-- policy - the same reason 01660 and 01220 recreated them.

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
        -- AN ASSIGNMENT MAY NOT BE PRE-STAGED FOR AN OUTSIDER. Restored from
        -- 20261014001660, which 01780 dropped by accident: the assignment would be
        -- inert until that account joined the organization by some other route, and
        -- live afterwards, with no grant step in between.
        and private.assignment_target_is_member(organization_id, user_id)
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
        and private.assignment_target_is_member(organization_id, user_id)
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
