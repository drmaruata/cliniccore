# Software requirements - ClinicCore foundation

Status legend:

- **Implemented** - the code exists and a named test or measured command exercises it.
- **Implemented, unverified** - the code exists but the end-to-end behaviour could not be
  proved in this environment.
- **Blocked** - a required external dependency is absent; the gap is recorded, not hidden.

Every requirement below describes an obligation of Phases 1–3 and carries its true status;
requirements for unbuilt clinical modules are deliberately absent, and the out-of-scope list
names them.

## Authentication

| ID      | Requirement                                                                                                                                                            | Status                  | Evidence                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| AUTH-1  | A visitor can sign up with email, password and optional full name; the address is validated and the password is checked against a schema before the provider is called | Implemented             | `lib/validation/auth.ts`, `tests/unit/validation-auth.test.ts`, `tests/e2e/auth.spec.ts` |
| AUTH-2  | When the provider returns a session, signup continues to `/app/onboarding`; when it does not, the user is told confirmation is required rather than shown a dead page  | Implemented             | `app/(auth)/signup/actions.ts`                                                           |
| AUTH-3  | A user can sign in; a wrong password answers 401 with a message the user can act on, not a generic 500                                                                 | Implemented             | `app/(auth)/login/actions.ts`, `tests/e2e/auth.spec.ts`                                  |
| AUTH-4  | A user can sign out, and the session ends                                                                                                                              | Implemented             | `app/app/actions.ts`, `tests/e2e/onboarding.spec.ts`                                     |
| AUTH-5  | A request without a session to `/app/...` is redirected to `/login`                                                                                                    | Implemented             | `app/app/layout.tsx`, `proxy.ts`                                                         |
| AUTH-6  | The session is refreshed on every non-static request, and the refreshed cookie is written to both the request and the response                                         | Implemented             | `lib/supabase/proxy.ts`, `tests/integration/auth-session.test.ts`                        |
| AUTH-7  | `/verify` reports signed-in, signed-out and provider-unavailable states truthfully and explains that confirmation is disabled here                                     | Implemented             | `app/(auth)/verify/page.tsx`, `tests/e2e/auth.spec.ts`                                   |
| AUTH-8  | A password-reset request returns the same generic 200 for a known and an unknown address                                                                               | Implemented             | `app/(auth)/forgot-password/actions.ts`, `tests/e2e/auth.spec.ts` (two specs)            |
| AUTH-9  | The reset message redirects through `/api/auth/verify`, which exchanges the code and only redirects to an allow-listed `next`                                          | Implemented, unverified | `app/api/auth/verify/route.ts`; delivery not demonstrable without a mailbox              |
| AUTH-10 | A user with a recovery session can set a new password                                                                                                                  | Implemented, unverified | `app/(auth)/reset-password/actions.ts`; needs the mail in AUTH-9                         |

**Blocked:** password-reset **delivery**. The hosted project's redirect allow-list must include
`NEXT_PUBLIC_APP_URL`, and no mailbox was available to prove a message arrives. This is recorded
as unverified, never as working.

## Onboarding and tenants

| ID    | Requirement                                                                                                                                           | Status      | Evidence                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| ONB-1 | A user with no membership is offered the onboarding screen instead of the application shell                                                           | Implemented | `app/app/layout.tsx`, `tests/e2e/onboarding.spec.ts`                                 |
| ONB-2 | Creating an organization atomically creates the tenant, its first clinic, the caller's membership, the owner assignment and the fourteen tenant roles | Implemented | `private.create_organization_with_owner`, `tests/integration/onboarding-rpc.test.ts` |
| ONB-3 | The caller is limited to five organization creations in any 24-hour window, reported with SQLSTATE `53400`                                            | Implemented | `private.creation_cap_reached()`, migration `20261014001800`                         |
| ONB-4 | The slug is validated at the door and in the table; a slash or uppercase cannot become a route segment                                                | Implemented | `lib/validation/auth.ts`, `organizations_slug_format_check`                          |
| ONB-5 | A clinic's time zone is a canonical IANA name or `UTC`/`GMT`, filled from the organization when omitted                                               | Implemented | `private.guard_timezone`, `private.default_clinic_timezone`                          |
| ONB-6 | The tenant's currency and locale are validated and applied in the creation transaction                                                                | Implemented | `tests/integration/onboarding-rpc.test.ts`                                           |
| TEN-1 | The active organization is read from the `cc_active_org` cookie and **re-validated** against a live membership on every read                          | Implemented | `lib/auth/active-org.ts`, `tests/integration/active-org.test.ts`                     |
| TEN-2 | A stale cookie never falls back to another organization                                                                                               | Implemented | `active-org.test.ts`; `resolveActiveOrg` returns null                                |
| TEN-3 | A user in several organizations is asked to choose; a user in exactly one with no cookie resolves to it                                               | Implemented | `active-org.test.ts`, `tests/e2e/onboarding.spec.ts`                                 |
| TEN-4 | An organization id from a URL, form field or body is never authoritative                                                                              | Implemented | `lib/auth/active-org.ts`; no route reads an org id from the URL                      |
| TEN-5 | A member of a suspended tenant, or a suspended member, sees "your access is not active" rather than being offered a second organization               | Implemented | `public.has_any_membership()`, `tests/e2e/onboarding.spec.ts`                        |
| TEN-6 | The clinic switcher refuses a clinic outside the active organization                                                                                  | Implemented | `app/app/actions.ts`, `tests/e2e/onboarding.spec.ts`                                 |
| TEN-7 | An organization that holds roles can be deleted by a holder of `settings.manage`, and the cascade succeeds                                            | Implemented | `public.delete_organization`, `private.guard_role_delete` early return               |

## Invitations

| ID    | Requirement                                                                                                                                                                                                                                                           | Status      | Evidence                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| INV-1 | A holder of `staff.manage` can invite an address into a role they are allowed to grant                                                                                                                                                                                | Implemented | `app/app/settings/members/actions.ts`, `invitations_write`                                          |
| INV-2 | The database stores only a SHA-256 digest of the token; the raw token exists in the displayed link and the redemption request                                                                                                                                         | Implemented | `invitations.token_hash`, `tests/e2e/invitations.spec.ts`                                           |
| INV-3 | Only roles the caller may grant are offered and accepted; the ceiling is the subset rule plus owner-only for `organization_owner`                                                                                                                                     | Implemented | `public.grantable_roles`, `private.can_assign_role`, `tests/security/rls-policies.test.ts`          |
| INV-4 | An invitation expires after 7 days and can be redeemed once                                                                                                                                                                                                           | Implemented | `INVITATION_LIFETIME_DAYS`, `accept_invitation`                                                     |
| INV-5 | Redemption requires the acceptor's account address to equal the invitation's address, and fails closed when it cannot tell. The check is `email_confirmed_at is not null`; with project-wide confirmation disabled that binds the **stored** address, not the mailbox | Implemented | `private.accept_invitation`, migration `20261014001790`                                             |
| INV-6 | A suspended member's redemption is refused **without** spending the invitation                                                                                                                                                                                        | Implemented | `accept_invitation`; pinned in `rls-policies.test.ts`                                               |
| INV-7 | An invitation naming clinics is refused rather than over-granted. The refusal is at redemption, in `private.accept_invitation`; the INSERT/UPDATE policies instead require every named clinic to belong to the inviting organization                                  | Implemented | `private.accept_invitation`, migration `20261014001790`; `invitations_write` / `invitations_update` |
| INV-8 | An accepted invitation is immutable                                                                                                                                                                                                                                   | Implemented | `invitations_update` requires `accepted_at is null`                                                 |
| INV-9 | The invitation link is displayed for manual sharing; no email is sent                                                                                                                                                                                                 | **Blocked** | no mail provider is configured; the UI says so                                                      |

## Authorization and isolation

| ID     | Requirement                                                                                                                            | Status      | Evidence                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| RLS-1  | Every one of the 16 public tables has row-level security enabled                                                                       | Implemented | `tests/security/rls-policies.test.ts`                            |
| RLS-2  | The 39 public policies are exactly the expected set, with non-null row filters                                                         | Implemented | same file; catalogue read                                        |
| RLS-3  | A member of organization A reads zero of B's rows, in every tenant-owned table, and by primary key                                     | Implemented | `tests/security/tenant-isolation.test.ts`                        |
| RLS-4  | A cross-tenant UPDATE or DELETE touches zero rows                                                                                      | Implemented | same file                                                        |
| RLS-5  | A cross-tenant INSERT is refused by policy or by a composite foreign key                                                               | Implemented | same file                                                        |
| RLS-6  | Clinic-scoped access needs both the permission (`private.can`) and the reach (`private.clinic_ids`); one clause alone is a leak        | Implemented | `rls-policies.test.ts`, two isolating fixtures                   |
| RLS-7  | `private.can` refuses every `platform.`-prefixed permission, case-insensitively, and admits only roles of the organization asked about | Implemented | `private.can_for`; `tests/unit/authorization-schema-sql.test.ts` |
| RLS-8  | A grantor may not grant a role carrying a permission they do not hold, and only an owner may grant `organization_owner`                | Implemented | `private.can_assign_role`, `tests/security/rls-policies.test.ts` |
| RLS-9  | `profiles.is_platform_admin` cannot be changed by a client                                                                             | Implemented | `private.guard_platform_admin` trigger                           |
| RLS-10 | Each isolation assertion is mutation-verified: applied, proved applied, observed to fail, restored, observed to pass                   | Implemented | 38 recorded mutations, `tests/security/mutation-harness.ts`      |
| RLS-11 | The policy catalogue is pinned as a whole (59 policies: 39 public + 20 storage)                                                        | Implemented | `tenant-isolation.test.ts` ledger test                           |

## Storage

| ID    | Requirement                                                                                         | Status      | Evidence                                                   |
| ----- | --------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| STO-1 | Five buckets exist and none is public                                                               | Implemented | `tests/security/storage-policies.test.ts`                  |
| STO-2 | Each bucket has four policies, each demanding the declared permission                               | Implemented | same file                                                  |
| STO-3 | Tenancy comes from the object **name**: `<org>/<clinic>/<file>`, or `<org>/<file>` for `org-assets` | Implemented | `private.storage_org_id`, `private.storage_clinic_id`      |
| STO-4 | A path with a dot-dot segment, or an object whose first segment is not a UUID, is refused           | Implemented | `private.storage_path_is_safe`; `storage-policies.test.ts` |
| STO-5 | MIME types are restricted to PDF, JPEG, PNG, DICOM and plain text                                   | Implemented | `storage.buckets.allowed_mime_types`                       |
| STO-6 | A read-only user cannot upload or delete on a clinical bucket                                       | Implemented | `storage-policies.test.ts`                                 |

## Audit

| ID    | Requirement                                                                                                                                                                               | Status      | Evidence                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------- |
| AUD-1 | `audit_logs` is append-only for clients: INSERT, UPDATE and DELETE are revoked from `authenticated`                                                                                       | Implemented | `has_table_privilege` assertions in `tenant-isolation.test.ts` |
| AUD-2 | Every write to `audit_logs` goes through a security-definer function; `private.write_audit` checks membership itself, `private.write_storage_audit` records storage deletions without one | Implemented | `private.write_audit`; `private.write_storage_audit`           |
| AUD-3 | Metadata may carry identifiers and codes, not prose; a value with whitespace, or a free-text key, is refused                                                                              | Implemented | `private.audit_metadata_violation`                             |
| AUD-4 | `audit_logs` has no foreign keys, so deleting a tenant or an actor cannot erase the trail                                                                                                 | Implemented | catalogue: only `audit_logs_pkey`                              |
| AUD-5 | Audit rows can be read by a holder of `audit.read` in that organization, and by platform administrators for platform-level rows                                                           | Implemented | `audit_logs_select`                                            |

**Not claimed:** tamper-proofing. A database owner can alter audit rows; see `SECURITY.md`.

## Money and payments

| ID    | Requirement                                                                                               | Status      | Evidence                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| MON-1 | Money is `bigint` minor units (paise); no floating point in a money path                                  | Implemented | `lib/utils/money.ts`, `tests/unit/money.test.ts`                                |
| MON-2 | Formatting is correct for the locales tested, and parse/format round-trips exactly for the measured range | Implemented | `money.test.ts`                                                                 |
| MON-3 | A formatted value is display-only; arithmetic on it is not supported                                      | Implemented | documented in `money.ts`; no caller computes from it                            |
| PAY-1 | A payment-provider contract exists and every method of the unconfigured provider refuses                  | Implemented | `lib/billing/{provider,unconfigured}.ts`, `tests/unit/payment-provider.test.ts` |
| PAY-2 | There is no "test mode" that returns a fake successful payment, and adding one fails a test               | Implemented | file/export/import whitelists in `payment-provider.test.ts`                     |
| PAY-3 | Onboarding presents no payment step                                                                       | Implemented | `app/app/onboarding/` has no billing step                                       |
| PAY-4 | Razorpay sandbox wiring with HMAC webhook verification                                                    | **Blocked** | Phase 8; no test keys                                                           |

## Platform console

| ID    | Requirement                                                                                             | Status      | Evidence                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| PLT-1 | The platform predicate is asked of the database, not reimplemented in TypeScript                        | Implemented | `lib/auth/platform.ts` asks `public.is_platform_admin`                   |
| PLT-2 | A non-administrator receives **404**, and the data layer refuses to read the directory before the query | Implemented | `tests/unit/platform-console.test.ts`, `tests/e2e/platform-gate.spec.ts` |
| PLT-3 | The directory exposes exactly name, status and member count - no id, slug or clinical row               | Implemented | `public.tenant_directory()` signature                                    |
| PLT-4 | The member count is real for an operator who belongs to no tenant                                       | Implemented | `tests/integration/platform-console.test.ts`                             |

## Documentation and tooling

| ID     | Requirement                                                                                               | Status      | Evidence                                                                |
| ------ | --------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| DOC-1  | All 15 documentation artefacts exist and describe the actual implementation                               | Implemented | this directory, `README.md`, `AGENTS.md`, `.env.example`                |
| TOOL-1 | TypeScript is strict, with `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` | Implemented | `tsconfig.json`, `npm run typecheck`                                    |
| TOOL-2 | `npm run lint` is four gates: eslint, secret scan, format check, migration check                          | Implemented | `package.json`                                                          |
| TOOL-3 | A service-role key cannot reach a `"use client"` file                                                     | Implemented | `lib/supabase/server.ts` (`server-only`), `scripts/check-no-secrets.ts` |
| TOOL-4 | Migration files are validated for name, order and non-emptiness                                           | Implemented | `scripts/apply-migration.ts --check`                                    |

## Out of scope

No requirement is stated for patients, appointments, queue, encounters, vitals,
prescriptions, laboratory, billing, inventory, subscriptions, entitlements, reports, exports,
notifications, the full marketing site, OAuth, or any clinical UI. These belong to Phases 4–10
and are unbuilt. `patients` exists as schema and RLS only, so the isolation suite has a
PHI-shaped target.
