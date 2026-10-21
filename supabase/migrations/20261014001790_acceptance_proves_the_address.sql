-- Task 16 review, round 2: the acceptance proves the ADDRESS, and a suspended member's
-- redemption does not burn the invitation.
--
-- ---------------------------------------------------------------------------
-- 1. A CLAIM IS NOT A PROVEN ADDRESS.
--
-- The acceptance compared the invitation's address with `auth.jwt() ->> 'email'` - the
-- acceptor's verified claim. The claim is AUTHENTIC, but the address behind it need
-- not be CONFIRMED: `app/(auth)/signup/actions.ts` signs a user in immediately when
-- "Confirm email" is off, which it is in this deployment. So anybody could register
-- the invited address, redeem the invitation, and hold the role - and "the link
-- alone is not enough" held only for a confirmed account.
--
-- THE FIX. The acceptance now also asks the account's own row:
--
--   auth.users.email_confirmed_at is not null   -- the address is confirmed
--   auth.users.email = the invitation's address -- and it is the invited address
--
-- and it FAILS CLOSED: no account row, an unconfirmed address, or a different
-- address are all a refusal. The claim check stays, because it binds the SESSION to
-- the invitation; the account check binds the ACCOUNT.
--
-- ---------------------------------------------------------------------------
-- 2. A SUSPENDED OR REVOKED MEMBER'S REDEMPTION NO LONGER BURNS THE TOKEN.
--
-- The acceptance reused ANY membership row and did not reactivate it. A suspended
-- member's redemption therefore created an assignment that is INERT (`is_member`
-- requires `active`), set `accepted_at`, and left the membership suspended: the
-- invitation was spent and the member was still locked out.
--
-- The fix is to REFUSE unless the membership is active. The alternative - quietly
-- reactivating a suspended member - would hand a suspended clinician their role back
-- because they held a link, which is not what a suspension means.
--
-- ---------------------------------------------------------------------------
-- 3. A CONCURRENT ACCEPTANCE LOSES CLEANLY.
--
-- Two acceptances of the same token can both pass the checks; the membership insert
-- is then the tie-breaker, and the loser gets a unique violation. That is caught
-- here and turned into the same refusal as a used invitation, instead of surfacing
-- as a raw 23505.

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
  v_membership_status text;
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

  -- THE SESSION. The claim binds this session to the invitation.
  v_acceptor_email := lower(coalesce((select auth.jwt() ->> 'email'), ''));
  if v_acceptor_email = '' or lower(v_inv.email::text) <> v_acceptor_email then
    raise exception 'that invitation was sent to a different address' using errcode = '22023';
  end if;

  -- THE PROVEN ADDRESS. The claim is authentic but the address behind it need not be
  -- CONFIRMED - and this deployment does not require a confirmation - so the account's
  -- own row is the proof. Fails closed: no row, an unconfirmed address, or a
  -- different address are all a refusal.
  if not exists (
    select 1
      from auth.users u
     where u.id = v_uid
       and u.email_confirmed_at is not null
       and lower(u.email::text) = lower(v_inv.email::text)
  ) then
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
  select m.id, m.status into v_membership_id, v_membership_status
    from public.organization_memberships m
   where m.organization_id = v_inv.organization_id
     and m.user_id = v_uid;

  -- A SUSPENDED OR REVOKED membership is a refusal, not something to reactivate. The
  -- alternative - quietly restoring a suspended member because they held a link -
  -- would hand a locked-out clinician their role back, and the assignment it created
  -- would be inert anyway (`is_member` requires 'active').
  if v_membership_id is not null and v_membership_status <> 'active' then
    raise exception 'your membership of that organization is not active' using errcode = '22023';
  end if;

  if v_membership_id is null then
    begin
      insert into public.organization_memberships (organization_id, user_id, status)
      values (v_inv.organization_id, v_uid, 'active')
      returning id into v_membership_id;
    exception when unique_violation then
      -- Two acceptances of the same token raced, and this one lost the insert. The
      -- other one has the membership, so this invitation is spent.
      raise exception 'that invitation has already been used' using errcode = '22023';
    end;
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
  'Accepts an invitation: hashes the supplied token, finds the invitation, refuses an expired, used, wrongly-addressed or wrongly-scaled one, proves the acceptor''s address is a CONFIRMED account, checks the grant ceiling for the INVITER, and creates the membership and the role assignment in one transaction. Returns the membership id. SECURITY DEFINER, so it checks everything itself.';

revoke execute on function private.accept_invitation(text) from public;
grant execute on function private.accept_invitation(text) to authenticated;
