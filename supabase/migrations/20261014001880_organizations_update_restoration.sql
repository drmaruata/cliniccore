-- ---------------------------------------------------------------------------
-- Correction: restore `organizations_update`, which the live database lost.
--
-- MEASURED: `20261014001220_privilege_gates.sql` IS in the applied history and it
-- creates this policy, no later migration drops it, and
-- `tests/security/rls-policies.test.ts` asserts it - yet the live catalogue carried
-- only `organizations_select` on the table (38 public policies against the asserted
-- 39). With the UPDATE policy absent, row-level security DEFAULT-DENIES the command for
-- everyone: the statement matches zero rows and raises nothing, so the tenant
-- settings PATCH returned 204 instead of the timezone guard's 400, the suspend and
-- restore controls in `tests/integration/authorization-gaps.test.ts` failed, and the
-- permitted-settings-write control read empty. Nothing in this repository's applied
-- work drops the policy after 01220, and no DDL audit trail exists to date the loss;
-- this file restores the migration files' definition verbatim so the catalogue and
-- the history agree again.
-- ----------------------------------------------------------------------------

drop policy if exists organizations_update on public.organizations;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'organizations'
                    and policyname = 'organizations_update') then
    create policy organizations_update on public.organizations
      for update to authenticated
      using (private.can(id, 'settings.manage') or (select private.is_platform_admin()))
      with check (private.can(id, 'settings.manage') or (select private.is_platform_admin()));
  end if;
end
$$;
