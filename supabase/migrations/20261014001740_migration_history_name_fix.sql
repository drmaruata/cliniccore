-- Task 16 correction: the two Task 16 migration history rows named their migrations
-- without the file extension, so the history no longer matched the files.
--
-- WHAT WAS WRONG. The applier records the `name` it is given. The two Task 16
-- migrations were applied with the bare stem - "20261014001720_invitations" - instead
-- of the file name - "20261014001720_invitations.sql". Every other row in the history
-- carries the file name, and `tests/integration/tenancy-schema.test.ts` asserts that the
-- history names every migration file exactly once. That assertion is the only thing
-- keeping a replayed migration from running twice, so it is not a formality.
--
-- WHY THE SQL IS NOT RE-APPLIED. The applier does NOT dedupe by idempotency_key - it
-- re-executes - so applying the two files again to give them a second history row
-- would leave the history with FOUR rows for two files, which is the opposite of what
-- the assertion is for. The SQL is already applied, and the objects it created are the
-- ones this repository's files describe. Only the NAME of a history row was wrong.
--
-- So the rows are renamed and nothing else. The correction is a new file because an
-- applied migration is never edited - and this file is itself recorded with its full
-- file name, which is the convention the correction restores.

update supabase_migrations.schema_migrations
   set name = '20261014001720_invitations.sql'
 where name = '20261014001720_invitations';

update supabase_migrations.schema_migrations
   set name = '20261014001730_invitation_digest_correction.sql'
 where name = '20261014001730_invitation_digest_correction';
