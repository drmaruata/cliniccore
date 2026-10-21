-- Task 16 review, round 3: the invitation's INVITER is the caller.
--
-- WHY. `private.accept_invitation` judges the grant ceiling for `invited_by` - the
-- person who issued the invitation - and it judged a COLUMN the caller supplied.
-- Nothing in the policies constrained that column, so the SUBJECT of the ceiling was
-- attacker-chosen: a member could name somebody else as the inviter, and the ceiling
-- would then be judged for that somebody rather than for the caller.
--
-- No escalation was found. The `role_id` is still bounded by the CALLER's own ceiling
-- at write time, and widening a role's permissions needs `settings.manage`. But two
-- ceilings that can diverge is not a thing to leave in place: if a role's permissions
-- change between the write and the redemption, the ceiling judged for the wrong
-- subject is the ceiling that decides.
--
-- THE FIX. Both policies now require the inviter to be the caller:
--
--     and invited_by = (select auth.uid())
--
-- so the ceiling at redemption is judged for the person who actually issued the
-- invitation - the same person the write-time ceiling was judged for.
--
-- The policies are written out in full from their EFFECTIVE definitions (read from
-- `pg_policies`, not from an earlier migration file): a WITH CHECK cannot be added to
-- an existing policy, and a policy recreated from an old file is not the policy that
-- was running. 20261014001810 learned that the hard way.

drop policy if exists invitations_write on public.invitations;
drop policy if exists invitations_update on public.invitations;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'invitations'
                    and policyname = 'invitations_write') then
    create policy invitations_write on public.invitations
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        -- THE WHOLE CEILING, judged for the CALLER.
        and private.can_assign_role(organization_id, role_id)
        -- THE INVITER IS THE CALLER. The acceptance judges the ceiling for
        -- `invited_by`, so the column that names the inviter may not be a value the
        -- caller chose freely: it is the caller.
        and invited_by = (select auth.uid())
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
        -- The same whole ceiling as the insert path.
        and private.can_assign_role(organization_id, role_id)
        -- The same rule about the inviter: the subject of the ceiling is the caller.
        and invited_by = (select auth.uid())
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
