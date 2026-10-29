-- Correct the finalization guard in the clinical policies, and the two claims
-- 20261029001910 made that its policies did not enforce.
--
-- THE DEFECT. 01910 said a finalized encounter was immutable through the ordinary path and
-- that the definer RPC was the only writer of finalized_at. Both halves were false.
-- "encounters_write" had no finalization guard at all, so a client with encounters.write
-- could INSERT a row already marked finalized - skipping the RPC and its audit. And
-- "encounters_update" guarded only "finalized_at is null", so a client could UPDATE a draft
-- to "status = 'finalized'" while leaving the timestamp null: the row looked finalized to
-- the editor but stayed editable and unaudited. "encounter_addenda_write" also accepted an
-- addendum on a draft encounter, although an addendum annotates a finalized record.
--
-- THE FIX, and why it is "alter policy" rather than drop-and-create. Dropping a policy
-- leaves a deny-all window between the drop and the create, and it changes the catalogue
-- mid-migration. "alter policy" replaces the expression in place, so the policy count is
-- unchanged (still 52 public) and no statement can run against the table without a policy.
-- The finalization guard is now: an encounter may be INSERTED only as a draft with a null
-- finalized_at and a null finalized_by, and UPDATED only while it is a draft with a null
-- finalized_at. "encounters_update" carries its guard in BOTH halves, so a draft cannot be
-- moved to finalized through an UPDATE either. The definer RPC that finalizes (Task 9)
-- bypasses RLS as the table owner, so it is now the only path that can write the timestamp;
-- every ordinary write is held to the draft guard above, which is what keeps the RPC's
-- audit mandatory.
--
-- "encounter_addenda" was granted UPDATE in 01910 but has no UPDATE policy, so the privilege
-- was dead: it could not be exercised and it contradicted the table's append-only posture.
-- It is revoked here, leaving select and insert.
--
-- The appointments_delete comment is corrected for the same reason: the composite foreign
-- keys are ON DELETE RESTRICT, so a referenced appointment is refused rather than silently
-- orphaned, and only an unreferenced appointment can be deleted. The policy itself is
-- unchanged.

alter policy encounters_write on public.encounters
  with check (
    organization_id in (select private.current_org_ids())
    and private.can(organization_id, 'encounters.write', clinic_id)
    and clinic_id in (select private.clinic_ids(organization_id))
    and status = 'draft'
    and finalized_at is null
    and finalized_by is null
  );

alter policy encounters_update on public.encounters
  using (
    organization_id in (select private.current_org_ids())
    and private.can(organization_id, 'encounters.write', clinic_id)
    and clinic_id in (select private.clinic_ids(organization_id))
    and status = 'draft'
    and finalized_at is null
  )
  with check (
    organization_id in (select private.current_org_ids())
    and private.can(organization_id, 'encounters.write', clinic_id)
    and clinic_id in (select private.clinic_ids(organization_id))
    and status = 'draft'
    and finalized_at is null
  );

alter policy encounter_addenda_write on public.encounter_addenda
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
         and e.finalized_at is not null
    )
  );

revoke update on table public.encounter_addenda from authenticated;

comment on policy appointments_delete on public.appointments is
  'An appointment referenced by a queue entry or an encounter is refused by the composite ON DELETE RESTRICT foreign keys, so only an unreferenced appointment can be deleted.';
