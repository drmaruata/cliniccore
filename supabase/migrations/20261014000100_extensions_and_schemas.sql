-- Task 5: extensions and the private schema.
--
-- Creates the extensions the schema depends on and the private schema that
-- holds the authorisation helpers. The private schema is the recursion-break
-- for RLS: its functions read membership tables as postgres (bypassrls), so
-- policies never re-enter themselves. citext backs case-insensitive slugs and
-- emails. pgcrypto is retained for future crypt/digest use; gen_random_uuid()
-- needs no extension on PostgreSQL 13+. Extension creation is guarded against
-- pg_catalog because the apply tool can reject IF NOT EXISTS DDL with
-- SQLSTATE 42601, and each create pins its schema so placement is
-- deterministic on fresh environments rather than following the applier's
-- search_path.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'citext') then
    create extension citext with schema public;
  end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pgcrypto') then
    create extension pgcrypto with schema public;
  end if;
end
$$;

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;
