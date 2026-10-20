-- Restore SECURITY DEFINER on the triggers 01660 and 01670 replaced.
--
-- WHY THIS FILE EXISTS. 20261014001660 and 20261014001670 replaced three trigger
-- functions. The replacements dropped the `security definer` clause the originals carried,
-- and the re-review suite found it immediately - a trigger that runs as its caller cannot
-- call the helper it needs.
--
-- MEASURED, the exact failures:
--
--   delete from public.roles where id = ...
--     -> "permission denied for function role_in_use"
--
--   update public.organizations set status = 'suspended' ...
--     -> "permission denied for function is_platform_admin"
--
-- Both helpers were revoked from `authenticated` and from `service_role` when the private
-- surface was tightened, so a trigger that runs as either of them cannot call them. A
-- SECURITY DEFINER trigger runs as its owner - postgres - which can.
--
-- WHY IT MATTERS BEYOND A FIXED ERROR MESSAGE. A trigger that silently failed to fire would
-- be worse: `guard_organization_status` exists to stop a tenant admin suspending their own
-- tenant, and a permission error there would refuse the PLATFORM ADMINISTRATOR's legitimate
-- suspend and restore as well, while leaving the tenant admin's attempt to be blocked by
-- accident rather than by the rule.
--
-- `set search_path = ''` is kept on all three, so the definer's search path cannot be
-- redirected by a caller.

-- ---------------------------------------------------------------------------
-- 1. The role-delete guard.

create or replace function private.guard_role_delete()
returns trigger
language plpgsql
security definer
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

-- ---------------------------------------------------------------------------
-- 2. The tenant-status guard.

create or replace function private.guard_organization_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status is distinct from old.status
     and not (select private.is_platform_admin()) then
    raise exception 'only a platform administrator may change a tenant''s status; suspending your own tenant would hide it from you'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The clinic time-zone inheritance.

create or replace function private.default_clinic_timezone()
returns trigger
language plpgsql
security definer
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
