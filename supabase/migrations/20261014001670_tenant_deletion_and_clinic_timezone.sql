-- Let an organization with roles be deleted, and give every clinic a time zone.
--
-- ---------------------------------------------------------------------------
-- B1. AN ORGANIZATION THAT HAS ROLES CANNOT BE DELETED.
--
-- MEASURED, over HTTP as `service_role`:
--
--   DELETE /rest/v1/organizations?id=eq.<org>
--
-- returns **400 "role accountant is still in use"** and the organization is still there.
-- `private.guard_role_delete` refuses to delete a role that still holds grants or
-- assignments - and it fires on the CASCADE delete of the organization just the same,
-- because a cascading delete of a parent row issues a delete of its children.
--
-- WHY THE CASCADE CAN BE DISTINGUISHED. When PostgreSQL cascades, it deletes the
-- REFERENCING row - the organization - and then issues the delete of the referenced rows,
-- the roles. So by the time the roles' BEFORE DELETE trigger runs, the organization row is
-- ALREADY GONE. A role whose organization no longer exists is being removed as a
-- consequence of that organization's deletion, not by a deliberate attempt to delete a role
-- that is still in use. A deliberate role deletion leaves the organization present, and is
-- still refused.
--
-- This matters beyond convenience. `private.create_organization_with_owner` creates
-- fourteen roles, so every organization the product creates is undeletable - which for a
-- PHI system that may have to erase a tenant outright is a retention problem, not a
-- convenience one. And the PUBLIC RPC makes undeletable tenants cheap to create.
--
-- ---------------------------------------------------------------------------
-- B3. A CLINIC WITH NO TIME ZONE BILLS IN THE SERVER'S DAY.
--
-- `clinics.timezone` is nullable by design, and `Intl.DateTimeFormat` treats a nullish
-- zone as "use the runtime's zone" rather than throwing. MEASURED. So a clinic with no
-- zone silently bills in the SERVER's day, which for a clinic in another timezone is a
-- wrong-day invoice rather than a visible error.
--
-- The fix is NOT NULL plus an INHERITANCE, not a guess. A clinic belongs to an
-- organization, and the organization already carries a time zone, so a clinic that does not
-- name one should INHERIT its organization's - which a column DEFAULT cannot express,
-- because the default would have to be a constant and the organization's zone is not one.
-- A BEFORE INSERT trigger fills it, and the same canonical-zone rule the guard already
-- applies then checks the inherited value.
--
-- The trigger is named so that it sorts BEFORE the guard for the same timing on the same
-- table: PostgreSQL fires same-timing triggers in name order, and the guard must see the
-- INHERITED value, not the NULL it was handed.

-- ---------------------------------------------------------------------------
-- 1. B1. A cascade-aware role guard.

create or replace function private.guard_role_delete()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if private.role_in_use(old.id) then
    -- A cascading delete removes the organization FIRST and then its roles, so a role
    -- whose organization is already gone is being removed as a consequence of that
    -- organization's deletion rather than by a deliberate attempt to delete a role that is
    -- still in use.
    if old.organization_id is not null
       and not exists (select 1 from public.organizations where id = old.organization_id) then
      return old;
    end if;

    raise exception 'role % is still in use', old.key;
  end if;
  return old;
end;
$fn$;

comment on function private.guard_role_delete() is
  'Refuses to delete a role that still holds grants or assignments - unless its organization has already gone, which is the cascade of an organization deletion rather than a deliberate role deletion.';

drop trigger if exists guard_role_delete_trigger on public.roles;
create trigger guard_role_delete_trigger
  before delete on public.roles
  for each row execute function private.guard_role_delete();

-- ---------------------------------------------------------------------------
-- 2. B3. Every clinic has a time zone, inherited from its organization.

alter table public.clinics alter column timezone set not null;

create or replace function private.default_clinic_timezone()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.timezone is null then
    select o.timezone into new.timezone
      from public.organizations o
     where o.id = new.organization_id;
  end if;
  return new;
end;
$fn$;

comment on function private.default_clinic_timezone() is
  'Fills a clinic''s time zone from its organization, so a clinic is never left with none. A column default cannot do this, because the default would have to be a constant and the organization''s zone is not one.';

drop trigger if exists clinics_default_timezone on public.clinics;
create trigger clinics_default_timezone
  before insert on public.clinics
  for each row execute function private.default_clinic_timezone();
