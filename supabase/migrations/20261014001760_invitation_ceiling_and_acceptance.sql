-- Task 16 review fix 1b: close the invitation path's grant-ceiling hole, and bind an
-- invitation to the person it names.
--
-- ---------------------------------------------------------------------------
-- 1. THE ESCALATION, AND WHY THE INSERT POLICY WAS NOT ENOUGH.
--
-- 20261014001720 put `private.can_assign_role(...)` in the invitations INSERT
-- policy. The UPDATE policy was left as 20261014001220 wrote it, with no ceiling at
-- all - and the UPDATE policy is what an attacker uses to change the role an
-- invitation will grant.
--
-- THE ATTACK, MEASURED AGAINST THE REAL POLICY SET:
--
--   1. A `medical_director` holds `staff.manage` and the doctor's permissions, but
--      not `settings.manage`, `billing.manage` or `subscription.manage`.
--   2. It INSERTS an invitation naming the `doctor` role. The ceiling passes: every
--      permission of `doctor` is one it holds.
--   3. It UPDATES that invitation's `role_id` to the tenant's
--      `organization_owner`. The old UPDATE policy checked only that the writer
--      holds `staff.manage` and belongs to the organization, so the update SUCCEEDED.
--   4. It redeems the token it already holds. `private.accept_invitation` is a
--      definer, so no policy was in the way, and it created the
--      `user_role_assignments` row for `organization_owner`.
--
-- So a medical_director became the tenant's owner, with `settings.manage` (which
-- rewrites the slug, the currency and the timezone), `patients.export` and
-- `subscription.manage`.
--
-- THE FIX IS IN BOTH PLACES, because either alone leaves a way in:
--
--   (a) THE UPDATE POLICY carries the ceiling, so the stored `role_id` cannot be
--       moved to a role the writer was not allowed to grant.
--   (b) THE ACCEPTANCE FUNCTION re-checks the ceiling FOR THE INVITER, because a
--       definer bypasses RLS and the policies that guarded the creation do not guard
--       the redemption. The stored `role_id` is checked against what the INVITER was
--       allowed to grant, not against what the ACCEPTOR holds.
--
-- (b) is evaluated at redemption time, so an invitation whose inviter has since lost
-- the relevant permissions is refused. That is the fail-closed direction: a ceiling
-- that could be outrun by a demotion would not be a ceiling.
--
-- ---------------------------------------------------------------------------
-- 2. THE INVITATION IS FOR A PERSON, AND NOW SAYS SO.
--
-- The invitations table names an address, and the members page shows it as the
-- person the role is for. Until now NOTHING compared that address with the
-- acceptor's, so any bearer of the link took the role while the owner's roster
-- showed the invitation as "Pending" for ever.
--
-- The comparison is against the ACCEPTOR's verified claim -
-- `auth.jwt() ->> 'email'` - and it FAILS CLOSED when the claim is absent: a
-- request with no email claim is refused rather than waved through. The stored
-- column is `citext`, so the comparison is case-insensitive, and the claim is
-- lower-cased because Supabase stores addresses as typed.
--
-- ---------------------------------------------------------------------------
-- 3. AN INVITATION THAT NAMES CLINICS IS REFUSED RATHER THAN OVER-GRANTED.
--
-- `invitations.clinic_ids` exists, and the acceptance function used to ignore it
-- and create an ORGANIZATION-WIDE assignment - an over-grant, because a
-- clinic-scoped invitation would have handed the whole organization. The
-- foundation's invite form does not offer a clinic choice, so the honest behaviour
-- is to refuse an invitation that names one rather than redeem it too widely.
--
-- ---------------------------------------------------------------------------
-- 4. THE UPDATE POLICY.

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
        -- THE CEILING, ON UPDATE AS WELL AS ON INSERT. Without this clause an
        -- invitation can be created for a role the writer may grant and then moved
        -- to a role they may not - and the acceptance function, being a definer,
        -- would create that assignment without a policy in the way.
        and private.can_assign_role(organization_id, role_id)
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
-- 5. The acceptance function.

create or replace function private.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_hash text;
  v_acceptor_email text;
  v_inv public.invitations%rowtype;
  v_membership_id uuid;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'accepting an invitation requires a signed-in user' using errcode = '42501';
  end if;

  if p_token is null or length(p_token) < 32 then
    raise exception 'that invitation link is not valid' using errcode = 'P0002';
  end if;

  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');

  select i.* into v_inv
    from public.invitations i
   where i.token_hash = v_hash;

  if v_inv.id is null then
    raise exception 'that invitation link is not valid' using errcode = 'P0002';
  end if;

  if v_inv.expires_at < now() then
    raise exception 'that invitation has expired' using errcode = '22023';
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'that invitation has already been used' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.organizations o
     where o.id = v_inv.organization_id
       and o.status = 'active'
  ) then
    raise exception 'that organization is not accepting new members' using errcode = '22023';
  end if;

  -- The role must be one of THAT organization's roles. A platform role has
  -- organization_id IS NULL, so this refuses it, and so does a role belonging to a
  -- different tenant.
  if not exists (
    select 1
      from public.roles r
     where r.id = v_inv.role_id
       and r.organization_id = v_inv.organization_id
  ) then
    raise exception 'that invitation names a role this organization does not have' using errcode = '22023';
  end if;

  -- THE CEILING, JUDGED FOR THE INVITER. This function is a definer, so it bypasses
  -- RLS: the policies that guarded the invitation's creation do not guard its
  -- redemption, and the stored role_id has to be checked here. It is the INVITER's
  -- authority that is checked, because the INVITER chose the role - the acceptor's
  -- own permissions are irrelevant to what the invitation may hand out.
  if not private.can_assign_role_for(v_inv.invited_by, v_inv.organization_id, v_inv.role_id) then
    raise exception 'that invitation names a role its inviter was not allowed to grant' using errcode = '22023';
  end if;

  -- THE INVITED PERSON. The stored column is citext, so the comparison is
  -- case-insensitive; the claim is lower-cased because Supabase stores the address
  -- as it was typed. An absent claim is a REFUSAL, not a pass.
  v_acceptor_email := lower(coalesce((select auth.jwt() ->> 'email'), ''));
  if v_acceptor_email = '' or lower(v_inv.email::text) <> v_acceptor_email then
    raise exception 'that invitation was sent to a different address' using errcode = '22023';
  end if;

  -- AN INVITATION THAT NAMES CLINICS is refused rather than redeemed with an
  -- organization-wide grant, which would hand out more than the invitation says.
  if coalesce(array_length(v_inv.clinic_ids, 1), 0) > 0 then
    raise exception 'that invitation names clinics, which this release does not support' using errcode = '22023';
  end if;

  -- The membership. An existing one is REUSED rather than duplicated: the unique
  -- constraint is (organization_id, user_id), and a second row would be refused by the
  -- database anyway - but reusing it means an invitation can add a ROLE to somebody who
  -- is already a member without failing on the membership.
  select m.id into v_membership_id
    from public.organization_memberships m
   where m.organization_id = v_inv.organization_id
     and m.user_id = v_uid;

  if v_membership_id is null then
    insert into public.organization_memberships (organization_id, user_id, status)
    values (v_inv.organization_id, v_uid, 'active')
    returning id into v_membership_id;
  end if;

  -- The role assignment. The NOT EXISTS guard is there because the unique constraint
  -- (organization_id, user_id, role_id, clinic_id) does NOT fire for a NULL clinic_id:
  -- NULLs are distinct in a unique index, so two org-wide assignments of the same role
  -- to the same person are both allowed. The guard is what keeps acceptance idempotent.
  insert into public.user_role_assignments (organization_id, user_id, role_id)
  select v_inv.organization_id, v_uid, v_inv.role_id
  where not exists (
    select 1
      from public.user_role_assignments a
     where a.organization_id = v_inv.organization_id
       and a.user_id = v_uid
       and a.role_id = v_inv.role_id
       and a.clinic_id is null
  );

  -- The acceptance stamp, taken ATOMICALLY. Two simultaneous acceptances of the same
  -- token both pass the checks above, and only one of them can win this UPDATE - the
  -- loser is refused, so one invitation still means one membership.
  update public.invitations
     set accepted_at = now()
   where id = v_inv.id
     and accepted_at is null;

  if not found then
    raise exception 'that invitation has already been used' using errcode = '22023';
  end if;

  -- The audit event. private.write_audit checks membership, and the caller is a member
  -- by this point, so it passes. The metadata is empty on purpose: audit metadata
  -- describes what HAPPENED in identifiers and codes, and the identity of the person who
  -- accepted is already the actor column.
  perform private.write_audit(v_inv.organization_id, 'invitation.accepted', 'invitation', v_inv.id);

  return v_membership_id;
end;
$fn$;

comment on function private.accept_invitation(text) is
  'Accepts an invitation: hashes the supplied token, finds the invitation, refuses an expired, used, wrongly-addressed or wrongly-scaled one, checks the grant ceiling for the INVITER, and creates the membership and the role assignment in one transaction. Returns the membership id. SECURITY DEFINER, so it checks everything itself.';

revoke execute on function private.accept_invitation(text) from public;
grant execute on function private.accept_invitation(text) to authenticated;
