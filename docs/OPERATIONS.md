# Operations - ClinicCore foundation

Day-to-day runbook for the foundation. Every command below is an **operator** action, run through
the Supabase SQL editor, the Composio MCP or a direct connection as the owner. None of it is exposed
as an admin UI.

The product is not production-ready; there is no on-call rotation, no monitoring and no backup job
in this repository. What follows is what can be done, and what cannot.

## Routine checks

| Check               | How                                                            | Healthy value                                                           |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Gate set            | `npm run typecheck && npm run lint && npm test`                | exit 0; read all four `lint` sub-gates                                  |
| Migration history   | `select count(*) from supabase_migrations.schema_migrations`   | equals the number of files in `supabase/migrations/` (61 on 2026-10-26) |
| Policy catalogue    | `select count(*) from pg_policies where schemaname = 'public'` | 39; plus 20 on `storage.objects`                                        |
| RLS on every table  | `select relname from pg_class … where not relrowsecurity`      | empty                                                                   |
| Buckets private     | `select name, public from storage.buckets`                     | all `public = false`                                                    |
| Residual probe data | organizations with slug `probe-*` or a name from the E2E specs | none                                                                    |

An applied migration is **not** proof the object exists. A lost `organizations_update` policy made
the tenant settings PATCH return 204 with no change and broke seven assertions in three suites; the
catalogue read is what found it. Check the catalogue, not the history.

## Migrations

- **Apply** one file per Composio call. Files are the source of truth; the applier records the name
  it is given, so pass the **full filename**.
- **No rollback.** There are no down migrations. An applied migration is never edited. A correction
  is a new file with a later version; `01880` is one.
- **No `supabase db push`.** There is no Supabase Personal Access Token.
- A failure mid-apply leaves the transaction rolled back by the applier, but verify anyway: read the
  catalogue for the objects the file should have created.
- A correction that recreates a policy must read the **last** definition of that policy. Restoring
  an older one loses later clauses silently - the suite catches it only if the clause has a test.

## Tenants

### Suspend

```sql
update public.organizations set status = 'suspended' where id = '<org-uuid>';
```

- `private.guard_organization_status` allows this only for a **platform administrator**,
  `service_role` or a superuser. A tenant administrator cannot suspend their own tenant.
- Effect: `current_org_ids`, `is_member` and `clinic_ids` all require
  `organizations.status = 'active'`, so every tenant policy stops matching immediately. PHI access
  is cut.
- The members see **no** membership rows. The shell's second state says "your access is not active"
  instead of offering onboarding. `public.has_any_membership()` is what distinguishes the two.
- A platform operator still sees the tenant, because `organizations_select` ORs in
  `private.is_platform_admin()` and that predicate deliberately does not check status.

### Restore

```sql
update public.organizations set status = 'active' where id = '<org-uuid>';
```

Same guard. A restore does not touch memberships, role assignments, clinics or storage. Verify the
tenant appears for its members again; if a member was separately suspended, their membership stays
suspended.

### Archive

`status = 'archived'` has the same access effect as `suspended`. It is a label for the operator; no
job archives or purges anything.

### Delete

`public.delete_organization(p_org_id)` deletes a tenant the caller **administers** - it requires
`settings.manage` in that organization - together with everything under it.

- The caller must be a real signed-in user; `auth.uid()` is what `private.can` evaluates.
- The function is a definer, so RLS does not stand in the way; the permission check is inside it.
- Roles cascade. `private.guard_role_delete` returns early when the role's organization no longer
  exists, so the cascade succeeds - but a **deliberate** role delete that still holds grants or
  assignments is still refused.
- There is no soft delete and no restore for a deleted tenant.
- **Storage objects survive.** `delete_organization` deletes only `public.organizations`; object
  tenancy is the object name and there is no foreign key to cascade, so the bucket rows and their
  bytes must be removed manually.
- The `tenant_creation_events` row is **not** deleted: the ledger has no foreign key, because it is
  the rate-limit evidence. Delete the rows by `user_id` only when removing the accounts that made
  them.

## Memberships and roles

### Suspend a member

```sql
update public.organization_memberships set status = 'suspended'
 where organization_id = '<org-uuid>' and user_id = '<user-uuid>';
```

A holder of `staff.manage` may do this through the table - `organization_memberships_update` allows
it - but there is **no UI control**. A suspended member's own read of the membership disappears, and
their invitation redemption is refused **without spending the token**, so the invitation stays
redeemable if the membership is reactivated.

`status = 'revoked'` is the terminal label; nothing enforces a difference from `suspended` beyond
the string.

### Change a role grant

Use `user_role_assignments` as a holder of `staff.manage`, or `public.grantable_roles(org)` to see
what the caller may hand out. The ceiling is `private.can_assign_role`: the subset rule plus
only-an-owner-may-grant-owner. Do not bypass it with the service role unless the intent is to
override the ceiling - and if you do, say so in the audit trail.

### Remove a member

There is no remove endpoint. Delete the `user_role_assignments` rows, then the
`organization_memberships` row. `authenticated` holds no DELETE policy on
`organization_memberships`, so a client DELETE matches zero rows and reports no error - use the
service role or the SQL editor. Deleting the auth user cascades the membership but **not** the
organization, so do not expect a user deletion to tidy a tenant.

## Invitations

- The raw token exists only in the link the owner copies and in the redemption request. Only the
  SHA-256 digest is stored. **A lost link cannot be recovered** - delete the invitation and issue a
  new one.
- Lifetime is 7 days (`INVITATION_LIFETIME_DAYS`). An expired or accepted invitation cannot be
  re-issued; `invitations_update` refuses any change to an accepted row.
- Redemption requires the acceptor's account address to equal the invitation's address, and the
  JWT's email claim to match the session. A bearer whose account carries a different address gets
  nothing. While "Confirm email" is disabled the address is implicitly confirmed at signup, so
  this binds the account to the **stored** address and does not prove mailbox control - re-enabling
  confirmation is the control.
- An invitation naming `clinic_ids` is refused rather than over-granted. The invite form offers no
  clinic choice.
- Look up an invitation by address:
  `select email, role_id, expires_at, accepted_at from public.invitations where email = '<address>';`
- **No email is sent.** The members page displays the link for manual sharing and says so.

## Password reset support

- The reset mail redirects to `${NEXT_PUBLIC_APP_URL}/api/auth/verify?next=/reset-password`. The
  hosted project's redirect allow-list must include it, or GoTrue refuses to send.
- `NEXT_PUBLIC_APP_URL` must be set; if it is not, the action logs an error and sends nothing.
- The response is generic for a known and an unknown address - that is the enumeration guarantee,
  not a bug.
- **Delivery is unverified.** No mailbox was available, and a request for an account at
  `example.com` was refused with `email_address_invalid`. Do not promise a user that a mail was
  sent; say the request was accepted.
- If a user is locked out, an operator can reset the password through the Supabase admin API. That
  action is outside this application and leaves no `audit_logs` row.

## Audit inspection

```sql
select created_at, actor_user_id, action, resource_type, resource_id, metadata
  from public.audit_logs
 where organization_id = '<org-uuid>'
 order by created_at desc
 limit 100;
```

- In the application, a holder of `audit.read` can read the organization's trail;
  `audit_logs_select` also admits a platform administrator for `organization_id IS NULL` rows.
- The table has **no foreign keys**, so a deleted tenant or actor does not erase the trail. The
  `resource_id` may point at a row that no longer exists; that is by design.
- Metadata carries identifiers and codes. A value containing whitespace, or a key naming clinical
  free text, is refused at write time. One residual: a single-word value that is not a free-text key
  name is indistinguishable from a code and passes.
- **Append-only is not tamper-proof.** A database owner, superuser or service key can update or
  delete rows. There is no hash chain and no external shipping. Treat the table as evidence, not as
  WORM storage.

## Storage inspection

```sql
select bucket_id, name, owner_id, created_at, updated_at
  from storage.objects
 where bucket_id = 'patient-documents'
 order by created_at desc
 limit 100;
```

- Paths: `<org>/<clinic>/<file>` for `patient-documents`, `clinical-attachments`,
  `investigation-reports`, `prescription-documents`; `<org>/<file>` for `org-assets`.
- **Never move an object between prefixes by hand.** Tenancy is the name; a moved object changes
  tenant, and `private.storage_path_is_safe` will refuse a malformed one.
- A direct DELETE on `storage.objects` is refused for every role unless
  `storage.allow_delete_query` is set; that is `storage.protect_delete()`, not the application
  policy. Set it only inside a transaction you intend to roll back, or you will delete objects the
  policy would have protected.
- Buckets are private. A read needs a signed URL; there is no public bucket.
- `file_size_limit` is NULL on all five buckets. The MIME allow-list is the only object-level limit.

## Incident triage: suspected cross-tenant access

Do these in order. Do not "fix" a policy before you know which layer failed.

1. **Confirm the report is about data, not UI.** Ask for the organization, the caller, the row and a
   timestamp. An empty screen is not a disclosure.
2. **Read the catalogue, not the migrations.**
   `select tablename, policyname, cmd, qual from pg_policies where schemaname in ('public','storage') order by 1,2;`
   Verify 39 + 20. A missing policy is **default-deny**: zero rows and no error, which looks like
   "the feature is broken", not "data leaked".
3. **Check the helper EXECUTE set.** If `private.can`, `clinic_ids`, `current_org_ids`,
   `is_member`, `is_platform_admin`, `assignment_target_is_member` or `can_assign_role` lost EXECUTE
   for `authenticated`, every policy referencing it makes rows **invisible**. That is a silent total
   failure, not a leak - but it is the first thing to rule out.
4. **Check the grants.** `has_table_privilege('authenticated', 'public.<table>', 'SELECT')` should be
   true for every tenant table; `audit_logs` should have SELECT only. A stray
   `grant insert on audit_logs to authenticated` reopens a hole Task 9 closed.
5. **Check the policy-referenced inventory.** `tests/integration/public-rpc-privileges.test.ts`
   derives it from `pg_policies` in both directions. Run it with `REQUIRE_TEST_DATABASE_URL=true`.
6. **Re-run the isolation suite** with
   `REQUIRE_TEST_DATABASE_URL=true npx vitest run tests/security`. If it fails, the mutation report
   in the OS temp directory names the break and the assertion.
7. **Reproduce over HTTP, not only over `pg`.** A direct connection running as the table owner
   bypasses RLS. Use a real user's JWT and PostgREST; a cross-tenant write must return **0 rows with
   no error**.
8. **If a service-role key may have leaked**, rotate it in the Supabase dashboard and redeploy. The
   key is not recoverable from the repository by design; `check-no-secrets` is the guard, not a
   cleanup tool.
9. **Record the finding** in `docs/IMPLEMENTATION_STATUS.md` as an append-only entry, with the
   measurement, not the conclusion.

JWT verification is real: a flipped signature, a forged signature, and a payload rewritten to
`role: service_role` with the genuine signature all return 401. If one of those succeeds, the
problem is at the platform, not in this schema.

## Backup and restore caveats

- **There is no backup job in this repository.** Whatever the Supabase plan provides is the backup.
- A tenant restore is not a one-table operation. `organizations` cascades to clinics, memberships,
  assignments, roles, invitations, patients, identifiers and sequences; restoring only the
  organization leaves the rest missing.
- **Storage objects are not in that cascade.** Tenancy is the object name and there is no foreign
  key, so a tenant restore does not bring the bucket objects back - and deleting a tenant does not
  remove them. They must be handled separately.
- `audit_logs`, `platform_settings` and `tenant_creation_events` have **no foreign keys**, so a
  tenant restore does **not** bring its audit trail or its creation ledger back. They must be
  restored separately, by `organization_id` or `user_id`.
- `auth.users` is Supabase-managed. Restoring an organization does not restore the accounts that
  belonged to it.
- `patient_identifiers` has `ON DELETE RESTRICT` from `patients`. A partial restore that re-inserts
  identifiers before patients fails.
- Roles are never deleted by hand. `guard_role_delete` refuses a role still in use; the cascade of
  an organization deletion is the exception, and it relies on the organization row being gone.

## Monitoring gaps

There is no APM, no error tracker, no metrics endpoint, no log aggregation, no uptime check and no
alerting. The only signals are:

- the gate output on a deploy;
- the E2E cleanup's residual counts;
- the mutation report in the OS temp directory;
- Postgres logs, if the platform retains them.

A production deployment must add at least: error tracking, a health check, alerting on 5xx and on a
failed migration, and an audit-log export. None of that exists here, and none of it is claimed.
