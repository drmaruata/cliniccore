# Database schema - ClinicCore foundation

Measured from the live project through `TEST_DATABASE_URL` (`pg_class`, `information_schema`,
`pg_constraint`, `pg_indexes`, `pg_policies`) on 2026-10-26, and cross-checked against the 61
files in `supabase/migrations/`. Counts below are catalogue reads, not restatements.

| Measure                           | Value                                                     |
| --------------------------------- | --------------------------------------------------------- |
| Applied migrations                | 61 (history rows 61; `20261014000100` … `20261014001880`) |
| Public tables                     | 16, all `relrowsecurity = true`, none `force`             |
| Columns in `public`               | 100                                                       |
| Constraints                       | 55: 16 primary, 21 foreign, 12 unique, 6 check            |
| Indexes                           | 36                                                        |
| Triggers                          | 18 (9 trigger functions)                                  |
| Policies                          | 39 in `public` + 20 on `storage.objects`                  |
| Private buckets                   | 5, all `public = false`                                   |
| Tables carrying `organization_id` | 10                                                        |

## Schemas and extensions

`public` is the only schema PostgREST exposes. `private` holds the helpers, guards and definers
the browser must not call; `auth`, `storage`, `realtime`, `vault`, `graphql`, `graphql_public`,
`extensions` and `supabase_migrations` are Supabase's own.

| Extension            | Schema                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `citext`             | `public` (case-insensitive slug, clinic code, invitation and patient email) |
| `pgcrypto`           | `extensions`                                                                |
| `uuid-ossp`          | `extensions`                                                                |
| `pg_stat_statements` | `extensions`                                                                |
| `supabase_vault`     | `vault`                                                                     |
| `plpgsql`            | `pg_catalog` (built in)                                                     |

`citext` lives in `public` because migration `00100` requested `with schema public`; the others
were already installed. There are **no enums in `public`** - every status is `text` with a CHECK
constraint, because adding a value to a CHECK is a plain migration while adding one to an enum is
not.

## Tables

`tenant` marks how a row reaches its organization: `org` = own `organization_id`; `via role` =
through `roles.organization_id` (`role_permissions` has no organization column); `root` = the
tenant itself; `global` = no tenant.

| Table                      | Cols | Tenant         | Purpose                                                                                             |
| -------------------------- | ---- | -------------- | --------------------------------------------------------------------------------------------------- |
| `organizations`            | 9    | root           | The tenant. `slug` is the URL key, `currency` `character(3)`, `locale`, `timezone`                  |
| `clinics`                  | 9    | org            | Physical clinic; `code` unique per organization, `timezone` NOT NULL                                |
| `organization_memberships` | 6    | org            | A user's membership and status (`active` / `suspended` / `revoked`)                                 |
| `clinic_memberships`       | 5    | org            | Scopes a membership to a clinic                                                                     |
| `user_role_assignments`    | 6    | org            | Role grant, optional `clinic_id` for a clinic-scoped grant                                          |
| `roles`                    | 6    | org (nullable) | `organization_id NULL` is a platform role                                                           |
| `role_permissions`         | 2    | via role       | `(role_id, permission_key)`                                                                         |
| `permissions`              | 2    | global         | 21 permission keys, read-only to clients                                                            |
| `invitations`              | 10   | org            | `token_hash` (SHA-256), `email`, `role_id`, `clinic_ids`, `expires_at`, `accepted_at`, `invited_by` |
| `patients`                 | 15   | org            | PHI-shaped target for the isolation suite; no application UI                                        |
| `patient_identifiers`      | 6    | org            | Identifier values; ON DELETE RESTRICT from `patients`                                               |
| `audit_logs`               | 8    | org (nullable) | Append-only; no foreign keys                                                                        |
| `platform_settings`        | 4    | global         | Operator settings; no foreign keys                                                                  |
| `profiles`                 | 5    | per user       | `full_name`, `is_platform_admin`                                                                    |
| `tenant_sequences`         | 4    | org            | `(organization_id, sequence_key)` counter; definer-only writer                                      |
| `tenant_creation_events`   | 3    | global         | One row per tenant creation; the creation-cap evidence                                              |

### Full column list

Types are abbreviated (`text`, `uuid`, `timestamptz`, `jsonb`, `bigint`, `boolean`, `date`,
`citext`, `text[]`, `char(3)`). `!` = NOT NULL. Every `id` is `uuid` with `gen_random_uuid()`
except `audit_logs.id`, which is `bigint` identity.

| Table                      | Columns                                                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_logs`               | `id bigint!`, `organization_id uuid`, `actor_user_id uuid`, `action text!`, `resource_type text!`, `resource_id uuid`, `metadata jsonb!`, `created_at timestamptz!`                                                                                                                                |
| `clinic_memberships`       | `id uuid!`, `organization_id uuid!`, `membership_id uuid!`, `clinic_id uuid!`, `created_at timestamptz!`                                                                                                                                                                                           |
| `clinics`                  | `id uuid!`, `organization_id uuid!`, `name text!`, `code citext`, `timezone text!`, `address jsonb`, `is_active boolean!`, `created_at timestamptz!`, `updated_at timestamptz!`                                                                                                                    |
| `invitations`              | `id uuid!`, `organization_id uuid!`, `email citext!`, `role_id uuid!`, `token_hash text!`, `clinic_ids text[]!`, `expires_at timestamptz!`, `accepted_at timestamptz`, `invited_by uuid!`, `created_at timestamptz!`                                                                               |
| `organization_memberships` | `id uuid!`, `organization_id uuid!`, `user_id uuid!`, `status text!`, `created_at timestamptz!`, `updated_at timestamptz!`                                                                                                                                                                         |
| `organizations`            | `id uuid!`, `name text!`, `slug citext!`, `timezone text!`, `locale text!`, `currency char(3)!`, `status text!`, `created_at timestamptz!`, `updated_at timestamptz!`                                                                                                                              |
| `patient_identifiers`      | `id uuid!`, `organization_id uuid!`, `patient_id uuid!`, `kind text!`, `value text!`, `created_at timestamptz!`                                                                                                                                                                                    |
| `patients`                 | `id uuid!`, `organization_id uuid!`, `clinic_id uuid!`, `mrn text!`, `first_name text`, `last_name text`, `date_of_birth date`, `sex text`, `phone text`, `email citext`, `address jsonb`, `is_archived boolean!`, `archived_at timestamptz`, `created_at timestamptz!`, `updated_at timestamptz!` |
| `permissions`              | `key text!`, `description text!`                                                                                                                                                                                                                                                                   |
| `platform_settings`        | `key text!`, `value jsonb!`, `updated_at timestamptz!`, `updated_by uuid`                                                                                                                                                                                                                          |
| `profiles`                 | `id uuid!`, `full_name text`, `is_platform_admin boolean!`, `created_at timestamptz!`, `updated_at timestamptz!`                                                                                                                                                                                   |
| `role_permissions`         | `role_id uuid!`, `permission_key text!`                                                                                                                                                                                                                                                            |
| `roles`                    | `id uuid!`, `organization_id uuid`, `key text!`, `name text!`, `is_system boolean!`, `created_at timestamptz!`                                                                                                                                                                                     |
| `tenant_creation_events`   | `id uuid!`, `user_id uuid!`, `created_at timestamptz!`                                                                                                                                                                                                                                             |
| `tenant_sequences`         | `organization_id uuid!`, `sequence_key text!`, `next_value bigint!`, `updated_at timestamptz!`                                                                                                                                                                                                     |
| `user_role_assignments`    | `id uuid!`, `organization_id uuid!`, `user_id uuid!`, `role_id uuid!`, `clinic_id uuid`, `created_at timestamptz!`                                                                                                                                                                                 |

## Constraints that carry meaning

### Composite foreign keys (5 of 21)

Postgres cannot make a foreign key RLS-aware, so the tenant is carried into the key. Each pair
below references a `(organization_id, id)` unique key on the parent - a parent row in another
tenant is structurally unreachable.

| Child                   | Columns                            | Parent                                                |
| ----------------------- | ---------------------------------- | ----------------------------------------------------- |
| `clinic_memberships`    | `(organization_id, clinic_id)`     | `clinics (organization_id, id)`                       |
| `clinic_memberships`    | `(organization_id, membership_id)` | `organization_memberships (organization_id, id)`      |
| `patients`              | `(organization_id, clinic_id)`     | `clinics (organization_id, id)`                       |
| `patient_identifiers`   | `(organization_id, patient_id)`    | `patients (organization_id, id)` - ON DELETE RESTRICT |
| `user_role_assignments` | `(organization_id, clinic_id)`     | `clinics (organization_id, id)`                       |

The three role references (`invitations.role_id`, `role_permissions.role_id`,
`user_role_assignments.role_id`) are **single-column**. A role's tenant scope is closed by
`private.guard_role_org_scope()` (a trigger) and by the policies that write those tables - not by
the key. Do not describe it as a composite reference.

### Unique constraints (12)

| Constraint                                                                               | Guarantees                                                                  |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `organizations_slug_key`                                                                 | One tenant per slug                                                         |
| `clinics_organization_id_code_key`                                                       | One clinic code per organization                                            |
| `clinics_organization_id_id_key`                                                         | The composite parent key for clinics                                        |
| `organization_memberships_organization_id_id_key`                                        | The composite parent key for memberships                                    |
| `organization_memberships_organization_id_user_id_key`                                   | One membership per user per organization                                    |
| `clinic_memberships_membership_id_clinic_id_key`                                         | One scope row per membership and clinic                                     |
| `roles_organization_id_key_key` (`NULLS NOT DISTINCT`)                                   | One role key per organization, and one platform role per key                |
| `user_role_assignments_organization_id_user_id_role_id_clini_key` (`NULLS NOT DISTINCT`) | No duplicate grant, including a duplicate org-wide grant (`clinic_id NULL`) |
| `patients_organization_id_id_key`                                                        | The composite parent key for patients                                       |
| `patients_organization_id_clinic_id_mrn_key`                                             | One MRN per clinic                                                          |
| `patient_identifiers_organization_id_kind_value_key`                                     | One value per identifier kind                                               |
| `invitations_token_hash_key`                                                             | A token digest identifies one invitation                                    |

`NULLS NOT DISTINCT` is load-bearing twice: without it, two org-wide assignments of the same role
to the same person would both be allowed, because NULLs are distinct in a plain unique index.

### Check constraints (6)

| Constraint                              | Rule                                                |
| --------------------------------------- | --------------------------------------------------- |
| `organizations_slug_format_check`       | `^[a-z0-9]+(-[a-z0-9]+)*$` - no slash, no uppercase |
| `organizations_slug_length_check`       | 3–48 characters                                     |
| `organizations_name_length_check`       | 1–120 characters                                    |
| `organizations_status_check`            | `active`, `suspended`, `archived`                   |
| `clinics_name_length_check`             | 1–120 characters                                    |
| `organization_memberships_status_check` | `active`, `suspended`, `revoked`                    |

Time zones are **not** a CHECK: the valid list is `pg_timezone_names`, a view, and a CHECK may not
call a function that reads a table. `private.guard_timezone()` is a BEFORE trigger on
`organizations` and `clinics` instead, and requires a canonical IANA name or `UTC`/`GMT`.

### Tables with no foreign key, on purpose

`audit_logs` and `platform_settings` carry **no** foreign key at all, and
`tenant_creation_events` carries none either. A cascade would erase the audit trail when a tenant
or an actor is deleted; the ledger must survive the account that made it, because it is the
rate-limit evidence for tenant creation.

`tenant_sequences` has a primary key `(organization_id, sequence_key)` and one FK to
`organizations`. `authenticated` holds **SELECT only** and there are **zero policies**, so RLS
default-denies every read and write. Its only writer is `private.next_sequence_value(p_org_id,
p_sequence_key)`, a definer that checks `private.is_member` itself.

## Triggers (18)

| Table                      | Trigger                        | Timing                | Does                                                                                                                                   |
| -------------------------- | ------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`            | `organizations_guard_timezone` | BEFORE INSERT, UPDATE | Canonical IANA zone or `UTC`/`GMT`                                                                                                     |
| `organizations`            | `organizations_guard_status`   | BEFORE UPDATE         | Only a platform administrator, `service_role` or a superuser may change `status`; runs as INVOKER so `current_user` is the real caller |
| `organizations`            | `set_updated_at`               | BEFORE UPDATE         | `updated_at = now()`                                                                                                                   |
| `clinics`                  | `clinics_default_timezone`     | BEFORE INSERT         | Fills an omitted zone from the organization                                                                                            |
| `clinics`                  | `clinics_guard_timezone`       | BEFORE INSERT, UPDATE | Same canonical-zone rule                                                                                                               |
| `clinics`                  | `set_updated_at`               | BEFORE UPDATE         | `updated_at`                                                                                                                           |
| `organization_memberships` | `set_updated_at`               | BEFORE UPDATE         | `updated_at`                                                                                                                           |
| `patients`                 | `set_updated_at`               | BEFORE UPDATE         | `updated_at`                                                                                                                           |
| `profiles`                 | `guard_platform_admin`         | BEFORE UPDATE         | Refuses any `is_platform_admin` change from a client                                                                                   |
| `profiles`                 | `set_updated_at`               | BEFORE UPDATE         | `updated_at`                                                                                                                           |
| `roles`                    | `guard_role_delete_trigger`    | BEFORE DELETE         | Refuses a role still held or still carrying grants; returns early when the organization itself is gone, so a tenant delete cascades    |
| `roles`                    | `guard_role_identity_trigger`  | BEFORE UPDATE         | Freezes `organization_id`, `key` and `is_system`                                                                                       |
| `invitations`              | `guard_role_org_scope`         | BEFORE INSERT, UPDATE | The named role must belong to the invitation's organization                                                                            |
| `user_role_assignments`    | `guard_role_org_scope`         | BEFORE INSERT, UPDATE | Same rule for an assignment                                                                                                            |

`guard_role_delete` and `guard_role_identity` are **not** executable by `authenticated`: only the
trigger machinery calls them. `guard_role_org_scope` **is**, because a trigger on a table written
by the browser runs as the writing role.

## Indexes (36)

Every primary key and unique constraint has an index. The additional, hand-written ones:

| Index                                    | Serves                                                  |
| ---------------------------------------- | ------------------------------------------------------- |
| `audit_logs_org_created_idx`             | `(organization_id, created_at DESC)` - the audit page   |
| `organization_memberships_user_id_idx`   | Resolving a user's memberships on every request         |
| `invitations_organization_id_idx`        | The pending-invitation list                             |
| `patients_clinic_idx`                    | `(organization_id, clinic_id)` - the clinic-scoped read |
| `patient_identifiers_patient_idx`        | `(organization_id, patient_id)`                         |
| `tenant_creation_events_user_recent_idx` | `(user_id, created_at DESC)` - the creation cap         |

## Migration order

61 files, applied in filename order, one apply per Composio call. `00100`–`00520` establish
extensions, core functions, identity/tenancy and authorization; `00600`–`00820` add onboarding,
tenant data, audit/platform and the Task 8 hardening; `00900`–`01240` add RLS and its corrections;
`01300`–`01420` add storage; `01500` re-asserts the platform seed; `01600`–`01710` expose the
public RPC surface, timezone guards, authorization gaps and the tenant-deletion path; `01720`–
`01770` add invitations, the digest correction, the history-name fix, the ceiling
parameterisation, the invitation ceiling and currency/locale; `01780`–`01880` are the review
corrections, the platform-console functions, the measurement probe and restore, and the
`organizations_update` restoration.

An applied migration is never edited. Every correction is a new file whose version sorts after the
one it corrects. `scripts/apply-migration.ts --check` validates the names, the order and
non-emptiness; it applies nothing.

## Storage buckets

| Bucket                   | Public | Allowed MIME types                | Path                    |
| ------------------------ | ------ | --------------------------------- | ----------------------- |
| `patient-documents`      | false  | PDF, JPEG, PNG, DICOM, plain text | `<org>/<clinic>/<file>` |
| `clinical-attachments`   | false  | same                              | `<org>/<clinic>/<file>` |
| `investigation-reports`  | false  | same                              | `<org>/<clinic>/<file>` |
| `prescription-documents` | false  | same                              | `<org>/<clinic>/<file>` |
| `org-assets`             | false  | same                              | `<org>/<file>`          |

No bucket sets `file_size_limit`; the MIME allow-list is the only object-level restriction, and it
lives on the bucket row rather than in a policy. Tenancy is the object **name**, because a text
path cannot carry a foreign key - so the composite-key rule is satisfied here by policy, not by
constraint. `private.storage_path_is_safe` refuses a dot-dot segment and requires the first
segment to be a UUID. The four buckets share the same five MIME types; `public` is `false` on all
five, which is what makes a signed URL the only way to read an object.

`storage.objects` itself is owned by `supabase_storage_admin`, not `postgres`, and carries the 20
application policies listed in [`RLS_POLICIES.md`](RLS_POLICIES.md).
