-- Task 16: the invitation acceptance path, and the grant ceiling the invitation path needs.
--
-- WHY THE FILE IS NAMED 20261014001720 AND NOT 20261014001400. The plan's migration table
-- reserved 20261014001400 for this file, but that slot was taken by the storage hardening
-- migration (20261014001400_storage_hardening.sql), and a second file carrying the same
-- fourteen-digit version would make the filename order - the order
-- scripts/apply-migration.ts applies in - ambiguous. So this file sorts LAST, after the
-- public RPC wrappers it builds on.
--
-- WHY THE RAW TOKEN IS NEVER STORED. `invitations.token_hash` holds a SHA-256 digest and
-- nothing else. The raw token exists in exactly two places: in the link the owner copies
-- to the invitee, and in the request that redeems it. A database that stores the raw token
-- stores a credential, and a credential in a table is a credential in every backup, every
-- log of a table dump, and every read of the invitations table by an owner holding
-- staff.manage - which is a legitimate, ordinary, non-malicious read. The digest is what
-- makes the row useless to anyone who obtains it.
--
-- WHY THE HASH IS COMPUTED IN BOTH PLACES AND THEY MUST AGREE. The owner's server action
-- hashes the token it generated (node:crypto, UTF-8 bytes) to write the row; the
-- acceptance function hashes the token it was handed (pgcrypto, UTF-8 bytes) to find the
-- row. Both are SHA-256 over the same bytes, so the digests match. The E2E spec asserts
-- the stored digest against an independent Node digest, so a change to either side that
-- broke the agreement would fail the suite rather than silently make every invitation
-- unredeemable.
--
-- WHY accept_invitation IS A DEFINER. `organization_memberships` INSERT and DELETE are
-- closed by policy, so the invitee cannot write their own membership, and
-- `user_role_assignments` INSERT is closed to anyone but a staff manager. A definer
-- function is the only way to create the membership the acceptance promises. Being a
-- definer is exactly why it must check everything itself: it bypasses RLS, so RLS is not
-- a backstop for it.
--
-- WHAT IT CHECKS, AND WHY EACH ONE IS NEEDED:
--
--   the caller is signed in          - an anonymous caller has no identity to attach
--   the token hashes to a row        - a token that matches nothing is not an invitation
--   the invitation has not expired    - expiry is the owner's own limit
--   the invitation has not been used  - one invitation, one membership
--   the organization is still active  - a suspended tenant must not gain members
--   the role belongs to the tenant    - a platform role (organization_id IS NULL) must
--                                      never become a tenant assignment
--
-- The last one is the reason the lookup joins `roles` rather than trusting the stored
-- role_id: `private.can` is org-strict, so a platform role would be inert - but an
-- assignment naming it is still a row that should not exist.

-- ---------------------------------------------------------------------------
-- 1. The grant ceiling, as a rule the invitation path can ask about.
--
-- WHY THIS EXISTS. `private.can_grant` already refuses an assignment whose role holds a
-- permission the grantor does not, and the user_role_assignments INSERT policy uses it.
-- The INVITATION path did not: the acceptance function is a definer, so it created the
-- assignment with no policy in the way, and a staff manager could invite a colleague into
-- a role holding settings.manage, patients.export and subscription.manage - authority
-- the grantor never had and never asked for.
--
-- `can_assign_role` is `can_grant` PLUS the one hierarchy rule the registry cannot
-- express. organization_owner and organization_admin carry byte-identical permission
-- sets - MEASURED in the live database by migration 01240 - so the subset ceiling alone
-- cannot tell them apart, and an administrator would otherwise be able to mint owners.
-- The registry says only an existing organization_owner may mint another
-- organization_owner, so that is what this adds: the target role may be
-- organization_owner only if the GRANTOR already holds organization_owner.
--
-- The rule lives in SQL, in one place, and the invitation insert policy calls it. It is
-- deliberately NOT reimplemented in TypeScript: a second copy of a privilege rule is
-- how the platform-key clause came to exist twice and drift once.
create or replace function private.can_assign_role(p_org_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.can_grant(p_org_id, p_role_id)
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
            and a.user_id = (select auth.uid())
            and r.organization_id = p_org_id
            and r.key = 'organization_owner'
       )
     );
$fn$;

comment on function private.can_assign_role(uuid, uuid) is
  'Whether the calling user may grant the given role in the given organization: every permission of the role must already be held by the caller, and only an existing organization_owner may grant organization_owner.';

revoke execute on function private.can_assign_role(uuid, uuid) from public;
grant execute on function private.can_assign_role(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The browser's view of the same rule: which roles may this caller grant.
--
-- A thin wrapper, like public.can. It answers the UI's question - which roles belong in
-- the invite form - using the rule itself rather than a TypeScript copy of it.
create or replace function public.grantable_roles(p_org_id uuid)
returns table (role_id uuid, role_key text, role_name text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select r.id, r.key, r.name
    from public.roles r
   where r.organization_id = p_org_id
     and private.can_assign_role(p_org_id, r.id)
   order by r.name;
$fn$;

comment on function public.grantable_roles(uuid) is
  'The roles of the given organization that the calling user may grant, judged by private.can_assign_role. A thin wrapper: the rule lives in the database.';

revoke execute on function public.grantable_roles(uuid) from public;
revoke execute on function public.grantable_roles(uuid) from anon;
grant execute on function public.grantable_roles(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The invitations insert policy gains the ceiling.
--
-- The staff.manage gate and the org-scope gate were already there (20261014001220). What
-- was missing is the ceiling, and it was missing exactly where the definer acceptance
-- path made it matter.
drop policy if exists invitations_write on public.invitations;

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
-- 4. The acceptance function.
--
-- ONE TRANSACTION. The function body is the transaction: the membership, the role
-- assignment, the accepted_at stamp and the audit event either all land or none do. A
-- half-accepted invitation - a membership with no role, or a role with no membership -
-- would be a state the product has no way to repair.
create or replace function private.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid;
  v_hash text;
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

  v_hash := pg_catalog.encode(public.digest(p_token, 'sha256'), 'hex');

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
  'Accepts an invitation: hashes the supplied token, finds the invitation, refuses an expired or already-used one, and creates the membership and the role assignment in one transaction. Returns the membership id. SECURITY DEFINER, so it checks everything itself.';

revoke execute on function private.accept_invitation(text) from public;
grant execute on function private.accept_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The public wrapper, which is the browser's only door.
--
-- PostgREST exposes the `public` schema ONLY - MEASURED in migration 01600 - so
-- `private.accept_invitation` is unreachable from a browser even though it is granted to
-- `authenticated`. The same three-function pattern as 01600: the rule stays in `private`,
-- and the public function adds no decision of its own.
create or replace function public.accept_invitation(p_token text)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.accept_invitation(p_token);
$fn$;

comment on function public.accept_invitation(text) is
  'Accepts the invitation carried by the supplied token and returns the membership id. private.accept_invitation owns every rule.';

revoke execute on function public.accept_invitation(text) from public;
revoke execute on function public.accept_invitation(text) from anon;
grant execute on function public.accept_invitation(text) to authenticated;
