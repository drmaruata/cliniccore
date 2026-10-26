# Testing - ClinicCore foundation

Four layers, one gate. `npm test` runs every Vitest file; Playwright is a separate command because
it needs a built server and browsers.

| Layer       | Path                 | Needs                                                                 | Runs in `npm test` |
| ----------- | -------------------- | --------------------------------------------------------------------- | ------------------ |
| Unit        | `tests/unit/`        | nothing external                                                      | yes                |
| Integration | `tests/integration/` | `TEST_DATABASE_URL`, a live Supabase project                          | yes, or skips      |
| Security    | `tests/security/`    | `TEST_DATABASE_URL`, a live project, the service-role key             | yes, or skips      |
| E2E         | `tests/e2e/`         | Playwright browsers, a live project, `npm run build && npm run start` | **no**             |

## Commands

```bash
npm test                                   # vitest run - all three Vitest layers
npm run test:unit                          # tests/unit only
npm run test:integration                   # tests/integration only
npx vitest run tests/unit/money.test.ts    # one file
npm run e2e                                # playwright test
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npm run e2e   # against a server you started
```

`npm run test:integration` still carries `--passWithNoTests`. `npm run e2e` does **not**: Task 15
removed that flag when it added the first real spec, so an empty spec set is a hard failure again.

MEASURED on 2026-10-26: `npm test` ran **39 files / 899 tests**, all passing, in 464.42 s.

## Vitest configuration

| Setting             | Value                               | Why                                                                                                                                                                              |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`       | `jsdom`                             | shadcn components must render. jsdom adds globals; it does not remove Node's                                                                                                     |
| `include`           | `tests/**/*.test.{ts,tsx}`          | A `*.test.ts`-only glob reports success while skipping every component test                                                                                                      |
| `passWithNoTests`   | `false`                             | An empty run is a failure                                                                                                                                                        |
| `fileParallelism`   | `false`                             | The security suite drops and loosens live policies; the DDL takes an `AccessExclusiveLock` that a concurrent catalogue reader can block on. Serial files remove the interference |
| `testTimeout`       | 15 s                                | The cost is round trips against a remote pooler, not parallel load                                                                                                               |
| `hookTimeout`       | 60 s                                | A fixture's exhausted rate-limit retry is ~28.5 s, and the hook - not the test - is the budget                                                                                   |
| `server-only` alias | `tests/helpers/server-only-stub.ts` | The real package throws on import outside a React Server Component bundler, which would make `lib/supabase/server.ts` untestable                                                 |

The alias is why a server module can be unit-tested at all. It does **not** weaken the production
boundary: the real package still throws in a client bundle.

## `TEST_DATABASE_URL` gating

`tests/integration/helpers/database.ts` owns the policy:

- **absent** → the database-backed suites **skip**, so a fork without the password gets a green
  `npm test`;
- **present but wrong** → they **fail loudly** (`ENOTFOUND`), because a silently skipping suite
  pointed at a typo is how coverage rots;
- **`CI=true` or `REQUIRE_TEST_DATABASE_URL=true`** → an absent URL is a **failure**, so CI cannot
  skip the catalogue unnoticed.

Use the **pooler** host, not `db.<ref>.supabase.co` (measured: the direct host does not resolve from
the development machine). The username is `postgres.<project-ref>`.

## Unit suites

No external service. Each file pins a rule that a later change could silently break.

| File                                                    | Pins                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `money.test.ts`                                         | `bigint` paise, formatting per locale, exact round-trip, no float arithmetic                            |
| `datetime.test.ts`                                      | `clinicDayBounds` walks day boundaries in every zone; DST, fall-back crossings, tiling                  |
| `permissions-registry.test.ts`                          | The 15 × 21 matrix, the owner/admin identity, `hasPermission` fails closed                              |
| `permissions-seed.test.ts`, `onboarding-seed.test.ts`   | The generated SQL matches the registry; the seed is deterministic                                       |
| `design-tokens.test.ts`                                 | Six brand colours, exact light round-trip, the bridge, contrast, compensating rules, no stray hex       |
| `cn.test.tsx`                                           | `cn` is the house module and `package.json` has no `cn` dependency                                      |
| `confirm-dialog-dom.test.tsx`                           | The shipped confirm button and its selectors                                                            |
| `shared-primitives.test.tsx`                            | Shared components render                                                                                |
| `payment-provider.test.ts`                              | The seam's file list, exports, refusal contract, no `process.env`, import whitelist, type pins          |
| `errors.test.ts`                                        | `AppError` subclasses, including `PaymentNotConfiguredError`'s 500 and code                             |
| `validation-auth.test.ts`                               | Auth and onboarding schemas, including the transform-then-validate email                                |
| `server-boundary.test.ts`                               | A `"use client"` file cannot import `lib/supabase/`; `server-only` is present                           |
| `check-no-secrets.test.ts`                              | The secret scanner itself, so a broken scanner fails a test                                             |
| `platform-console.test.ts`                              | The data layer refuses before the query for a non-operator, and returns null on a failed read           |
| `supabase-browser-client.test.ts`                       | The browser client's key and singleton behaviour                                                        |
| `auth-fixture-policy.test.ts`                           | The fixture's own residue rules                                                                         |
| `authorization-schema-sql.test.ts`                      | The rule lives in `can_for`; `can`, `is_member` and `clinic_ids` delegate; no duplicate membership rule |
| `public-rpc-sql.test.ts`                                | The public wrappers' signatures and grants                                                              |
| `tenancy-schema-sql.test.ts`, `tenant-data-sql.test.ts` | The migration source's schema invariants                                                                |
| `migration-manifest.test.ts`                            | Filenames, ordering, non-emptiness                                                                      |

Function-body assertions go through `latestDefinition`, which reads every migration in filename
order. Reading one file directly silently misses a later correction migration.

## Integration suites

These need `TEST_DATABASE_URL` because PostgREST cannot return `pg_proc`, `pg_policies`,
`pg_constraint` or `pg_index`. Behavioural assertions use `set local role authenticated` plus
`select set_config('request.jwt.claim.sub', $1, true)` inside a transaction, which reproduces the
principal PostgREST builds from a JWT; both are transaction-local, so `rollback` restores them.

| File                                                              | Pins                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tenancy-schema.test.ts`                                          | The 16 tables, RLS enabled, the policy catalogue, every migration named once in the history                                  |
| `tenant-data-schema.test.ts`                                      | Tenant-data columns, constraints and indexes                                                                                 |
| `authorization-gaps.test.ts`                                      | The closed escalation paths in the catalogue                                                                                 |
| `core-functions.test.ts`                                          | `private.can`, `is_member`, `clinic_ids`, `current_org_ids` behaviour                                                        |
| `onboarding-rpc.test.ts`                                          | `create_organization_with_owner` creates tenant, clinic, membership, owner assignment, 14 roles; currency and locale applied |
| `audit-log.test.ts`                                               | `write_audit` membership check, metadata rule, append-only behaviour                                                         |
| `active-org.test.ts`                                              | Cookie resolution, stale cookie, multi-org picker                                                                            |
| `auth-session.test.ts`                                            | Session refresh writes both copies                                                                                           |
| `auth-server-client.test.ts`, `auth-server-client-errors.test.ts` | `getUser`/`getClaims` shapes and error paths                                                                                 |
| `platform-seed.test.ts`                                           | The platform role and permission seed                                                                                        |
| `public-rpc.test.ts`                                              | The public RPCs over real HTTPS with a real JWT                                                                              |
| `public-rpc-privileges.test.ts`                                   | The withheld set and the untouched set; the policy-referenced inventory is derived from `pg_policies` in both directions     |
| `platform-console.test.ts`                                        | `tenant_directory` refuses a non-operator over HTTPS, with a seeded organization and an administrator positive control       |

## Security suites

### `rls-policies.test.ts`

- Enables RLS on every public table.
- Pins **exactly** the 39 public policies - name, command, non-null predicates, total.
- Keeps `tenant_sequences` closed and `audit_logs` append-only.
- Cross-tenant read assertions for every tenant-owned table.
- Isolates the `can` clause and the `clinic_ids` clause with separate users.
- Suspension cuts access but not restoration.
- Escalation refused on every path: platform role, platform permission, membership edits, settings
  writes, role deletion, role re-keying, cross-tenant clinic in an invitation, unreachable clinic.
- **Every refusal has an authorised positive control beside it.** A refusal-only suite cannot tell
  a refusing policy from a deleted one.
- The grant ceiling, the owner-only clause, the invitation ceiling, the address binding, the
  suspended-member non-spend, and the shell's "hidden membership" distinction.

### `storage-policies.test.ts`

Five buckets, all private; four policies each; path traversal refused; a read-only user cannot
upload or delete on a clinical bucket. DELETE tests set `storage.allow_delete_query`, because
`storage.protect_delete()` otherwise refuses the statement for every role and the test would measure
the trigger rather than the policy.

### `tenant-isolation.test.ts`

Two real tenants over real clients, then the mutation half. Two seeded accounts are never deleted by
the `afterAll`; deleting an auth user cascades its membership but **not** its organization, so a
blind sweep would orphan a tenant.

## The mutation harness

`tests/security/mutation-harness.ts` applies a break inside a transaction, then:

1. **applies** the mutation and proves it took;
2. **observes the assertion fail**, matching a `must break: /…/` regex. An unexpected break is
   rejected, so a network blip cannot be ledgered as "the policy was load-bearing";
3. **restores** the object and proves the restore **field for field** - not merely that the
   statement succeeded;
4. runs a **post-restore positive control**, so the restored policy is observed to pass.

Everything rolls back. **38 recorded mutations**, counted as 11 select drops, the patients leak, 10
update pairs, 6 delete pairs, 5 insert policies, the composite foreign key, the grant ceiling with
its trigger, the platform guard, the storage policy and the unique key. The suite pins the ledger at
38 and rejects an `applied` catalogue entry or an empty `mustBreak`.

**Update and DELETE under RLS pass the SELECT policy too.** An UPDATE's row scan carries the SELECT
policy's qual, so loosening `<table>_update` alone leaves a cross-tenant update filtered by
`<table>_select` - a drop-based mutation would not catch it. Write mutations loosen the SELECT
policy and the command policy together.

**The whole-catalogue read is the complement.** The harness proves each restore for the one policy it
touched; the ledger test then reads `pg_policies` on the outer session after every mutation has
rolled back and pins **59** policies (39 public + 20 storage). `permissions_select` is the one
shipped-permissive `USING true`; every other qual and check must not be `true`.

The mutation report is written to the OS temp directory by the mutation `afterAll`. A run that dies
before that point writes nothing; the in-suite ledger pin covers that case.

## Refusal shapes

Three shapes, three assertions. Getting them wrong produces false failures:

| Situation                         | What happens                               | How to assert                                    |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| RLS `USING` miss on UPDATE/DELETE | Statement **succeeds**, affects **0 rows** | Assert the returned rows and the unchanged value |
| Failed `WITH CHECK` or a trigger  | **Raises**                                 | `expectRejection` with the SQLSTATE or message   |
| Privilege revoked                 | **Permission denied**                      | `expectRejection` on `42501`                     |

An INSERT with no policy **raises**; an INSERT whose privilege is revoked **raises differently**;
a DELETE with no policy **filters**.

## E2E

Four specs, two browser projects (Chromium and Firefox). `playwright.config.ts` runs
`npm run build && npm run start`, not `dev`, so a build-time break cannot hide from E2E. Set
`PLAYWRIGHT_BASE_URL` to test an already-running server.

| Spec                    | Covers                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`          | Sign-up, sign-in, wrong password, sign-out, verification page, two generic reset responses                            |
| `onboarding.spec.ts`    | Onboarding, tenant creation, switchers, cross-tenant clinic refusal, sign-out                                         |
| `invitations.spec.ts`   | Invite, link display, acceptance, digest agreement, suspended-member non-spend                                        |
| `platform-gate.spec.ts` | Marketing shell is public and reads no session; `/platform` is 404 for a non-operator and a directory for an operator |

Accounts are created through the **admin API**, except the signup test itself, which goes through
the public endpoint exactly once, because the provider's signup rate limit is shared per project
(about 2–3 calls per window). Probe accounts are confirmed explicitly through the admin API; with
project-wide email confirmation disabled a signup address is implicitly confirmed, so this is
fixture setup, not proof of mailbox control.

`tests/helpers/e2e-cleanup.ts` deletes children before parents, deletes the audit rows and the
creation ledger (neither has a foreign key), then **re-counts** what it removed and throws if
anything survived. A cleanup that silently fails is worse than none.

## Environment hazards, measured

- **The database is live.** There is no reset between runs. A failed E2E run can leave an
  organization behind, and the cleanup then refuses to delete it if a late assignment re-uses a role
  - `guard_role_delete` is doing its job. Read the residual counts.
- **One identity per Composio call.** `set_config('request.jwt.claim.sub', …, true)` is
  transaction-local, so two identity probes batched into one call share a transaction and the last
  identity wins.
- **`pg` rejects multi-command strings whenever a query carries values.** A transaction must use one
  checked-out client; `pool.query` round-robins connections.
- **`resetRole()` returns to the session user**, which is `postgres` - `rolbypassrls = true`. A test
  that calls it before asserting measures the table owner.
- **Destroy order: `patient_identifiers` before `patients`.** The FK is ON DELETE RESTRICT.
- **A failed `beforeAll` never returns.** Clean up inside its catch and rethrow.
- **Parallel Vitest files once collided on a global organization name.** The suite now runs files
  serially, but a spec that asserts "no organization with this name exists" still depends on no
  neighbour using the same name.

## What remains unverified

- **PostgREST itself is not covered by `npm test`.** The HTTP behaviour was measured once, by hand,
  with three real users and real JWTs. It is recorded in `IMPLEMENTATION_STATUS.md`, not re-run as a
  gate.
- **No rate-limit, CORS, error-message-leakage or load testing.**
- **Password-reset delivery** is unverifiable here: no mailbox, and the hosted redirect allow-list is
  not configured.
- **Invitation email delivery** does not exist.
- **No accessibility audit** (axe or equivalent); `design-tokens.test.ts` measures colour only.
- **No migration-from-zero rehearsal in this task.** The history is 61 applied rows; a clean
  re-apply is a deployment drill, not a test.
- **No PostgREST or Supabase upgrade guard.** If the platform changes schema exposure, no test here
  would notice.
