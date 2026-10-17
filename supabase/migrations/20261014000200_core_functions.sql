-- Task 5: core trigger functions.
--
-- Two trigger functions every later migration attaches:
--   private.set_updated_at()     maintains updated_at on any table with one.
--   private.guard_platform_admin()  blocks any UPDATE that flips
--     profiles.is_platform_admin unless the session's real role is the
--     service role, so no clinic user can self-promote.
--
-- set_updated_at is security definer with search_path pinned to '' (the
-- standing definer constraint; the body touches no relation and resolves
-- only now(), which pg_catalog always serves).
--
-- guard_platform_admin is the ONE sanctioned exception to that constraint:
-- it is SECURITY INVOKER and gates on current_user::text = 'service_role'.
-- A definer function cannot see the caller's real role, and the obvious
-- signal there - the request.jwt.claim.role GUC - is a transaction setting
-- that set_config can overwrite, which is PUBLIC-executable; any future
-- arbitrary-SQL surface could forge it and self-promote. current_user moves
-- only via SET ROLE, which requires role membership the authenticated role
-- does not have. This mirrors the platform's own storage triggers
-- (protect_bucket_control_columns), and the exact-match form keeps direct
-- postgres sessions fail-closed exactly as before.
--
-- The guard is UPDATE-ONLY by design: OLD is null on INSERT, so the predicate
-- would fire on every signup insert. Task 6 attaches it
-- 'before update ... for each row' and closes the INSERT side through
-- profiles RLS instead.
--
-- private.current_org_ids() is deliberately NOT here - it reads
-- public.organization_memberships, which does not exist until 00300, so it is
-- created at the end of that file, adjacent to the table it reads.

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.guard_platform_admin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin
     and current_user::text <> 'service_role' then
    raise exception 'is_platform_admin is not user-writable';
  end if;
  return new;
end;
$$;

revoke execute on function private.set_updated_at() from public;
revoke execute on function private.guard_platform_admin() from public;

grant execute on function private.set_updated_at() to authenticated;
grant execute on function private.guard_platform_admin() to authenticated;
