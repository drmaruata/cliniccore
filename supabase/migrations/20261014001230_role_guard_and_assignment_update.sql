-- Task 9 re-review fixes. Three of these correct fixes from 01220 that did not hold.
--
-- The first is the important one, because 01220 shipped a guard that was a no-op and
-- a test that proved nothing about the product, and recorded the false claim in
-- AGENTS.md in the same commit.

-- 1. roles DELETE. 01220 gated it on `is_system is not true`. That was inert.
--
--    gen-permissions-sql.ts populates the column from role.isPlatform, so every
--    tenant-seeded role is is_system = FALSE, while the plan and the generator's own
--    header both say is_system "marks seeded roles". Three descriptions of one column
--    and no two agree. Measured against a tenant built by the real onboarding RPC:
--    all fourteen seeded roles have is_system = false, so the clause was equivalent
--    to the `organization_id is not null` already present beside it.
--
--    The test that "proved" the fix hand-seeded its fixture with is_system = true, a
--    state no production path produces. It proved the clause works against a fixture
--    the product can never reach.
--
--    The guard is now the actual invariant instead of a disputed column: a role that
--    anyone holds cannot be deleted. Deleting an assigned role cascades away its
--    role_permissions and its assignments; if it was the role granting
--    settings.manage, the deleter loses that too, and RE-CREATING a role requires
--    settings.manage - so the tenant has no administrators and no client repair path.
--    The intended workflow is unaffected: revoke the assignments, then drop the role.
--
--    The existence check is a definer helper, not an inline subquery, because
--    user_role_assignments is itself under RLS: an inline EXISTS would only see the
--    assignments the deleting principal can already see, which is not the same set.
create or replace function private.role_in_use(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (select 1 from public.user_role_assignments where role_id = p_role_id)
      or exists (select 1 from public.role_permissions where role_id = p_role_id);
$fn$;

revoke execute on function private.role_in_use(uuid) from public;
grant execute on function private.role_in_use(uuid) to authenticated;

drop policy if exists roles_delete on public.roles;
drop policy if exists roles_update on public.roles;

-- 2. roles: key and is_system were freely writable by anyone with settings.manage.
--    key is the identity the permission registry maps role identity through, so
--    renaming it breaks every lookup by key; is_system is the delete guard's input,
--    so flipping it is a self-inflicted denial of service.
--
--    This is a TRIGGER, not a policy clause. A policy would need to compare the new
--    row against the old one, which means a subquery on the same table from inside
--    that table's policy - infinite recursion, which PostgreSQL rejects outright. And
--    even if it parsed, a subquery sees the row as it is NOW, not as it was. A
--    BEFORE UPDATE trigger is the only thing that can see OLD and NEW, which is why
--    guard_role_org_scope is a trigger too.
create or replace function private.guard_role_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if (new.key is distinct from old.key or new.is_system is distinct from old.is_system)
     and current_user::text <> 'service_role' then
    raise exception 'role key and is_system are not user-writable';
  end if;
  return new;
end;
$fn$;

revoke execute on function private.guard_role_identity() from public;

do $$
begin
  -- pg_catalog.pg_triggers does not exist on this PostgreSQL 17.11 build (measured:
  -- to_regclass returns NULL; pg_trigger does resolve). The trigger catalogue is
  -- pg_trigger, so the guard is written against that directly.
  if not exists (
    select 1
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'roles'
       and t.tgname = 'guard_role_identity_trigger'
  ) then
    create trigger guard_role_identity_trigger
      before update on public.roles
      for each row execute function private.guard_role_identity();
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_delete') then
    create policy roles_delete on public.roles
      for delete to authenticated
      using (
        organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
        and not private.role_in_use(id)
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'roles'
                    and policyname = 'roles_update') then
    create policy roles_update on public.roles
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      )
      with check (
        organization_id is not null
        and organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'settings.manage')
      );
  end if;

  -- 3. user_role_assignments UPDATE was left out of 01220's fix. The INSERT got the
  --    EXISTS requiring the role to belong to the row's own organization; the UPDATE
  --    did not, and guard_role_org_scope permits a platform role by design. Measured:
  --    re-pointing an assignment at the platform role succeeded on UPDATE while the
  --    same move on INSERT was refused. Inert today - can() is org-strict - but the
  --    stated purpose of that fix was to stop saying no now rather than leaving it to
  --    a later task to remember, and half the statement types still said yes.
  if not exists (select 1 from pg_catalog.pg_policies
                  where schemaname = 'public' and tablename = 'user_role_assignments'
                    and policyname = 'user_role_assignments_update') then
    create policy user_role_assignments_update on public.user_role_assignments
      for update to authenticated
      using (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
      )
      with check (
        organization_id in (select private.current_org_ids())
        and private.can(organization_id, 'staff.manage')
        and (clinic_id is null
             or clinic_id in (select private.clinic_ids(organization_id)))
        and exists (
          select 1 from public.roles r
           where r.id = role_id
             and r.organization_id is not null
             and r.organization_id = user_role_assignments.organization_id
        )
      );
  end if;
end
$$;

-- 4. CORRECTION OF A COMMENT THAT WAS WRONG, in 01220.
--
--    01220 asserted: "status was already safe by accident: the WITH CHECK's is_member
--    requires status = 'active' on the NEW row, so a member's own suspension is
--    refused." That is false. private.is_member is declared STABLE, so inside a WITH
--    CHECK it reads the statement-start snapshot - the OLD row, not the new one.
--    Measured: an org_admin ran `update organizations set status='suspended'` and the
--    statement succeeded, taking the tenant with it; the row then vanished from every
--    subsequent query including the operator's, and reactivation returned zero rows.
--    Self-inflicted and recoverable only by a platform operator.
--
--    Row-level security cannot express "only this column may change status" - that is
--    a column privilege, and mixing the two here would have meant column grants on a
--    table whose whole point is policy-governed. Closing it properly means a definer
--    RPC for status transitions, which belongs with the tenant-administration work.
--    The comment is corrected rather than the behaviour, and the behaviour is recorded
--    as an open finding rather than as closed.