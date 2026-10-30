-- Task 9: Clinical state RPCs - finalize_encounter, add_encounter_addendum
--
-- These are security definer functions that bypass RLS. They MUST check
-- private.can themselves because RLS is not evaluated for a security definer
-- running as the table owner.
--
-- finalize_encounter:
--   - Requires encounters.write in the encounter's organization AND clinic reach
--   - Refuses when finalized_at is not null (idempotent refusal, not silent)
--   - Stamps finalized_at = now(), finalized_by = auth.uid()
--   - Writes audit action encounter.finalized with metadata { encounter_id }
--
-- add_encounter_addendum:
--   - Requires encounters.write in the encounter's organization AND clinic reach
--   - Refuses if the encounter is not finalized (finalized_at is null)
--   - Returns the addendum id
--   - Writes audit action encounter.addendum with { encounter_id, addendum_id }

create or replace function private.finalize_encounter_rpc(p_encounter_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_encounter public.encounters%rowtype;
  v_user_id uuid := (select auth.uid());
begin
  -- Fetch the encounter with its organization and clinic
  select * into v_encounter
  from public.encounters
  where id = p_encounter_id;

  if not found then
    raise exception 'encounter not found' using errcode = 'P0001';
  end if;

  -- Must be a member of the organization
  if not private.is_member_for(v_user_id, v_encounter.organization_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- Must be able to reach the clinic
  if not (v_encounter.clinic_id in (select private.clinic_ids(v_encounter.organization_id))) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- Must have encounters.write permission
  if not private.can_for(v_user_id, v_encounter.organization_id, 'encounters.write', v_encounter.clinic_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- Already finalized? Refuse explicitly (not silently).
  if v_encounter.finalized_at is not null then
    raise exception 'encounter already finalized' using errcode = 'P0002';
  end if;

  -- Finalize: stamp timestamps and user
  update public.encounters
  set status = 'finalized',
      finalized_at = now(),
      finalized_by = v_user_id,
      updated_at = now()
  where id = p_encounter_id;

  -- Write audit record
  insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_encounter.organization_id, v_user_id, 'encounter.finalized', 'encounter', p_encounter_id, jsonb_build_object('encounter_id', p_encounter_id));

  return;
end;
$fn$;

create or replace function public.finalize_encounter(p_encounter_id uuid)
returns void
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.finalize_encounter_rpc(p_encounter_id);
$fn$;

revoke execute on function public.finalize_encounter(uuid) from public;
revoke execute on function public.finalize_encounter(uuid) from anon;
grant execute on function public.finalize_encounter(uuid) to authenticated;

-- Addendum RPC
create or replace function private.add_encounter_addendum_rpc(p_encounter_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_encounter public.encounters%rowtype;
  v_user_id uuid := (select auth.uid());
  v_addendum_id uuid;
begin
  select * into v_encounter
  from public.encounters
  where id = p_encounter_id;

  if not found then
    raise exception 'encounter not found' using errcode = 'P0001';
  end if;

  if not private.is_member_for(v_user_id, v_encounter.organization_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if not (v_encounter.clinic_id in (select private.clinic_ids(v_encounter.organization_id))) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if not private.can_for(v_user_id, v_encounter.organization_id, 'encounters.write', v_encounter.clinic_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  -- Addenda only attach to finalized encounters
  if v_encounter.finalized_at is null then
    raise exception 'encounter not finalized' using errcode = 'P0003';
  end if;

  insert into public.encounter_addenda (organization_id, encounter_id, author_user_id, body)
  values (v_encounter.organization_id, p_encounter_id, v_user_id, p_body)
  returning id into v_addendum_id;

  insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_encounter.organization_id, v_user_id, 'encounter.addendum', 'encounter_addendum', v_addendum_id, jsonb_build_object('encounter_id', p_encounter_id, 'addendum_id', v_addendum_id));

  return v_addendum_id;
end;
$fn$;

create or replace function public.add_encounter_addendum(p_encounter_id uuid, p_body text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.add_encounter_addendum_rpc(p_encounter_id, p_body);
$fn$;

revoke execute on function public.add_encounter_addendum(uuid, text) from public;
revoke execute on function public.add_encounter_addendum(uuid, text) from anon;
grant execute on function public.add_encounter_addendum(uuid, text) to authenticated;