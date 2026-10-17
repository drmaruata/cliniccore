-- Task 5: extensions and the private schema.
--
-- Creates the extensions the schema depends on (citext for case-insensitive
-- slugs and emails, pgcrypto for gen_random_uuid) and the private schema that
-- holds the security-definer authorisation helpers. The private schema is the
-- recursion-break for RLS: its functions read membership tables as postgres
-- (bypassrls), so policies never re-enter themselves. Extension creation is
-- guarded against pg_catalog because the apply tool can reject IF NOT EXISTS
-- DDL with SQLSTATE 42601.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'citext') then
    create extension citext;
  end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pgcrypto') then
    create extension pgcrypto;
  end if;
end
$$;

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;
