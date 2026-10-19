-- Re-assert the platform seed, which a test cleanup pass deleted by accident.
--
-- WHY THIS FILE EXISTS RATHER THAN AN EDIT. Two reasons, and the first is the project
-- rule: migrations are the source of truth and a correction is always a NEW file.
--
-- The second is what actually happened. Task 13's active-org fixture deletes every
-- organization it creates, and while clearing leaked rows from repeated runs that sweep
-- was widened to every row matching a sentinel - which removed the seeded
-- platform_super_admin role and its four platform permissions along with the test debris.
-- The database no longer matched its own migrations, and nothing failed loudly: the tests
-- that reference the role assert it is ABSENT from organization-scoped reads, which
-- trivially passes when the row is missing.
--
-- That is the failure worth recording. A seeded row that no test requires to EXIST can
-- disappear silently, and the tests written to protect it are all negative.
--
-- The statements below are copied from 20261014000400_authorization.sql verbatim. They are
-- already idempotent (`on conflict ... do update` / `do nothing`), so this re-applies the
-- seed rather than inventing a second definition of it. Nothing here changes a schema, a
-- policy or a function; if a future reader finds a platform role that should not exist,
-- the fix belongs in 00400's successor, not here.

insert into public.roles (organization_id, key, name, is_system) values
  (null, 'platform_super_admin', 'Platform Super Admin', true)
on conflict (organization_id, key) do update
  set name = excluded.name, is_system = excluded.is_system;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from (values
  ('platform_super_admin', 'platform.audit.read')
  ,
  ('platform_super_admin', 'platform.subscriptions.manage')
  ,
  ('platform_super_admin', 'platform.tenants.manage')
  ,
  ('platform_super_admin', 'platform.tenants.read')
) as seed(role_key, permission_key)
join public.roles r on r.organization_id is null and r.key = seed.role_key
join public.permissions p on p.key = seed.permission_key
on conflict (role_id, permission_key) do nothing;