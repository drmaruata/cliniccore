-- Task 8: tenant data - patients, patient identifiers and per-tenant sequences.
--
-- The first tables in the project holding PHI, so the constraints do the work
-- application code must not. Every table carries organization_id, the parents
-- expose unique (organization_id, id), and the children reference them through
-- composite foreign keys that both include organization_id: a patient row cannot
-- be attached to a clinic in another organization, and an identifier cannot point
-- at a patient in another organization.
--
-- patients.mrn is text, not a sequence and not an integer. A global sequence
-- would make identifiers enumerable across tenants and would hard-code a format
-- into the schema; the plan's brief forbids exposing sequential database ids as
-- patient identifiers. private.next_sequence_value supplies a PER-TENANT counter
-- that the application formats, so the numbering scheme stays a product decision
-- and no organization's count reveals another's.
--
-- patient_identifiers references its patient ON DELETE RESTRICT, not CASCADE. An
-- identifier - a national insurance number, say - is part of the patient's record,
-- and losing one silently because something touched the parent row would be worse
-- than blocking the delete. The index on the referencing columns is explicit
-- because the table's only unique is on (organization_id, kind, value), which
-- cannot serve this foreign key.
--
-- updated_at: patients carries a set_updated_at trigger like every other table
-- with that column. tenant_sequences does not, deliberately - no application
-- code writes it, private.next_sequence_value maintains updated_at inline, and a
-- trigger on a table only the security-definer sequence function touches would be
-- redundant.

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  clinic_id uuid not null,
  mrn text not null,
  first_name text,
  last_name text,
  date_of_birth date,
  sex text,
  phone text,
  email citext,
  address jsonb,
  is_archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, clinic_id, mrn),
  constraint patients_clinic_fkey foreign key (organization_id, clinic_id)
    references public.clinics (organization_id, id)
);

create table if not exists public.patient_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  patient_id uuid not null,
  kind text not null,
  value text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, kind, value),
  constraint patient_identifiers_patient_fkey foreign key (organization_id, patient_id)
    references public.patients (organization_id, id) on delete restrict
);

create table if not exists public.tenant_sequences (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sequence_key text not null,
  next_value bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (organization_id, sequence_key)
);

create index if not exists patient_identifiers_patient_idx
  on public.patient_identifiers (organization_id, patient_id);

create index if not exists patients_clinic_idx
  on public.patients (organization_id, clinic_id);

alter table public.patients enable row level security;
alter table public.patient_identifiers enable row level security;
alter table public.tenant_sequences enable row level security;

drop trigger if exists set_updated_at on public.patients;
create trigger set_updated_at
  before update on public.patients
  for each row execute function private.set_updated_at();

-- Hands out the next value of a per-organization counter. The single upsert is
-- what makes it atomic: the conflicting branch takes a row lock on the existing
-- row and reads its committed next_value, so two concurrent callers cannot be
-- handed the same number. A select-then-update would race. Returns bigint; the
-- caller formats it, because the mrn column is text and the scheme is the
-- product's choice.
create or replace function private.next_sequence_value(p_org_id uuid, p_sequence_key text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_next bigint;
begin
  insert into public.tenant_sequences as ts (organization_id, sequence_key, next_value)
  values (p_org_id, p_sequence_key, 1)
  on conflict (organization_id, sequence_key)
  do update set next_value = ts.next_value + 1, updated_at = now()
  returning ts.next_value into v_next;

  return v_next;
end;
$fn$;

revoke execute on function private.next_sequence_value(uuid, text) from public;
grant execute on function private.next_sequence_value(uuid, text) to authenticated;
