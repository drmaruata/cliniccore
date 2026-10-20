-- Let the platform's own administrative path change a tenant's status.
--
-- WHY THIS FILE EXISTS, AND WHY THE PREVIOUS ATTEMPT DID NOT WORK. 20261014001690 added
-- `current_user::text <> 'service_role'` to the status guard. MEASURED: it changed
-- nothing, because the guard is SECURITY DEFINER - and inside a SECURITY DEFINER function
-- `current_user` is the function's OWNER, not the caller. So the comparison was always
-- true, the exemption never fired, and `service_role` still could not suspend a tenant.
--
-- The fix is the shape `private.guard_platform_admin` already uses: the guard runs as its
-- INVOKER, so `current_user` is the real caller, and the exemption can be read.
--
-- The exemption is for the platform's administrative path: `service_role`, which is what
-- PostgREST authenticates the platform's own tooling as, and a superuser, which is the
-- owner. A superuser is exempt because it can already do anything to the table directly,
-- and because migrations and direct test connections run as one - and a guard that
-- silently refused a migration's own UPDATE would be a worse failure than no guard.
--
-- The guard is INVOKER, so `private.is_platform_admin()` is called as the caller. That
-- helper is executable by `authenticated` and by the owner, and the service_role and
-- superuser paths return before reaching it.

create or replace function private.guard_organization_status()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status is distinct from old.status then
    -- The platform's own administrative path. service_role is what PostgREST authenticates
    -- the platform's tooling as, and it carries no user JWT, so it cannot be a platform
    -- ADMINISTRATOR - it is something else, and it is legitimate here.
    if current_user::text = 'service_role'
       or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
      return new;
    end if;

    if not (select private.is_platform_admin()) then
      raise exception 'only a platform administrator may change a tenant''s status; suspending your own tenant would hide it from you'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

comment on function private.guard_organization_status() is
  'Refuses a status change on organizations by anyone who is not a platform administrator, and exempts service_role and superusers, which are the platform own administrative path. Runs as its INVOKER so current_user is the real caller - inside a SECURITY DEFINER function it would be the owner and the exemption could never fire.';
