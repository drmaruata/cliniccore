-- Clinical core schema: appointments, queue entries, encounters and encounter
-- addenda.
--
-- These are the first tables that hang off patients rather than clinics alone,
-- so every reference is composite and includes organization_id: an appointment
-- cannot name a patient or a clinic from another tenant, a queue entry or an
-- encounter cannot point at another tenant's appointment, and an addendum
-- cannot attach to another tenant's encounter. The patient references are
-- ON DELETE RESTRICT because the product archives patients and clinical history
-- must outlive a hard delete; the clinic references keep the default NO ACTION,
-- as patients_clinic_fkey does, so deleting a tenant cascades from organizations
-- without being blocked by the clinic rows it is deleting anyway.
--
-- clinician_user_id, created_by, finalized_by and author_user_id are plain uuid,
-- not foreign keys to auth.users: closing a staff account must not delete or
-- rewrite clinical history.
--
-- RLS is ENABLED here with no policies, so these tables are deny-all until the
-- clinical RLS migration adds them - the posture the tenancy tables took.
-- PostgREST grants anon/authenticated access to new public tables by default, so
-- a table created without RLS would be reachable through the API in the window
-- before its policies land.
--
-- appointments_status_transition encodes the only legal status moves. The
-- TypeScript action validates the same graph, but the database is the authority:
-- an UPDATE that bypasses the action must not move a completed appointment back
-- to booked, or skip from booked straight to completed.
--
-- queue_one_open_per_patient_idx keeps at most one open queue entry per patient
-- per clinic, and queue_open_idx serves the board query ordered by queued_at.
--
-- encounter_addenda is append-only: it has no updated_at and no update trigger,
-- and its composite encounter reference is ON DELETE RESTRICT, so an addendum
-- blocks a hard delete of the encounter it annotates.

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  clinic_id uuid not null,
  patient_id uuid not null,
  clinician_user_id uuid,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  status text not null default 'booked',
  reason text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint appointments_clinic_fkey foreign key (organization_id, clinic_id)
    references public.clinics (organization_id, id),
  constraint appointments_patient_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, id) on delete restrict,
  constraint appointments_status_check
    check (status in ('booked', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show')),
  constraint appointments_end_after_start_check check (scheduled_end > scheduled_start)
);

create table if not exists public.queue_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  clinic_id uuid not null,
  patient_id uuid not null,
  appointment_id uuid,
  status text not null default 'waiting',
  queued_at timestamptz not null default now(),
  called_at timestamptz,
  completed_at timestamptz,
  created_by uuid,
  constraint queue_entries_clinic_fkey foreign key (organization_id, clinic_id)
    references public.clinics (organization_id, id),
  constraint queue_entries_patient_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, id) on delete restrict,
  constraint queue_entries_appointment_fkey foreign key (organization_id, appointment_id)
    references public.appointments (organization_id, id) on delete restrict,
  constraint queue_entries_status_check
    check (status in ('waiting', 'called', 'in_consultation', 'completed', 'skipped'))
);

create table if not exists public.encounters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  clinic_id uuid not null,
  patient_id uuid not null,
  appointment_id uuid,
  clinician_user_id uuid,
  status text not null default 'draft',
  chief_complaint text,
  history text,
  examination text,
  assessment text,
  plan text,
  started_at timestamptz not null default now(),
  finalized_at timestamptz,
  finalized_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint encounters_clinic_fkey foreign key (organization_id, clinic_id)
    references public.clinics (organization_id, id),
  constraint encounters_patient_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, id) on delete restrict,
  constraint encounters_appointment_fkey foreign key (organization_id, appointment_id)
    references public.appointments (organization_id, id) on delete restrict,
  constraint encounters_status_check check (status in ('draft', 'finalized'))
);

create table if not exists public.encounter_addenda (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  encounter_id uuid not null,
  author_user_id uuid,
  body text not null,
  created_at timestamptz not null default now(),
  constraint encounter_addenda_encounter_fkey foreign key (organization_id, encounter_id)
    references public.encounters (organization_id, id) on delete restrict
);

create index if not exists appointments_clinic_start_idx
  on public.appointments (organization_id, clinic_id, scheduled_start);

create index if not exists queue_open_idx
  on public.queue_entries (organization_id, clinic_id, queued_at)
  where completed_at is null;

create unique index if not exists queue_one_open_per_patient_idx
  on public.queue_entries (organization_id, clinic_id, patient_id)
  where completed_at is null;

alter table public.appointments enable row level security;
alter table public.queue_entries enable row level security;
alter table public.encounters enable row level security;
alter table public.encounter_addenda enable row level security;

drop trigger if exists set_updated_at on public.appointments;
create trigger set_updated_at
  before update on public.appointments
  for each row execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.encounters;
create trigger set_updated_at
  before update on public.encounters
  for each row execute function private.set_updated_at();

create or replace function private.guard_appointment_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'booked' and new.status in ('confirmed', 'cancelled'))
      or (old.status = 'confirmed' and new.status in ('checked_in', 'cancelled', 'no_show'))
      or (old.status = 'checked_in' and new.status in ('completed', 'cancelled'))
    ) then
      raise exception 'appointment status cannot move from % to %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists appointments_status_transition on public.appointments;
create trigger appointments_status_transition
  before update of status on public.appointments
  for each row execute function private.guard_appointment_status_transition();
