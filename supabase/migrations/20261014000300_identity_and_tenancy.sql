-- Task 6: identity and tenancy schema.
--
-- The six tables every later tenancy object hangs from: profiles (one per auth
-- user), organizations (the tenant root), organization_memberships (who belongs
-- to a tenant), clinics, clinic_memberships (which clinics a membership may
-- touch) and invitations.
--
-- Tenant isolation is structural, not procedural. Every tenant-owned table
-- carries organization_id and a unique (organization_id, id); the child tables
-- reference their parents through COMPOSITE foreign keys that both include
-- organization_id, so a row cannot point at a parent in another organization
-- even if application code is wrong. clinic_memberships' two foreign keys are
-- the load-bearing case.
--
-- RLS is ENABLED here (deny-all, no policies) and given policies in Task 9.
-- Supabase grants anon/authenticated access to new public tables by default, so
-- without this a table created here would be reachable through PostgREST in the
-- window before Task 9. Deny-all by default is the safe posture.
--
-- invitations.role_id is a plain uuid here, NOT a foreign key: roles is created
-- in Task 7 (00400), one migration later. Task 7 adds the foreign key once the
-- table exists - a forward reference would fail at apply time.
--
-- Two trigger functions from Task 5 are attached: private.set_updated_at() on
-- every table with an updated_at column, and private.guard_platform_admin() on
-- profiles for UPDATE ONLY (an INSERT would have no OLD row, so the guard would
-- reject every signup). private.current_org_ids() is created here, at the end,
-- adjacent to the organization_memberships table it reads.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  timezone text not null default 'Asia/Kolkata',
  locale text not null default 'en-IN',
  currency char(3) not null default 'INR',
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id),
  unique (organization_id, id)
);

create table if not exists public.clinics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  code citext,
  timezone text,
  address jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (organization_id, id)
);

create table if not exists public.clinic_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  membership_id uuid not null,
  clinic_id uuid not null,
  created_at timestamptz not null default now(),
  unique (membership_id, clinic_id),
  constraint clinic_memberships_membership_fkey foreign key (organization_id, membership_id)
    references public.organization_memberships (organization_id, id) on delete cascade,
  constraint clinic_memberships_clinic_fkey foreign key (organization_id, clinic_id)
    references public.clinics (organization_id, id) on delete cascade
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email citext not null,
  role_id uuid not null,
  token_hash text not null unique,
  clinic_ids uuid[] not null default '{}',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.clinics enable row level security;
alter table public.clinic_memberships enable row level security;
alter table public.invitations enable row level security;

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.organizations;
create trigger set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.organization_memberships;
create trigger set_updated_at
  before update on public.organization_memberships
  for each row execute function private.set_updated_at();

drop trigger if exists set_updated_at on public.clinics;
create trigger set_updated_at
  before update on public.clinics
  for each row execute function private.set_updated_at();

drop trigger if exists guard_platform_admin on public.profiles;
create trigger guard_platform_admin
  before update on public.profiles
  for each row execute function private.guard_platform_admin();

create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.create_profile_for_new_user();

create or replace function private.current_org_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select organization_id
  from public.organization_memberships
  where user_id = (select auth.uid())
    and status = 'active';
$$;

revoke execute on function private.current_org_ids() from public;
grant execute on function private.current_org_ids() to authenticated;
