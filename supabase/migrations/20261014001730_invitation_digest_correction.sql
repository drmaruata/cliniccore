-- Task 16 correction: the acceptance function hashed with a function that does not exist
-- on this project.
--
-- WHAT WAS WRONG. 20261014001720 computed the token digest as
--
--     pg_catalog.encode(public.digest(p_token, 'sha256'), 'hex')
--
-- and `public.digest` DOES NOT EXIST on this project. MEASURED: the query
--
--     select encode(public.digest('probe-token', 'sha256'), 'hex')
--
-- fails with `42883: function public.digest(unknown, unknown) does not exist`.
--
-- WHY. Migration 00100 asked for `create extension pgcrypto with schema public`, but it
-- guarded that with `if not exists (select 1 from pg_extension where extname = 'pgcrypto')`
-- - and this project ALREADY had pgcrypto, installed by Supabase in the `extensions`
-- schema. MEASURED: `pg_extension` reports pgcrypto with extnamespace `extensions`, and
-- `pg_proc` holds `digest(bytea,text)` and `digest(text,text)` in `extensions` - so
-- `public.digest` was never created and the guard skipped the installation.
--
-- The function was CREATED successfully, because a plpgsql body is not validated at
-- creation time. It would have failed at the first acceptance, with an error naming a
-- function that does not exist - which is the worst way to find out.
--
-- THE FIX. `pg_catalog.sha256(bytea)` is a PostgreSQL BUILT-IN, present since 11, with
-- no extension and no schema to depend on. The digest is unchanged - it is still SHA-256
-- over the UTF-8 bytes of the token - so the row written by the owner's server action
-- still matches.
--
-- MEASURED, and this is the measurement that matters, because the two sides are written
-- in two different languages and must agree byte for byte:
--
--   postgres  select encode(sha256(convert_to('probe-token','UTF8')),'hex');
--             -> 92e2a3caaa3bec34d48004c7da4036f21c00828f51788c7650b9ee4ba5ef63d5
--   postgres  select encode(extensions.digest('probe-token','sha256'),'hex');
--             -> 92e2a3caaa3bec34d48004c7da4036f21c00828f51788c7650b9ee4ba5ef63d5
--   node      createHash('sha256').update('probe-token').digest('hex')
--             -> 92e2a3caaa3bec34d48004c7da4036f21c00828f51788c7650b9ee4ba5ef63d5
--
-- The correction is a new file because the migration it corrects is applied, and an
-- applied migration is never edited.

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
  'Accepts an invitation: hashes the supplied token with pg_catalog.sha256, finds the invitation, refuses an expired or already-used one, and creates the membership and the role assignment in one transaction. Returns the membership id. SECURITY DEFINER, so it checks everything itself.';
