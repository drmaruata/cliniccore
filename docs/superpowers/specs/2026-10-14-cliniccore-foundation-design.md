# ClinicCore — Foundation, Authentication & Multi-Tenancy (Phases 1–3)

**Date:** 2026-10-14
**Status:** Approved design, pending written review
**Supersedes:** nothing
**Covers:** Implementation Phases 1, 2 and 3 of the master ClinicCore brief

---

## 1. Context and goals

ClinicCore is a commercial multi-tenant SaaS clinic management platform. The master
brief enumerates ~14 functional modules, ~55 database tables, a public marketing
site, an authenticated application and a platform-administration console. That is a
multi-quarter build and cannot be produced as one coherent increment without
producing a large volume of shallow, unverified code.

This spec covers **Phases 1–3 only**, and deliberately stops at the point where the
product has a verified security foundation:

1. A production-quality Next.js project with TypeScript in strict mode.
2. The ClinicCore design system built on the six mandated brand colours.
3. Supabase Auth wired to that application using the current official SSR pattern.
4. A normalised, RLS-protected multi-tenant schema.
5. An automated tenant-isolation test suite that is **proven** to detect a
   violation, not merely asserted to pass.

The success criterion for this increment is not "the marketing site renders". It is:
**two real organizations exist, and user A provably cannot read or write user B's
records by any route, including direct API calls.**

## 2. Scope

### 2.1 In scope

- Project initialisation, tooling, linting, formatting, strict TypeScript.
- Design tokens, dark mode, and the shared UI component library.
- Public marketing shell (header, footer, landing page structure) — visual
  foundation only; marketing copy and page set are Phase 4.
- Authenticated application shell (sidebar, top bar, tenant switcher, page header).
- Supabase clients (browser / server / proxy), session refresh, route protection.
- Signup, login, logout, email verification, password reset.
- Organization and clinic onboarding (create organization, first clinic, owner
  membership).
- Staff invitation acceptance.
- Full tenancy schema with RLS on every tenant-owned table.
- Role and permission model with 15 seeded roles.
- Private storage buckets with tenant-scoped storage policies.
- Audit log foundation.
- Tenant-isolation test suite, mutation-verified.
- The 15 documentation artefacts listed in §9.

### 2.2 Explicitly out of scope for this increment

| Deferred | Phase | Reason |
|---|---|---|
| Patients, appointments, queue, encounters, vitals, prescriptions, lab | 5–6 | Needs a verified tenancy base first. |
| Billing, payments, refunds, inventory | 7 | Needs service catalogue and money model. |
| Subscription plans, entitlements, usage limits, tenant lifecycle | 8 | Razorpay sandbox integration lands here. |
| Reports, exports, notifications | 9 | Needs real operational data to report on. |
| Full marketing page set (features, pricing, security, legal, SEO) | 4 | Copy and design review needed. |
| Razorpay sandbox wiring (real API calls, HMAC webhook verification) | 8 | See §4.10. |

### 2.3 The one scope judgement worth defending

The brief's scope for this phase does not mention a `patients` table. It is
nonetheless included — **schema and RLS policy only, no UI** — reviewed and
confirmed.

Rationale: tenant isolation cannot be meaningfully proven against membership and
configuration tables alone. Those tables are small, structurally simple, and their
cross-tenant failure modes are shallow. The security property that actually matters
for this product is *"a clinician at Clinic A cannot read patient records belonging
to Clinic B"* — so the isolation suite must exercise a PHI-shaped record with
composite tenant foreign keys. Shipping the tenancy engine without a realistic
adversarial target would produce a green suite that proves very little.

## 3. Environment and infrastructure

| Item | Value |
|---|---|
| Supabase project | `cliniccore` |
| Project ref | `mhenxyuagaroufpqbrql` |
| Region | `ap-south-1` (Mumbai) |
| Postgres | 17.11 |
| Project state at spec time | `public` schema empty (0 tables), storage empty, `auth.users` empty |
| Toolchain | Node 24.16.0, npm 12.1.0, Supabase CLI 2.118.0, Docker 29.5.3 |
| Framework | Next.js 16.4.0 (App Router), React 19.3.0, TypeScript strict |
| Styling | Tailwind CSS 4.3.3 (CSS-first `@theme`), shadcn/ui |
| Data | `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.3 |
| Validation | Zod 4.6.7 |
| Testing | Vitest 5, Playwright |

### 3.1 Migration delivery

A Supabase Personal Access Token is **not** available. Migrations are therefore
applied through the Composio Supabase integration
(`SUPABASE_APPLY_A_MIGRATION`), which supports named, tracked, idempotent
migrations and exposes migration history for verification.

Rules that follow from this:

- Migrations remain the source of truth as SQL files in `supabase/migrations/`,
  version-controlled in git. Composio is the *applier*, not the *source*.
- Every migration carries a stable idempotency key derived from its filename.
- `supabase/config.toml` is still committed so a future PAT (or a local
  `supabase start`) can run the identical migrations.
- After applying, effect is verified by querying the catalogue — never by trusting
  the apply response body, which may return little structured data.
- `SUPABASE_APPLY_A_MIGRATION` rejects some `IF NOT EXISTS` policy DDL with
  SQLSTATE 42601. Policy and extension DDL must therefore use `DO $$ … $$`
  blocks guarded against `pg_catalog`, or plain `create … if not exists` where the
  server version supports it.

### 3.2 Version compatibility risk

`typescript@7` (the native Go compiler) is the current latest but is not yet a
settled pairing with Next.js 16. Resolution order:

1. Install `typescript@7`, run `tsc --noEmit` against a representative slice.
2. If the toolchain produces spurious or missing diagnostics, pin to the latest
   `typescript@5.x` and record the reason in `docs/IMPLEMENTATION_STATUS.md`.

Resolution is measured, not assumed.

## 4. Architecture

### 4.1 Route topology

Route groups keep three experiences in one codebase with clean URLs and no
duplicated business logic.

```
app/
  (marketing)/           → /, /features, /pricing, …   (Phase 4 content)
  (auth)/                → /login, /signup, /verify, /forgot-password, /reset-password
  app/                    → /app/…                       authenticated application
  platform/               → /platform/…                  ClinicCore operator console
  api/                   → route handlers only where a webhook or external caller needs one
  proxy.ts               → session refresh + coarse route gating
```

Route groups are pathless, so the two groups whose urls sit at the root - `(marketing)`
and `(auth)` - add no segment. The other two are REAL segments: `app/` and `platform/`.
The parenthesised names in the table above were shorthand for "this subtree serves this
url prefix", and read literally they are wrong: a pathless `(platform)/page.tsx` would
serve `/` and collide with the marketing root page. Task 16 implemented the urls this
table specifies, so the tree says `app/` and `platform/`.
Layouts in each
group own their own shell.

### 4.2 Tenancy model

`organizations` is the tenant root.

- Every tenant-owned table carries `organization_id uuid not null`.
- Clinical tables additionally carry `clinic_id uuid not null`.
- A user may belong to many organizations; membership is many-to-many.
- A membership may be scoped to a subset of clinics, or all clinics.

**Active tenant resolution.** The active organization id is held in the HTTP-only
cookie `cc_active_org`, written only by a server action that has already verified a
real `organization_memberships` row. Every server request re-derives the active
organization from that cookie and re-validates membership.

An organization id arriving in a URL segment, form field, or request body is
**never** authoritative. It is honoured only when it matches the cookie *and* a live
membership exists. Editing a URL therefore changes nothing about authorisation.

The switcher lists only organizations the user actually belongs to, so "first
membership" is never assumed.

### 4.3 Cross-tenant referential integrity

Postgres has no RLS-aware foreign keys. RLS restricts which rows a statement may
*read*; it does not prevent a permitted `INSERT` from referencing a row belonging to
another tenant. This is a real hole, and RLS policies alone cannot close it.

Structural mitigation, applied to every tenant-owned table. Illustrative pair —
`patients` and `appointments` are used here to show the shape; `appointments`
itself arrives in Phase 5:

```sql
-- parent
create table public.patients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  ...
  constraint patients_org_id_id_key unique (organization_id, id)
);

-- child: tenant carried into the foreign key itself
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  patient_id uuid not null,
  ...
  constraint appointments_patient_fkey
    foreign key (organization_id, patient_id)
    references public.patients (organization_id, id) on delete restrict
);
```

A cross-tenant reference becomes physically unrepresentable. RLS and composite
constraints each close a hole the other leaves open; neither is treated as
sufficient alone.

### 4.4 Authorisation funnel

Exactly one security-definer function is the authorisation primitive. RLS policies
call it and nothing else:

```sql
private.can(p_org_id uuid, p_permission text, p_clinic_id uuid default null)
  returns boolean
```

Resolution path: `user_role_assignments` → `roles` → `role_permissions` →
`permissions.key`. Passing `p_clinic_id` restricts the check to clinic-scoped
assignments; `null` means "any clinic in the organization".

Companions, same security posture: `private.is_member(org)`,
`private.clinic_ids(org)`, `private.is_platform_admin()`.

Hardening rules applied to every one of them:

- `security definer`, owned by `postgres` (which holds `bypassrls`).
- `stable`, so the planner evaluates once per query.
- `set search_path = ''`, with every internal reference schema-qualified.
- `revoke execute … from public`, then `grant execute … to authenticated` only.
- Created in a `private` schema that is not exposed through PostgREST, so their
  results cannot be harvested by an anonymous caller.

**Why this shape.** Two tables whose policies each read the other never resolve —
Postgres raises `42P17 infinite recursion detected in policy` and the query fails
for every role the policies apply to. A `security definer` function reads the
membership table as its owner, so the second policy never runs and the cycle is
broken. Owner must hold `bypassrls`, otherwise the function re-enters the policy and
the recursion returns.

Policy calls are wrapped — `(select private.can(...))` — so a fixed-value-per-query
function is evaluated once rather than per row.

### 4.5 Permission model

Permissions are `resource.action` strings: `patients.read`, `appointments.manage`,
`encounters.write`, `billing.manage`, `staff.manage`, `audit.read`, and so on.

The role × permission matrix is defined **once**, in TypeScript
(`lib/permissions/registry.ts`), and seeded into Postgres by a migration that
inlines the generated SQL. A hand-maintained copy in SQL and a second copy in the UI
would drift; this makes divergence structurally impossible.

15 roles seed the initial matrix, spanning platform, organization, clinic,
clinical and operational levels:

`platform_super_admin`, `organization_owner`, `organization_admin`,
`clinic_admin`, `medical_director`, `doctor`, `nurse`, `receptionist`,
`clinical_assistant`, `pharmacist`, `lab_technician`, `billing_officer`,
`accountant`, `inventory_manager`, `auditor`.

Authorization is enforced at three layers: UI (hide what cannot be used), server
(reject what must not be), database (RLS, the authority). The database decides.

### 4.6 Platform administration separation

`profiles.is_platform_admin` is not writable through any client-facing path.

- A trigger rejects any `UPDATE` that changes the column unless `current_setting`
  shows the statement came from the service role.
- The `/platform` segment re-checks it server-side on every request.
- A clinic owner editing their own profile row gains nothing.

### 4.7 Authentication

Current official pattern, verified against Supabase documentation rather than
recalled:

- **`proxy.ts`** — Next.js 16 renamed `middleware.ts` to `proxy.ts` and the export
  from `middleware` to `proxy`. It runs on the Node.js runtime; the edge runtime is
  not supported in `proxy`.
- `updateSession()` calls **`supabase.auth.getClaims()`**, not `getUser()`, to
  validate the JWT. Omitting it causes random logouts under SSR.
- `setAll` writes cookies to **both** the request and the response. This is the
  documented invariant; violating it desynchronises the browser and server and
  terminates sessions.
- Clients live in `lib/supabase/{client,server,proxy}.ts` using
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (new Supabase key naming), with a fallback
  to the legacy anon key.

Auth endpoints: signup, login, logout, password reset, and email verification.

**Email confirmation is disabled in the Supabase project** (configured by the
operator), so a new test user reaches the application without confirming an address.
Consequences that must be honoured rather than assumed away:

- Signup proceeds directly to organization onboarding. No "check your inbox"
  interstitial, because none would ever fire.
- The verify-email route must not be a dead page. It handles the already-signed-in
  case gracefully and explains that confirmation is disabled for this environment.
  It is **not** claimed as verified behaviour in this configuration.
- Password reset still depends on Supabase's outbound email. If no custom SMTP is
  configured, delivery falls back to Supabase's built-in service, which is heavily
  rate-limited on the free tier. Reset is therefore **implemented but unverified**
  until demonstrated, and recorded as such.

**Production blocker.** Disabling email confirmation is acceptable for a test
environment and is not acceptable for production: it removes the control that stops
unverified or throwaway accounts from registering. Re-enabling it is a mandatory
pre-launch step, recorded in `docs/DEPLOYMENT.md` and `docs/IMPLEMENTATION_STATUS.md`.

OAuth is wired structurally but stays inert and **unclaimed as functional** until a
provider is configured.

### 4.8 Storage

Private buckets only, created by migration:

`patient-documents`, `clinical-attachments`, `investigation-reports`,
`org-assets`, `prescription-documents`.

Object paths are prefixed by organization id (`{org_id}/{clinic_id}/…`) so storage
policies can enforce tenancy from the path itself. Uploads are validated for type
and size server-side; downloads use short-lived signed URLs. No patient document is
ever public.

### 4.9 Money

`bigint` minor units (paise for INR). No floating-point arithmetic anywhere in the
financial path. Foundation-level type and helper only this phase; the invoicing
engine is Phase 7.

### 4.10 Payment provider: seam now, sandbox in Phase 8

Two distinct things, easily confused:

- **Provider seam** — a `PaymentProvider` interface (createCheckout, verifyWebhook,
  refund) plus an unconfigured stub that throws on every call. No HTTP request ever
  leaves the server. Subscription state logic is written and unit-tested against a
  fake. Swapping providers later is a one-file change. Nothing about billing can be
  claimed as functional.
- **Sandbox wiring** — that same interface implemented against Razorpay's real test
  servers using `rzp_test_…` keys, with HMAC webhook signature verification,
  idempotency-key storage against replayed deliveries, and test cards driving the
  full flow.

This increment builds **the seam only**.

The argument against pulling sandbox wiring forward is sequencing, not effort.
Working sandbox billing requires `subscription_plans`, `organization_subscriptions`
and `subscription_usage` to exist, plus the entitlement checks gating them and the
tenant-lifecycle policy for lapsed subscriptions. Building that chain now would ship
subscription lifecycle and entitlement enforcement *ahead of* the clinical
foundation behind them — and Phases 5 and 6 will stress the tenancy model, which
would force the entitlement layer to be reworked afterwards.

There is a second, quieter reason. Webhook verification is security-sensitive code
that deserves its own focused pass with adversarial tests: forged signature, replayed
delivery, out-of-order event, duplicate idempotency key. Bundling it into the same
batch as the RLS policies would reduce the scrutiny applied to exactly the code where
a subtle bug silently grants free access.

Two honest consequences:

- With only a seam, onboarding **must not** present a payment step. Where the chosen
  plan supports a trial, onboarding continues straight to clinic setup.
- Razorpay cannot be verified in either form until test keys are supplied. Until
  then it is recorded as **BLOCKED**, never as complete.

## 5. Schema outline (Phase 3)

Tenancy and identity:

- `profiles` — mirrors `auth.users`; display name, `is_platform_admin`, timestamps.
- `organizations` — name, slug, timezone, locale, currency, status, settings.
- `organization_memberships` — `organization_id`, `user_id`, status, joined_at.
  Unique per `(organization_id, user_id)`.
- `clinics` — `organization_id`, name, code, address, operating hours.
- `clinic_memberships` — which clinics a membership is scoped to.
- `invitations` — token hash, email, role, expiry, accepted_at. Never stores a raw
  token.
- `tenant_sequences` — per-tenant counter allocation (MRN, invoice numbers), with a
  secure allocation function.

Authorisation:

- `permissions` — `key` primary key, description.
- `roles` — organization-scoped or platform-scoped, `is_system` flag.
- `role_permissions` — role → permission.
- `user_role_assignments` — `organization_id`, optional `clinic_id`, `user_id`,
  `role_id`.

Platform and audit:

- `platform_settings` — key/value, platform-admin only.
- `audit_logs` — `organization_id`, `actor_user_id`, action, resource, resource_id,
  metadata. Append-only; no update or delete policy for authenticated users.

Isolation target (schema + RLS only, per §2.3):

- `patients` — demographics, MRN, soft-archive flag.
- `patient_identifiers` — tenant-scoped MRN with per-tenant uniqueness.

Every table gets UUID primary keys, `created_at`/`updated_at` with a reliable
`updated_at` trigger, composite indexes prefixed on `organization_id`, UTC storage,
and archival instead of indiscriminate deletion.

## 6. Design system

Tailwind v4 CSS-first configuration. The six mandated brand colours are converted to
OKLCH and declared in `@theme inline`, then mapped onto shadcn/ui's semantic
variables.

| Token | Hex | Role |
|---|---|---|
| `--brand-primary` | `#05ab29` | Primary actions, positive progress |
| `--brand-secondary` | `#066fc4` | Secondary actions, links, nav highlight |
| `--brand-destructive` | `#bf140b` | Destructive actions, critical alerts |
| `--brand-neutral` | `#b5bdbb` | Borders, muted surfaces |
| `--brand-success` | `#35a677` | Success states, completed workflows |
| `--brand-navy` | `#172099` | Headings, emphasis, deep navigation |

Restraint is explicit: red is destructive-only and never decorative; navy carries
typography and emphasis rather than large fills; neutral backgrounds support the
palette. Dark mode is class-based with explicit `color-scheme` so native controls
match. No shadcn component hardcodes a hex — all consume tokens.

## 7. Error handling and logging

- Zod validates every external boundary; server actions and route handlers reject
  unparsed input outright.
- A typed `AppError` hierarchy maps to safe HTTP responses. Internal messages,
  stack traces and SQL are never returned to the client.
- Logs exclude passwords, tokens, session data, and clinical payloads. Audit rows
  record *that* a patient record was accessed, never its contents.
- Every critical form surface handles loading, empty, success and failure states.

## 8. Testing strategy

### 8.1 Layers

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | Permission logic, Zod schemas, money helpers, formatting |
| Integration | Vitest + hosted Supabase | RLS behaviour, constraints, auth flows |
| Security | Vitest | Cross-tenant isolation, privilege escalation |
| E2E | Playwright | Signup → onboarding → tenant switch → logout |

### 8.2 Two-organization isolation tests

Real, separately-created organizations. Tenant A's user and Tenant B's user each get
their own Supabase client carrying only their own JWT — never one shared admin
account.

Asserted for every tenant-owned table:

1. A selects **zero** rows from B.
2. A selects B's row by primary key → nothing returned.
3. A's `UPDATE` against B's row → zero rows affected.
4. A's `DELETE` against B's row → zero rows affected.
5. A's `INSERT` referencing B's id → rejected by composite FK.
6. A cannot grant itself a role it does not hold.
7. A cannot reach `/platform`.
8. A cannot read B's storage objects.

### 8.3 Mutation verification — the rule that makes the suite mean something

A green suite can pass for the wrong reason. Every isolation test must therefore be
shown capable of failing, through a strictly ordered loop:

1. Apply the mutation (drop the policy, narrow the constraint).
2. **Verify the mutation actually applied** by querying the catalogue. A silently
   failed mutation is indistinguishable from a passing test and is the single most
   dangerous outcome of this procedure.
3. Run the corresponding test; assert it **fails**.
4. Restore, and assert it passes again.

Three failure modes this ordering exists to prevent, all encountered previously:

- Reverting before the test runs, so the assertion checks the unmutated system and
  passes for free.
- The mutation silently failing to apply, so a green result is read as "the test
  cannot catch this" when the truth is "the mutation never happened".
- A mutation that applies but the test still passes because the test cannot actually
  reach the mutated path — typically because it exercises one tenant twice, where a
  *global* constraint would also reject the legitimate case.

A test that has not been demonstrated to fail is not evidence of anything and will
not be reported as passing.

Mutation is applied to the **migrations**, not to runtime code — mutating application
code proves nothing when the schema is the thing under test.

Related discipline carried over from earlier work: uniqueness tests must assert both
the *rejection* case and the *legitimate cross-tenant* case. A test that creates a
duplicate key twice and expects failure will still pass if the constraint was
narrowed to the wrong column, thereby making a legitimate case impossible.

### 8.4 Gates

Run and recorded for every batch: `tsc --noEmit`, ESLint, Vitest, `next build`,
Playwright where the environment supports it. Implementation failures are fixed, not
suppressed. Tests that cannot run for want of external credentials are documented as
BLOCKED with the reason — never reported as passing.

## 9. Documentation deliverables

`README.md`, `AGENTS.md`, `.env.example`, and under `docs/`: `PRD.md`, `SRS.md`,
`ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `RLS_POLICIES.md`, `SECURITY.md`,
`DESIGN_SYSTEM.md`, `ROUTES_AND_PERMISSIONS.md`, `TESTING.md`, `DEPLOYMENT.md`,
`OPERATIONS.md`, `IMPLEMENTATION_STATUS.md`.

`IMPLEMENTATION_STATUS.md` is the running ledger: completed work, verification
results with actual output, known defects, deferred items with reasons, and next
tasks. It is updated per batch, not written once at the end.

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Composio migration API rejects certain policy DDL (SQLSTATE 42601) | Migrations fail | Use `DO $$` guards against `pg_catalog`; verify each apply against the catalogue |
| `typescript@7` incompatibility with Next 16 | Build/type failures | Measure early; pin to 5.x with recorded justification |
| RLS policy recursion (`42P17`) | All queries fail for affected roles | All cross-table checks go through `private` security-definer helpers owned by `postgres` |
| Test suite passes for the wrong reason | False security confidence | §8.3 mutation verification is mandatory |
| Service-role key leaking to the browser | Full database compromise | Server-only module, no `NEXT_PUBLIC_` prefix, CI grep gate |
| Email verification needs SMTP the project lacks | Signup blocked | Confirmation is disabled for this environment; password reset remains dependent on Supabase's rate-limited built-in email and is marked unverified until demonstrated |
| Razorpay unavailable | Billing cannot be verified | Seam only this increment; recorded BLOCKED pending test keys (§4.10) |
| Marketing copy implies certifications or integrations | Unsupported claims | No such claims; testimonials omitted rather than fabricated |
| Email confirmation left disabled into production | Unverified-account abuse | Recorded as a mandatory pre-launch re-enable step (§4.7, `docs/DEPLOYMENT.md`) |

## 11. Acceptance criteria

This increment is done when **all** of the following hold:

1. `tsc --noEmit`, ESLint, Vitest and `next build` all pass on a clean run.
2. Migrations apply from zero against a clean database via Composio, verified by
   querying the catalogue.
3. Signup → organization creation → clinic creation → owner membership completes
   end to end, with no email-confirmation interstitial.
4. Login, logout, password reset, and protected-route redirect work. Password reset
   is reported as verified only if a reset message is demonstrably delivered;
   otherwise it is recorded as implemented-but-unverified.
5. A user belonging to two organizations can switch between them, and only to those.
6. All eight isolation assertions in §8.2 pass **and** each has been
   mutation-verified per §8.3.
7. `is_platform_admin` cannot be self-assigned by any client path.
8. Storage buckets exist, are private, and reject cross-tenant access.
9. Design tokens match §6; light and dark modes render; no component hardcodes a hex.
10. All 15 documentation artefacts exist and describe the actual implementation.
11. `docs/IMPLEMENTATION_STATUS.md` honestly records every BLOCKED item.

Explicit non-criterion: the product is **not** production-ready at the end of this
increment, and `IMPLEMENTATION_STATUS.md` must not imply otherwise.

## 12. Mapping to the master brief

| Brief phase | Covered here |
|---|---|
| 1 — Repository inspection and planning | §3, §11, `docs/IMPLEMENTATION_STATUS.md` |
| 2 — Foundation and design system | §4.1, §6, §9 |
| 3 — Supabase and security foundation | §4.2–4.8, §5, §8 |
| 4–10 | Not covered; see §2.2 |
