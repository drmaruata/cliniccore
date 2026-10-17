-- Task 5: core trigger functions.
--
-- Two trigger functions every later migration attaches:
--   private.set_updated_at()     maintains updated_at on any table with one.
--   private.guard_platform_admin()  rejects any UPDATE that flips
--     profiles.is_platform_admin unless the session's current role is the
--     service role, so a clinic user cannot self-promote through the
--     PostgREST table endpoints.
--
-- set_updated_at is security definer with search_path pinned to '' (the
-- standing definer constraint; the body touches no relation and resolves
-- only now(), which pg_catalog always serves).
--
-- guard_platform_admin is SECURITY INVOKER and gates on
-- current_user::text = 'service_role'. This is DEFENCE-IN-DEPTH, not an
-- unforgeable boundary, and the reason is architectural: under PostgREST every
-- request runs in a session whose session_user is 'authenticator', which holds
-- SET on 'service_role' by design - the service key cannot work otherwise - and
-- SET ROLE checks session_user, not current_user. So any session able to run
-- arbitrary SQL (a future RPC, an injection) can SET ROLE service_role and
-- forge this check, exactly as it could forge the request.jwt.claim.role GUC
-- via set_config. No database-layer check can tell the service key apart from an
-- escalated session. What the guard does stop is the realistic path: PostgREST
-- exposes profiles as a table endpoint and clients cannot inject SET ROLE, so a
-- PATCH that tries to set is_platform_admin is rejected. The hard barriers are
-- the absence of any SQL-execution surface reachable by anon/authenticated and
-- the profiles RLS policies (Task 9). Invoker is preferred over definer because
-- it additionally holds inside a definer-hosted SQL surface, where SET ROLE is
-- forbidden by PostgreSQL; the exact-match form keeps direct postgres/admin
-- sessions fail-closed.
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
