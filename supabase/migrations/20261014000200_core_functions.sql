-- Task 5: core security-definer functions.
--
-- Two trigger functions every later migration attaches:
--   private.set_updated_at()    maintains updated_at on any table that has one.
--   private.guard_platform_admin()  blocks any UPDATE that flips
--     profiles.is_platform_admin unless the statement carries the
--     service-role claim, so no clinic user can self-promote.
--
-- Both are security definer with search_path pinned to '' and every reference
-- schema-qualified: an unpinned search_path on a definer function is a
-- privilege-escalation vector. Neither references a table created in a later
-- migration. private.current_org_ids() is deliberately NOT here - it reads
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
security definer
set search_path = ''
as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin
     and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'is_platform_admin is not user-writable';
  end if;
  return new;
end;
$$;

revoke execute on function private.set_updated_at() from public;
revoke execute on function private.guard_platform_admin() from public;

grant execute on function private.set_updated_at() to authenticated;
grant execute on function private.guard_platform_admin() to authenticated;
