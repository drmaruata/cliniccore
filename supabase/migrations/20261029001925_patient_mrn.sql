-- Task 3: automated Medical Record Number (MRN) assignment.
--
-- Patients must have an MRN. If not provided on insert, one is generated
-- via a per-clinic sequence. MRNs are immutable.
--
-- The generator (private.next_patient_mrn) is a security definer to access
-- the per-tenant sequence table, but it explicitly validates that the
-- calling user is a member of the organization and can reach the clinic.
--
-- Sequence keys are formatted as 'patient_mrn:<clinic_id>'.

create or replace function private.next_patient_mrn(p_organization_id uuid, p_clinic_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_val bigint;
begin
  if not private.is_member_for((select auth.uid()), p_organization_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  if not (p_clinic_id in (select private.clinic_ids(p_organization_id))) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  v_val := private.next_sequence_value(p_organization_id, 'patient_mrn:' || p_clinic_id::text);
  return 'MRN-' || lpad(v_val::text, 6, '0');
end;
$fn$;

revoke execute on function private.next_patient_mrn(uuid, uuid) from public;
revoke execute on function private.next_patient_mrn(uuid, uuid) from anon;
grant execute on function private.next_patient_mrn(uuid, uuid) to authenticated;

create or replace function private.patients_assign_mrn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.mrn is null or btrim(new.mrn) = '' then
    new.mrn := private.next_patient_mrn(new.organization_id, new.clinic_id);
  end if;
  return new;
end;
$fn$;

create trigger patients_assign_mrn
  before insert on public.patients
  for each row execute function private.patients_assign_mrn();

create or replace function private.patients_guard_mrn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.mrn is distinct from old.mrn then
    raise exception 'MRNs are immutable';
  end if;
  return new;
end;
$fn$;

create trigger patients_guard_mrn
  before update on public.patients
  for each row execute function private.patients_guard_mrn();
