# Row-level security - ClinicCore foundation

Read from `pg_policies` and `pg_proc` in the live project on 2026-10-26. The catalogue is the
authority; this page is a map of it. The historical reasons for each clause are in
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

| Measure                      | Value                                             |
| ---------------------------- | ------------------------------------------------- |
| Public policies              | 39 across 14 of the 16 tables                     |
| Storage policies             | 20 on `storage.objects`                           |
| Total pinned by the suite    | 59                                                |
| Tables with no policy        | `tenant_sequences`, `tenant_creation_events`      |
| The only `USING true` policy | `permissions_select` (global read-only catalogue) |
| Helpers in `private`         | 35 functions                                      |
| Application RPCs in `public` | 10                                                |

## Policy matrix

`—` means no policy for that command. A missing policy is **deny**, not "allow": RLS is enabled
on all 16 tables and none is forced, so the owner bypasses and every other role is filtered.

| Table                      | SELECT                            | INSERT                        | UPDATE                            | DELETE                         |
| -------------------------- | --------------------------------- | ----------------------------- | --------------------------------- | ------------------------------ |
| `organizations`            | `organizations_select`            | —                             | `organizations_update`            | —                              |
| `clinics`                  | `clinics_select`                  | —                             | `clinics_update`                  | —                              |
| `organization_memberships` | `organization_memberships_select` | —                             | `organization_memberships_update` | —                              |
| `clinic_memberships`       | `clinic_memberships_select`       | `clinic_memberships_write`    | `clinic_memberships_update`       | `clinic_memberships_delete`    |
| `user_role_assignments`    | `user_role_assignments_select`    | `user_role_assignments_write` | `user_role_assignments_update`    | `user_role_assignments_delete` |
| `roles`                    | `roles_select`                    | `roles_write`                 | `roles_update`                    | `roles_delete`                 |
| `role_permissions`         | `role_permissions_select`         | `role_permissions_write`      | `role_permissions_update`         | `role_permissions_delete`      |
| `permissions`              | `permissions_select`              | —                             | —                                 | —                              |
| `invitations`              | `invitations_select`              | `invitations_write`           | `invitations_update`              | `invitations_delete`           |
| `patients`                 | `patients_select`                 | `patients_write`              | `patients_update`                 | `patients_delete`              |
| `patient_identifiers`      | `patient_identifiers_select`      | `patient_identifiers_write`   | `patient_identifiers_update`      | `patient_identifiers_delete`   |
| `audit_logs`               | `audit_logs_select`               | —                             | —                                 | —                              |
| `platform_settings`        | `platform_settings_select`        | —                             | —                                 | —                              |
| `profiles`                 | `profiles_select_self`            | —                             | `profiles_update_self`            | —                              |
| `tenant_sequences`         | —                                 | —                             | —                                 | —                              |
| `tenant_creation_events`   | —                                 | —                             | —                                 | —                              |

## The predicate shapes

Four reusable shapes appear across the matrix. Reading them once is enough to read every policy.

### 1. Membership: `private.is_member(organization_id)`

Used by `organizations_select` and `organization_memberships_select`. "An active membership, in an
active organization" - the rule lives in `private.is_member_for(user, org)` and `is_member`
delegates with `auth.uid()`.

### 2. Tenant + permission (+ clinic reach)

The clinic-scoped shape is a **conjunction of three clauses**, and every clause is load-bearing:

```
organization_id in (select private.current_org_ids())          -- the caller is a member
and private.can(organization_id, '<permission>', clinic_id)    -- the caller holds the grant
and clinic_id in (select private.clinic_ids(organization_id))  -- the caller can reach the clinic
```

- The two-argument `can(org, permission)` returns no rows for a clinic-scoped policy, because its
  clinic parameter defaults to NULL. That silent failure is what invites "simplifying" the policy
  into a cross-clinic leak; do not.
- `private.clinic_ids` returns the **empty set** to a non-member and never filters
  `clinics.is_active`, so deactivating a clinic does not erase access to retained records.
- `tests/security/rls-policies.test.ts` isolates both the `can` clause and the `clinic_ids` clause
  with separate users, because either clause alone is a cross-clinic leak.

`patient_identifiers` is the deliberate exception: the table has no `clinic_id`, so its policies
reach the patient and delegate both dimensions to `patients` (correction `01210`). Its original
two-argument `can` clause hid every clinic-scoped reader's identifiers.

### 3. Role reach: `role_permissions` goes through `roles`

`role_permissions` has no `organization_id`. Every policy joins `roles` and requires
`r.organization_id in (select private.current_org_ids())`, and the write policies additionally
require `private.can(r.organization_id, 'settings.manage')` and, for INSERT/UPDATE, that the
granter holds the permission being granted (`private.can(r.organization_id, permission_key)`).
`lower(permission_key) not like 'platform.%'` appears in both write policies, because the plan's
plain `not like` would admit `Platform.tenants.manage` and leave `can`'s lower-case as the only
defence.

### 4. Self: `id = auth.uid()`

`profiles_select_self` and `profiles_update_self`. A user can edit their own profile and cannot
mint `is_platform_admin`; `private.guard_platform_admin` is the second layer and refuses any
change to that column from a client.

## Policies worth reading in full

| Policy                                     | Why it matters                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions_select`                       | The only `USING true`. The catalogue is global and read-only by design; its writes are revoked from `authenticated`. Pinned as the single exemption in the suite                                                                                                                                                                                     |
| `organizations_update`                     | `can(id, 'settings.manage') OR is_platform_admin()`. A platform operator must keep seeing suspended tenants in order to restore them                                                                                                                                                                                                                 |
| `organizations_select`                     | `is_member(id) OR is_platform_admin()` - the platform clause is what keeps a suspended tenant visible to the operator                                                                                                                                                                                                                                |
| `audit_logs_select`                        | `(member AND audit.read) OR (organization_id IS NULL AND is_platform_admin())`. The table has no write policy at all                                                                                                                                                                                                                                 |
| `roles_delete`                             | Gates on `settings.manage` **and** the `guard_role_delete` trigger's `not private.role_in_use(id)`. Neither alone is sufficient                                                                                                                                                                                                                      |
| `invitations_write` / `invitations_update` | Both carry `private.can_assign_role`, `invited_by = auth.uid()`, the tenant's-own-role check, a clause requiring every named clinic to belong to the inviting organization, and (UPDATE only) `accepted_at IS NULL`. The refusal of an invitation that names clinics is at redemption, in `private.accept_invitation` (migration `01790`) - not here |
| `user_role_assignments_write` / `_update`  | Both carry `can_assign_role` **and** `assignment_target_is_member`, closing the pre-staging gap. Read the LAST definition before recreating either - `01780` once restored `01240` and lost the `01660` clause                                                                                                                                       |
| `platform_settings_select`                 | `is_platform_admin()` only. No write policy; platform settings are operator-managed                                                                                                                                                                                                                                                                  |
| `tenant_sequences`                         | No policy. The counter is bumped only by `private.next_sequence_value`, a definer that checks membership itself                                                                                                                                                                                                                                      |

## Storage policies (20)

Four policies per bucket, one per command. Every predicate is a conjunction of:

- `bucket_id = '<bucket>'`;
- `private.storage_path_is_safe(name)` - refuses a dot-dot segment and requires a UUID first
  segment;
- `private.is_member(private.storage_org_id(name))`;
- `private.can(org, '<permission>', private.storage_clinic_id(name))`;
- `private.storage_clinic_id(name) in (select private.clinic_ids(org))` - except `org-assets`,
  which has no clinic segment;
- on INSERT and UPDATE, `owner_id = auth.uid()::text` and `(owner IS NULL OR owner = auth.uid())`;
  DELETE accepts the owner **or** a holder of `settings.manage`.

| Bucket                   | SELECT                 | INSERT / UPDATE         | DELETE                                                  |
| ------------------------ | ---------------------- | ----------------------- | ------------------------------------------------------- |
| `patient-documents`      | `patients.read`        | `patients.update`       | `patients.update`, or `settings.manage` for a non-owner |
| `clinical-attachments`   | `encounters.read`      | `encounters.write`      | `encounters.write`, or `settings.manage`                |
| `investigation-reports`  | `investigations.order` | `investigations.verify` | `investigations.verify`, or `settings.manage`           |
| `prescription-documents` | `prescriptions.create` | `prescriptions.create`  | `prescriptions.create`, or `settings.manage`            |
| `org-assets`             | `settings.manage`      | `settings.manage`       | `settings.manage`                                       |

The SELECT/INSERT/UPDATE policies are `to authenticated`. The DELETE policies are `to public` but
still require `auth.uid()` through `owner_id` and through `is_member`, so an unauthenticated caller
matches nothing. For the four clinical buckets, `archived_at IS NULL` and
`is_delete_marker IS FALSE` are part of the INSERT, UPDATE and DELETE predicates, so an object
already archived cannot be touched again. `org-assets` keeps both clauses on INSERT but omits them
on UPDATE and DELETE, so an archived org asset can still be updated or deleted - deliberate, because
refusing to delete something the service role archived would be a dead end.

`storage.protect_delete()` refuses a **direct** DELETE on `storage.objects` for every role unless
`storage.allow_delete_query` is set. A DELETE test that does not set that GUC measures the trigger,
not the policy - that is why `tests/security/storage-policies.test.ts` sets it.

## The `private` schema and privilege model

PostgREST exposes the `public` schema only. Measured: `GET /rest/v1/` answers
`info.title = "standard public schema"` and lists the 16 public tables; `POST /rest/v1/rpc/<fn>`
naming a `private.*` function answers **PGRST202** and names `public` as the schema it searched.
`pgrst.db_schemas` is not readable from SQL, so the measurement is the HTTP response, not a
setting.

The ten application RPCs in `public` are the browser's only door into the primitives:

`accept_invitation(text)`, `can(uuid, text, uuid)`, `create_organization_with_owner(text, text,
text, text, text, text)`, `delete_organization(uuid)`, `export_patients(uuid, uuid)`,
`grantable_roles(uuid)`, `has_any_membership()`, `is_platform_admin()`, `tenant_directory()`,
`write_audit(uuid, text, text, uuid, jsonb)`.

### Executable by `authenticated`

The list mixes three kinds: helpers a **policy** expression calls (evaluated as the querying
role), **trigger** functions (which run for whatever role wrote the row), and
`private.accept_invitation`, a definer the public wrapper reaches. Revoking any of them would
make every affected row **invisible** rather than denied - a silent total failure.

`private.can`, `private.can_assign_role`, `private.clinic_ids`, `private.current_org_ids`,
`private.is_member`, `private.is_platform_admin`, `private.assigned_to_self`,
`private.assignment_target_is_member`, `private.guard_role_org_scope`, `private.storage_org_id`,
`private.storage_clinic_id`, `private.storage_path_is_safe`, `private.set_updated_at`,
`private.accept_invitation`, `private.create_profile_for_new_user`.

### Trigger-only, executable by `authenticated` and `anon`

`private.audit_metadata_has_free_text`, `audit_metadata_violation`,
`audit_resource_belongs_to_org`, `default_clinic_timezone`, `guard_organization_status`,
`guard_timezone`, `write_storage_audit`. Executable by `anon` as well because a trigger fires for
whatever role wrote the row. They are validators and derivations, not oracles.

### Not executable by `authenticated`

`private.can_for`, `can_grant_for`, `can_assign_role_for`, `is_member_for` - they answer about
**other users**, and only definer functions call them.

`private.can_grant` - the subset rule **without** the owner clause. Since `01780` every grant path
calls `can_assign_role`, which is the full ceiling; a looser rule that stayed callable would be a
trap for the next policy.

`private.create_organization_with_owner`, `creation_cap_reached`, `next_sequence_value`,
`role_in_use`, `guard_role_delete`, `guard_role_identity`, `write_audit` - internal steps, reached
through their public wrappers or through a trigger.

`role_in_use` is a deliberate example: it answers "does anyone hold this role", including roles the
caller cannot see, so leaving it callable would be an oracle. The suite asserts a direct call is
refused.

## Commands with no policy, and the three refusal shapes

Nine command/table pairs are refused by RLS or by a revoked privilege. They are asserted
behaviourally in `tests/security/tenant-isolation.test.ts`, because a catalogue read cannot see the
difference between "refused" and "silently filtered".

| Command                                                                     | Shape of the refusal                                                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_logs` INSERT, UPDATE, DELETE                                         | **Permission denied.** Only SELECT is granted to `authenticated`; writes are revoked, so append-only does not depend on there being no policy |
| `organizations` INSERT, `clinics` INSERT, `organization_memberships` INSERT | **Raises** `new row violates row-level security policy`. An INSERT has no existing row to filter                                              |
| `organizations` DELETE, `clinics` DELETE, `organization_memberships` DELETE | **Zero rows, no error.** A DELETE whose `USING` clause does not match is filtered out and the statement succeeds                              |

A fourth fact: `profiles` INSERT and DELETE also have the privilege and no policy, so they follow
the same two shapes. They are not part of the nine verified pairs, because the profile row is
created by the `create_profile_for_new_user` trigger.

The distinction matters when writing a test. An RLS `USING` miss on UPDATE or DELETE **filters**;
a failed `WITH CHECK` or a trigger **raises**. Getting this wrong produced false failures in this
project more than once - see `TESTING.md`.

## Superseded behaviour worth knowing

- `private.current_org_ids`, `is_member` and `can` all require `organizations.status = 'active'`,
  so suspending a tenant cuts PHI access immediately. `private.is_platform_admin` deliberately does
  **not**, or an operator could not restore a suspended tenant.
- `clinic_ids` asks `is_member_for` for each organization; the membership rule has **one** copy.
- `private.can` is a one-line delegation to `private.can_for(auth.uid(), ...)`. A reader looking for
  the rule will not find it in `can`; it lives in `can_for`.
- `private.can` is org-strict **and** platform-key-refusing. Both clauses are load-bearing and
  neither may be "simplified" away.
