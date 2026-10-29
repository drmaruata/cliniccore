-- Phase 5 clinical RLS: appointments, queue entries, encounters and encounter addenda.
--
-- Thirteen policies, all built on the same three-clause conjunction the tenancy tables
-- use: the row's organization must be one the caller is an active member of,
-- private.can must grant the permission FOR THE ROW'S CLINIC, and the clinic must be one
-- private.clinic_ids says the caller can reach. The two clinic authorities are
-- independent - a clinic-scoped role assignment and a clinic_memberships scope each stop
-- a principal the other would admit - so both clauses are required, not one. A
-- two-argument can() would refuse every clinic-scoped grant, so every call passes the
-- row's clinic explicitly.
--
-- appointments and queue_entries are gated by appointments.manage for every command,
-- including DELETE: removing an appointment silently breaks the encounters and queue
-- entries that point at it, so removal is a scheduling capability rather than a
-- separate one.
--
-- encounters are readable by encounters.read OR encounters.write in ONE policy: a
-- clinician who may write but not read would be able to create a record they cannot
-- open. UPDATE keeps `finalized_at is null` in BOTH the using and the with check, so a
-- finalized encounter is immutable through the ordinary path and the definer RPC that
-- finalizes it is the only writer of that timestamp.
--
-- encounter_addenda has NO clinic_id. Its clinic dimension is derived from the parent
-- encounter, and the exists subquery applies the same three clauses to the parent's
-- organization_id and clinic_id rather than calling can() with a null clinic: a
-- clinic-scoped grant must still pass.
--
-- Grants are the second lock. PostgREST's default privileges give anon and authenticated
-- every table command on a new public table, so both roles are revoked outright and then
-- granted exactly the commands the policies support. encounters and encounter_addenda
-- are read-and-write only through the API: clinical history is not client-deletable, and
-- an addendum is append-only by construction - it has no updated_at and no update
-- policy.

alter table public.appointments enable row level security;
alter table public.queue_entries enable row level security;
alter table public.encounters enable row level security;
alter table public.encounter_addenda enable row level security;

revoke all on table public.appointments, public.queue_entries,
  public.encounters, public.encounter_addenda from anon;
revoke all on table public.appointments, public.queue_entries,
  public.encounters, public.encounter_addenda from authenticated;

grant select, insert, update, delete on public.appointments, public.queue_entries
  to authenticated;
grant select, insert, update on public.encounters, public.encounter_addenda
  to authenticated;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'appointments'
                    and policyname = 'appointments_select') then
    create policy appointments_select on public.appointments
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'appointments'
                    and policyname = 'appointments_write') then
    create policy appointments_write on public.appointments
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'appointments'
                    and policyname = 'appointments_update') then
    create policy appointments_update on public.appointments
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'appointments'
                    and policyname = 'appointments_delete') then
    create policy appointments_delete on public.appointments
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'queue_entries'
                    and policyname = 'queue_entries_select') then
    create policy queue_entries_select on public.queue_entries
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'queue_entries'
                    and policyname = 'queue_entries_write') then
    create policy queue_entries_write on public.queue_entries
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'queue_entries'
                    and policyname = 'queue_entries_update') then
    create policy queue_entries_update on public.queue_entries
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'queue_entries'
                    and policyname = 'queue_entries_delete') then
    create policy queue_entries_delete on public.queue_entries
      for delete to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'appointments.manage', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'encounters'
                    and policyname = 'encounters_select') then
    create policy encounters_select on public.encounters
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and (
          private.can(organization_id, 'encounters.read', clinic_id)
          or private.can(organization_id, 'encounters.write', clinic_id)
        )
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'encounters'
                    and policyname = 'encounters_write') then
    create policy encounters_write on public.encounters
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'encounters.write', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'encounters'
                    and policyname = 'encounters_update') then
    create policy encounters_update on public.encounters
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'encounters.write', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
        and finalized_at is null
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'encounters.write', clinic_id)
        and clinic_id in (select private.clinic_ids(organization_id))
        and finalized_at is null
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'encounter_addenda'
                    and policyname = 'encounter_addenda_select') then
    create policy encounter_addenda_select on public.encounter_addenda
      for select to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and exists (
          select 1
            from public.encounters e
           where e.id = encounter_id
             and e.organization_id = encounter_addenda.organization_id
             and e.organization_id in (select private.current_org_ids())
             and (
               private.can(e.organization_id, 'encounters.read', e.clinic_id)
               or private.can(e.organization_id, 'encounters.write', e.clinic_id)
             )
             and e.clinic_id in (select private.clinic_ids(e.organization_id))
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'encounter_addenda'
                    and policyname = 'encounter_addenda_write') then
    create policy encounter_addenda_write on public.encounter_addenda
      for insert to authenticated
      with check (
        organization_id in (select private.current_org_ids())
        and exists (
          select 1
            from public.encounters e
           where e.id = encounter_id
             and e.organization_id = encounter_addenda.organization_id
             and e.organization_id in (select private.current_org_ids())
             and private.can(e.organization_id, 'encounters.write', e.clinic_id)
             and e.clinic_id in (select private.clinic_ids(e.organization_id))
        )
      );
  end if;
end
$$;
