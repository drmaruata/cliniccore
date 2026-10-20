-- Let service_role suspend a tenant, as the platform's own tooling must.
--
-- WHY THIS FILE EXISTS. 20261014001660 added `private.guard_organization_status`, which
-- refuses a status change by anyone who is not a platform administrator. MEASURED, the
-- consequence was that `service_role` could NOT suspend a tenant either - and the failure
-- was SILENT in a test, because the test's setup stopped suspending anything and the
-- assertion then failed for the wrong reason.
--
-- WHY service_role IS EXEMPT. `private.is_platform_admin()` answers "is this CALLER a
-- platform administrator", and it reads the JWT. A service-role request carries NO user
-- JWT, so `auth.uid()` is NULL and the answer is false - even though service_role is, by
-- definition, the platform's own administrative path. Suspending and restoring a tenant is
-- a platform operation, and the platform's tooling has to be able to do it.
--
-- This is the same shape as `private.guard_platform_admin`, which already exempts
-- `current_user = 'service_role'` for exactly this reason.

create or replace function private.guard_organization_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status is distinct from old.status
     and current_user::text <> 'service_role'
     and not (select private.is_platform_admin()) then
    raise exception 'only a platform administrator may change a tenant''s status; suspending your own tenant would hide it from you'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

comment on function private.guard_organization_status() is
  'Refuses a status change on organizations by anyone who is not a platform administrator, and by service_role, which is the platform''s own administrative path and carries no user JWT.';
