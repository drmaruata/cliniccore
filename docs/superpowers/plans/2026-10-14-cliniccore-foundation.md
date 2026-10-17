# ClinicCore Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js 16 application with the ClinicCore design system, Supabase Auth, and a multi-tenant Postgres schema whose row-level security is proven — not merely asserted — to block cross-tenant access.

**Architecture:** Three route groups (`(marketing)`, `(auth)`, `(app)`, plus `(platform)`) over one codebase. `organizations` is the tenant root; every tenant-owned row carries `organization_id`, and every tenant-owned foreign key is composite so a cross-tenant reference is physically unrepresentable. All RLS policies call exactly one security-definer function, `private.can(org, permission, clinic)`, which breaks the policy-recursion cycle by reading membership tables as `postgres` (which holds `bypassrls`).

**Tech Stack:** Next.js 16.4.0 (App Router), React 19.3.0, TypeScript strict, Tailwind CSS 4.3.3 (CSS-first `@theme`), shadcn/ui, `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.3, Zod 4.6.7, Vitest 5, Playwright. Postgres 17.11 via Supabase project `cliniccore` (ref `mhenxyuagaroufpqbrql`, ap-south-1).

**Spec:** `docs/superpowers/specs/2026-10-14-cliniccore-foundation-design.md`

## Global Constraints

- Migrations are applied **through the Composio MCP**, not `supabase db push` — no Supabase PAT is available. Use `SUPABASE_APPLY_A_MIGRATION` (`ref`, `name`, `query`, `idempotency_key`) so history is tracked; fall back to `SUPABASE_BETA_RUN_SQL_QUERY` only if the applier rejects `DO $$` blocks.
- SQL files in `supabase/migrations/` are the **source of truth**; Composio is the applier. Never edit the live database by undocumented means.
- After every apply, verify effect by querying `information_schema` / `pg_catalog` / `pg_policies`. **Never trust the apply response body** — it may return little structured data.
- `SUPABASE_APPLY_A_MIGRATION` can reject `IF NOT EXISTS` policy DDL with SQLSTATE 42601. Guard all policy and extension DDL with `DO $$ … $$` blocks against `pg_catalog`.
- Security-definer functions: `security definer`, owned by `postgres`, `stable`, `set search_path = ''`, every internal reference schema-qualified, `revoke execute … from public`, then `grant execute … to authenticated`.
- Every RLS policy call to a security-definer function is wrapped `(select …)` so the planner evaluates it once per query.
- **Platform admin does NOT grant `private.can`.** `private.is_platform_admin()` is a separate function used only by `/platform`. Platform operators can see tenant directory, subscription and usage — never patient records.
- Money is `bigint` minor units (paise). No floating-point arithmetic in any financial path.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is the env var name; fall back to `NEXT_PUBLIC_SUPABASE_ANON_KEY` if absent.
- Email confirmation is **disabled** in the Supabase project. Signup has no inbox interstitial. Re-enabling it before production is a recorded pre-launch blocker.
- Service-role key is `SUPABASE_SERVICE_ROLE_KEY`, server-only, never `NEXT_PUBLIC_`-prefixed, never imported by a `components/` or `app/` file.
- Money, clock and timezone: store UTC, render in the clinic's configured timezone.

## Review Focus

Five input classes the spec implies but no single task's happy-path tests exercise. Each line names an input, the expected behaviour, and the task that must pin it.

1. **Authenticated user with zero organization memberships** hitting `/app`. Expected: a real "create your organization" screen — not a crash, not a redirect loop, not a blank shell. → Task 17.
2. **Cookie naming an organization the user has since left** (membership revoked, cookie stale). Expected: fall back to a valid membership or the picker; never render tenant data, never 500. → Task 17.
3. **Duplicate organization slug** from two signups. Expected: unique-violation surfaces as a friendly inline form error, not a 500. → Task 17.
4. **Clinic timezone differing from the server's** — a record at `23:30 Asia/Kolkata` read on a UTC server. Expected: renders on the correct calendar day; no off-by-one. → Task 11.
5. **Service-role key imported into a Client Component.** Expected: a grep gate in `npm run lint` fails the build; no key in the browser bundle. → Task 2.

---

## File Structure

```
.env.example                         safe placeholders only
AGENTS.md                            persistent instructions for coding agents
README.md                            setup, commands, local development
proxy.ts                             session refresh + coarse route gating (Next 16; NOT middleware.ts)
app/
  globals.css                        @theme tokens, dark mode, base layer
  layout.tsx                         root layout, font, metadata
  (marketing)/layout.tsx             public header + footer
  (marketing)/page.tsx               landing page
  (auth)/layout.tsx                  centred auth card
  (auth)/login/page.tsx
  (auth)/signup/page.tsx
  (auth)/forgot-password/page.tsx
  (auth)/reset-password/page.tsx
  (auth)/verify/page.tsx             graceful when confirmation disabled
  (app)/layout.tsx                   sidebar + top bar; requires session + org
  (app)/dashboard/page.tsx           tenant-aware placeholder, real session/org data
  (app)/onboarding/page.tsx          zero-membership path (Review Focus 1)
  (app)/settings/members/page.tsx    memberships + role assignments
  (platform)/layout.tsx              platform-admin gate
  (platform)/page.tsx                tenant directory
components/
  ui/                                shadcn primitives (generated, unedited)
  shared/                            data-table, page-header, kpi-card, empty-state,
                                     status-badge, theme-toggle, confirm-dialog
  marketing/                         public-only sections
  app/                               sidebar-nav, org-switcher, clinic-switcher
lib/
  supabase/client.ts  server.ts  proxy.ts
  auth/session.ts  active-org.ts  permissions.ts
  permissions/registry.ts           single source of truth for role × permission
  billing/provider.ts                PaymentProvider seam only (no implementation)
  validation/                        Zod schemas
  errors.ts                          AppError hierarchy
  utils/                             cn, money, datetime, result
types/database.types.ts              generated — never hand-edited
supabase/migrations/*.sql            source of truth, applied via Composio
tests/
  integration/                       schema/constraint assertions — see the note below
  security/                          tenant isolation, mutation harness
  e2e/                               Playwright
scripts/
  apply-migration.ts                 validates migrations, emits a manifest; the agent applies via the MCP
  gen-types.ts                       calls MCP type generator
docs/*.md                            15 artefacts
```

**Note on `tests/integration/` and `tests/security/` — and on the per-task test steps.** The plan describes these suites as asserting against the real database. No database connection string or Supabase PAT exists in this project — migrations are applied agent-side through the Composio MCP, and vitest has no route to Postgres. So:

- Where an assertion can be made against the **migration text**, it becomes a runnable `tests/unit/*.test.ts` (precedent: `tests/unit/migration-manifest.test.ts`, `tests/unit/tenancy-schema-sql.test.ts`).
- Where it needs the **live database**, it is discharged as a **controller-run catalogue rehearsal**, recorded in the SDD ledger; no placeholder vitest file is committed in its place (a test that cannot reach its subject proves nothing).

**Note on `tests/integration/` and `tests/security/` — SUPERSEDED for catalogue assertions.** This plan originally specified that every DB-state assertion be discharged as a controller-run rehearsal, because no database connection existed. One now does: `TEST_DATABASE_URL` gives the integration suite a direct Postgres connection (`tests/integration/helpers/database.ts`), which is the only way to read `pg_proc`, `pg_policies`, `pg_constraint` and `pg_index` — PostgREST cannot return any of them. So:

- **Catalogue assertions** (`prosecdef`, `proconfig`, constraint arity, `nulls not distinct`, policy contents) are now **real tests** in `tests/integration/`, beginning with `tenancy-schema.test.ts`. With no `TEST_DATABASE_URL` they skip; when `CI=true` or `REQUIRE_TEST_DATABASE_URL=true` a missing URL **fails**, so they cannot rot silently in CI.
- **Behavioural assertions** (RLS isolation, the onboarding RPC, audit writes, as a real signed-in user) still cannot run: every table is deny-all until Task 9's policies, and the helpers live in `private`, whose PostgREST exposure is unresolved. These stay controller rehearsals until then.
- Migration-source invariants stay as runnable `tests/unit/*.test.ts`. Those guard the file rather than the applied database, which is why the post-apply `md5(prosrc)` comparison is recorded in each task's report.

**Note on reaching the `private` schema from the client — UNRESOLVED, settle before Task 12.** `authenticated` holds `USAGE` on `private` with EXECUTE granted per function, but `current_setting('pgrst.db_schemas')` is not readable from SQL, so whether PostgREST exposes `private` could not be measured. Supabase's default exposed set is `public, graphql_public`. If that default holds, none of these functions is callable from the browser and Task 12 needs `public` wrappers.

**Revisit at Task 18**, whose mutation-verified tenant-isolation harness is behavioural and now has a plausible path: a direct connection for the catalogue half, PostgREST with real user JWTs for the isolation half.

### Migrations (applied in this order)

| File | Contents |
|---|---|
| `20261014000100_extensions_and_schemas.sql` | `citext`, `pgcrypto`; `private` schema |
| `20261014000200_core_functions.sql` | `set_updated_at()`, `guard_platform_admin()` (invoker; see Task 5 Step 4); `current_org_ids()` moved to the end of `00300` |
| `20261014000300_identity_and_tenancy.sql` | `profiles`, `organizations`, `organization_memberships`, `clinics`, `clinic_memberships`, `invitations` |
| `20261014000400_authorization.sql` | `permissions`, `roles`, `role_permissions`, `user_role_assignments` + seed; also the default-ACL revoke of `TRUNCATE`/`REFERENCES`/`TRIGGER` that covers every later table |
| `20261014000500_authorization_functions.sql` | `private.is_member`, `private.is_platform_admin`, `private.clinic_ids`, `private.can` |
| `20261014000510_tenant_status_and_scope.sql` | makes `can` org-strict and refuse `platform.*` keys, and makes `current_org_ids` / `is_member` / `clinic_ids` honour `organizations.status` (Task 7 review) |
| `20261014000520_platform_key_case.sql` | `lower()`s the platform-key refusal in `can`, so a case-variant key cannot slip past (Task 7 review round 2) |
| `20261014000600_onboarding_rpc.sql` | `private.create_organization_with_owner` |
| `20261014000700_tenant_data.sql` | `patients`, `patient_identifiers`, `tenant_sequences` |
| `20261014000800_audit_and_platform.sql` | `audit_logs`, `platform_settings` |
| `20261014000900_rls_identity.sql` | RLS + policies for identity/tenancy tables |
| `20261014001000_rls_authorization.sql` | RLS + policies for authorization tables |
| `20261014001100_rls_tenant_data.sql` | RLS + policies for `patients`, `patient_identifiers` |
| `20261014001200_rls_audit_and_platform.sql` | RLS + policies for `audit_logs`, `platform_settings` |
| `20261014001300_storage.sql` | private buckets + storage policies |
| `20261014001400_invitations.sql` | `private.accept_invitation`, invitation helpers |

### Tenancy schema — columns

`profiles(id uuid pk → auth.users(id) on delete cascade, full_name text, is_platform_admin boolean not null default false, created_at, updated_at)`

`organizations(id uuid pk default gen_random_uuid(), name text not null, slug citext not null unique, timezone text not null default 'Asia/Kolkata', locale text not null default 'en-IN', currency char(3) not null default 'INR', status text not null default 'active' check in ('active','suspended','archived'), created_at, updated_at)`

`organization_memberships(id uuid pk, organization_id uuid not null → organizations(id) on delete cascade, user_id uuid not null → auth.users(id) on delete cascade, status text not null default 'active' check in ('active','suspended','revoked'), created_at, updated_at, unique (organization_id, user_id), unique (organization_id, id))`

`clinics(id uuid pk, organization_id uuid not null → organizations(id) on delete cascade, name text not null, code citext, timezone text, address jsonb, is_active boolean not null default true, created_at, updated_at, unique (organization_id, code), unique (organization_id, id))`

`clinic_memberships(id uuid pk, organization_id uuid not null, membership_id uuid not null, clinic_id uuid not null, created_at, unique (membership_id, clinic_id), FK (organization_id, membership_id) → organization_memberships(organization_id, id) on delete cascade, FK (organization_id, clinic_id) → clinics(organization_id, id) on delete cascade)`

`invitations(id uuid pk, organization_id uuid not null, email citext not null, role_id uuid not null, token_hash text not null unique, clinic_ids uuid[] not null default '{}', expires_at timestamptz not null, accepted_at timestamptz, invited_by uuid not null → auth.users(id), created_at)`

`permissions(key text pk, description text not null)`
`roles(id uuid pk, organization_id uuid → organizations(id) on delete cascade null, key text not null, name text not null, is_system boolean not null default false, created_at, unique nulls not distinct (organization_id, key))` — `organization_id IS NULL` denotes a platform role. `nulls not distinct` is load-bearing: a plain unique index treats NULLs as distinct, so `on conflict (organization_id, key) do update` never fires for the platform row and re-seeding duplicates it (measured on PostgreSQL 17.11).
`role_permissions(role_id uuid → roles(id) on delete cascade, permission_key text → permissions(key) on delete cascade, pk (role_id, permission_key))`
`user_role_assignments(id uuid pk, organization_id uuid not null, user_id uuid not null → auth.users(id) on delete cascade, role_id uuid not null → roles(id), clinic_id uuid null, created_at, unique (organization_id, user_id, role_id, clinic_id))`

`patients(id uuid pk, organization_id uuid not null, clinic_id uuid not null, mrn text not null, first_name, last_name, date_of_birth date, sex text, phone text, email citext, address jsonb, is_archived boolean not null default false, archived_at timestamptz, created_at, updated_at, unique (organization_id, id), unique (organization_id, clinic_id, mrn))`
`patient_identifiers(id uuid pk, organization_id uuid not null, patient_id uuid not null, kind text not null, value text not null, created_at, unique (organization_id, kind, value), FK (organization_id, patient_id) → patients(organization_id, id) on delete restrict)`
`tenant_sequences(organization_id uuid not null, sequence_key text not null, next_value bigint not null default 1, updated_at, pk (organization_id, sequence_key))`

`audit_logs(id bigserial pk, organization_id uuid null, actor_user_id uuid null, action text not null, resource_type text not null, resource_id uuid null, metadata jsonb not null default '{}', created_at timestamptz not null default now())`
`platform_settings(key text pk, value jsonb not null, updated_at, updated_by uuid)`

---

### Task 1: Project scaffold and toolchain gates

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `.prettierrc`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `.env.example`
- Create: `lib/utils/cn.ts` → `cn(...inputs: ClassValue[]): string`
- Create: `scripts/check-no-secrets.ts`
- Create: `app/globals.css`, `app/layout.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: npm scripts `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `e2e`; `.env.example`; the `cn` helper used by every component task.

- [ ] **Step 1: Initialise the project with pinned versions**

  Scaffold manually (not `create-next-app`) so versions are explicit. Deps: `next@16.4.0`, `react@19.3.0`, `react-dom@19.3.0`, `typescript@latest` (pinned per Step 5), `tailwindcss@4.3.3`, `@tailwindcss/postcss`, `@supabase/ssr@0.12.7`, `@supabase/supabase-js@2.117.3`, `zod@4.6.7`, `vitest@5`, `@playwright/test`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`, `server-only`.

- [ ] **Step 2: Configure `tsconfig.json` in strict mode**

  `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"exactOptionalPropertyTypes": false` (documented as a deliberate exception — `exactOptionalPropertyTypes` fights third-party prop types), `moduleResolution: "bundler"`, `paths: { "@/*": ["./*"] }`.

- [ ] **Step 3: Write `.env.example` with safe placeholders only**

  ```
  NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
  NEXT_PUBLIC_SUPABASE_ANON_KEY=
  SUPABASE_SERVICE_ROLE_KEY=sb_secret_replace_me
  SUPABASE_PROJECT_REF=your_project_ref
  NEXT_PUBLIC_APP_URL=http://localhost:3000
  ```

  Confirm `grep -r "eyJ\|service_role\|sb_secret" --include=".env*" .` matches only `.env.example`.

- [ ] **Step 4: Write the secret-leak gate script and wire it into `lint`**

  `scripts/check-no-secrets.ts` walks `app/`, `components/`, `lib/` and fails if `SUPABASE_SERVICE_ROLE_KEY` is referenced outside `lib/supabase/server.ts` and `tests/`, or if any client-marked file (`"use client"`) references it. Export as `npm run check:secrets`; `lint` runs it.

  *(Review Focus 5)* Test: `tests/unit/check-no-secrets.test.ts` — `expect(check(["app/page.tsx", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY"])).toBe(false)` and `expect(check(["lib/supabase/server.ts", "process.env.SUPABASE_SERVICE_ROLE_KEY"])).toBe(true)`.

- [ ] **Step 5: Resolve the TypeScript version by measurement, not assumption**

  Install `typescript@7` (current latest, native Go compiler). Run `npm run typecheck`. If diagnostics are spurious or absent, pin `typescript@^5.9` and record the measured reason in `docs/IMPLEMENTATION_STATUS.md`. Do not proceed on an unverified assumption either way.

- [ ] **Step 6: Verify the gates all run**

  Run: `npm run typecheck && npm run lint && npm run build`
  Expected: all exit 0 on an empty-but-valid app.

- [ ] **Step 7: Commit**

  ```bash
  git add -A && git commit -m "chore: scaffold Next.js 16 project with strict TS, Tailwind v4, Vitest, Playwright"
  ```

### Task 2: ClinicCore design system

**Files:**
- Create: `app/globals.css`, `lib/utils/cn.ts` (if not in Task 1)
- Test: `tests/unit/design-tokens.test.ts`

**Interfaces:**
- Consumes: `cn` from Task 1
- Produces: CSS custom properties `--brand-primary|secondary|destructive|neutral|success|navy`, and shadcn semantic vars `--background|--foreground|--card|--popover|--primary|--primary-foreground|--secondary|--destructive|--destructive-foreground|--muted|--muted-foreground|--accent|--accent-foreground|--border|--input|--ring|--success|--success-foreground` for `:root` and `.dark`.

- [ ] **Step 1: Write the failing token test**

  Read `app/globals.css` and assert each of the six brand variables is defined in both `:root` and `.dark`, that `.dark` exists, that `color-scheme` is set in both blocks, and that no hex literal appears outside the `:root`/`.dark` token declarations.

- [ ] **Step 2: Run it to verify it fails**

  Run: `npx vitest run tests/unit/design-tokens.test.ts`
  Expected: FAIL — `globals.css` has no tokens yet.

- [ ] **Step 3: Implement the token layer in `app/globals.css`**

  Tailwind v4 CSS-first. `@import "tailwindcss";` then `@theme inline` mapping each brand colour to `--color-brand-*`, plus the semantic vars above. Convert the six hexes to OKLCH:
  `#05ab29` primary, `#066fc4` secondary, `#bf140b` destructive, `#b5bdbb` neutral, `#35a677` success, `#172099` navy.
  Dark mode via `.dark` class with explicit `color-scheme: dark` (and `light` on `:root`) so native scrollbars and inputs match.

  Constraint: navy carries typography/emphasis, not large fills; destructive is used only for destructive actions; neutral backgrounds support the palette.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run tests/unit/design-tokens.test.ts`
  Expected: PASS.

- [ ] **Step 5: Add the shared UI primitives**

  `components/shared/{page-header,data-table,empty-state,status-badge,kpi-card,confirm-dialog,skeleton}.tsx`, built on shadcn `ui/` components which are consumed unmodified. Every colour reference goes through a token; no component hardcodes a hex.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: add ClinicCore design tokens and shared UI primitives"
  ```

### Task 3: Permission registry — single source of truth

**Files:**
- Create: `lib/permissions/registry.ts`, `scripts/gen-permissions-sql.ts`
- Test: `tests/unit/permissions-registry.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type PermissionKey = \`${string}.${string}\``
  - `type RoleKey = 'platform_super_admin' | 'organization_owner' | … | 'auditor'` (15 values)
  - `PERMISSIONS: readonly { key: PermissionKey; description: string }[]`
  - `ROLES: readonly { key: RoleKey; name: string; isPlatform: boolean; permissions: readonly PermissionKey[] }[]`
  - `defaultPermissionsFor(roleKey: RoleKey): readonly PermissionKey[]`
  - `hasPermission(roles: readonly RoleKey[], permission: PermissionKey): boolean`

- [ ] **Step 1: Write the failing test**

  Assert: every `key` in `PERMISSIONS` matches `/^[a-z_]+\.[a-z_]+$/`; no duplicates; every `permission` referenced in `ROLES` exists in `PERMISSIONS`; all 15 role keys present; `organization_owner` holds `staff.manage`, `settings.manage`, `billing.manage`; `auditor` holds `audit.read` but **not** `patients.update`; `hasPermission(['auditor'], 'audit.read')` is true and `hasPermission(['auditor'], 'patients.update')` is false.

- [ ] **Step 2: Run it to verify it fails**

  Run: `npx vitest run tests/unit/permissions-registry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/permissions/registry.ts`**

  Define permissions covering the brief's resource set: `patients.{read,create,update,export}`, `appointments.manage`, `encounters.{read,write}`, `prescriptions.create`, `investigations.{order,verify}`, `billing.manage`, `inventory.manage`, `staff.manage`, `reports.view`, `settings.manage`, `subscription.manage`, `audit.read`.

  Fifteen roles: `platform_super_admin`, `organization_owner`, `organization_admin`, `clinic_admin`, `medical_director`, `doctor`, `nurse`, `receptionist`, `clinical_assistant`, `pharmacist`, `lab_technician`, `billing_officer`, `accountant`, `inventory_manager`, `auditor`.

  Matrix decisions: `organization_owner` and `organization_admin` hold everything except `platform.*`; `auditor` is read-only plus `audit.read`; `lab_technician` holds `investigations.verify` but not `prescriptions.create`; `pharmacist` holds `inventory.manage` but not `prescriptions.create`.

- [ ] **Step 4: Implement `scripts/gen-permissions-sql.ts`**

  Emits idempotent SQL: `insert into public.permissions (key, description) values … on conflict (key) do update set description = excluded.description;` plus platform roles (`organization_id null`) and their `role_permissions`. **Organization-scoped roles are seeded per organization at onboarding**, not globally.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `npx vitest run tests/unit/permissions-registry.test.ts` → PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: define permission registry as single source of truth for role matrix"
  ```

### Task 4: Migration delivery harness

**Files:**
- Create: `scripts/apply-migration.ts`, `supabase/config.toml`, `.env.local` (gitignored, operator-populated)
- Test: `tests/unit/migration-manifest.test.ts`

> **Ruling (Task 9): the planned `tests/integration/migration-applier.test.ts` is CLOSED as obsolete and will not be written.** Its premise was that a Node script applies migrations. It does not — a Node script cannot reach the Composio MCP, and there is no Supabase PAT, so the agent applies through the MCP and the script only emits a manifest. A test cannot assert a migration reached the database by calling a script that does not apply anything. What the script actually owns — name validity, ordering, idempotency-key derivation — is covered by `tests/unit/migration-manifest.test.ts`, and what the *database* actually received is covered per-task by the `md5(prosrc)` comparison against the committed file plus the catalogue assertions in `tests/integration/`.

**Interfaces:**
- Consumes: nothing
- Produces: `buildMigrationManifest(dir)` and `validateMigrations(dir)` in `scripts/apply-migration.ts` — the script validates the files and emits a JSON manifest; the **agent** applies each entry through the Composio MCP (a Node script cannot call the MCP itself, and there is no Supabase PAT).

- [ ] **Step 1: Write the failing test**

  SUPERSEDED by the ruling above: the delivered test is `tests/unit/migration-manifest.test.ts`, asserting the manifest and validator the script actually exposes.

- [ ] **Step 2: Run it to verify it fails**

  Superseded; recorded in `.superpowers/sdd/cliniccore-foundation/progress.md`.

- [ ] **Step 3: Implement `scripts/apply-migration.ts`**

  Validates `SUPABASE_PROJECT_REF` presence, then **emits a manifest** (`[{name, idempotencyKey, sql}]`) instead of applying: a Node script cannot reach the Composio MCP. The controller reads the manifest, checks `supabase_migrations.schema_migrations` for each `name` (the applier does **not** dedupe by `idempotency_key` — it re-executes), and applies only the unrecorded files through the MCP. `npm run migrations:check` runs the validator in `lint`.

- [ ] **Step 4: Commit `supabase/config.toml`**

  Configures local auth settings so a future `supabase start` or PAT-based `db push` runs the identical migrations. Not used for applying today.

- [ ] **Step 5: Run the test to verify it passes (BLOCKED if no credentials)**

  Run: `npx vitest run tests/unit/migration-manifest.test.ts`
  Expected: PASS. If `.env.local` is absent, record the item as **BLOCKED** in `docs/IMPLEMENTATION_STATUS.md` — do not report it as passing.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: add migration delivery harness applying via Composio"
  ```

### Task 5: Extensions, schemas, core functions

**Files:**
- Create: `supabase/migrations/20261014000100_extensions_and_schemas.sql`
- Create: `supabase/migrations/20261014000200_core_functions.sql`
- Test: `tests/integration/core-functions.test.ts`

**Interfaces:**
- Consumes: `applyMigration` from Task 4
- Produces: schema `private`; `private.set_updated_at()` trigger function; `private.guard_platform_admin()` trigger function. (`private.current_org_ids()` moved to the end of `00300` — Task 6 produces it; it reads a table that does not exist until that migration.)

- [ ] **Step 1: Write the failing test**

  Assert schema `private` exists and is not in PostgREST's exposed schema list; `private.set_updated_at` and `private.guard_platform_admin` exist; `set_updated_at` has `prosecdef = true`, `guard_platform_admin` has `prosecdef = false` (the invoker exception); both have `proconfig` containing `search_path=` (empty); `anon` has neither schema usage nor function execute.

  **Delivered as** `tests/integration/core-functions.test.ts`, with one obligation dropped: `pgrst.db_schemas` is unreadable from SQL, so the test asserts what is checkable — the schema exists and `anon`/`public` hold neither usage nor execute — and the PostgREST exposure question stays explicitly unresolved rather than asserted on faith.

- [ ] **Step 2: Run it to verify it fails**

  Run: `npx vitest run tests/integration/core-functions.test.ts` → FAIL.

- [ ] **Step 3: Write `20261014000100_extensions_and_schemas.sql`**

  `create extension citext with schema public;`, `create extension pgcrypto with schema public;`, guarded in a `DO $$ … $$` block against `pg_catalog.pg_extension` (the applier can reject `IF NOT EXISTS` DDL with SQLSTATE 42601), then `create schema if not exists private;`.
  Pin `with schema public` on every `create extension`: without it, placement follows the applier's `search_path` and is environment-dependent. Then `revoke all on schema private from public; grant usage on schema private to authenticated;` — the schema holds authorisation primitives and must not be reachable through PostgREST.

- [ ] **Step 4: Write `20261014000200_core_functions.sql`**

  - `private.set_updated_at() returns trigger` — `security definer`, `set search_path = ''`, sets `new.updated_at = now()`. Attached to every table carrying `updated_at`.
  - `private.guard_platform_admin() returns trigger` — **`security invoker`**, `set search_path = ''`, raises `'is_platform_admin is not user-writable'` when `new.is_platform_admin is distinct from old.is_platform_admin`, unless `current_user::text = 'service_role'`. This is **defence-in-depth, not an unforgeable boundary.** Under PostgREST every request runs in a session whose `session_user` is `authenticator`, which holds `SET` on `service_role` by design (the service key requires it), so any SQL-executing session can `SET ROLE service_role` and forge the check — just as it can forge the `request.jwt.claim.role` GUC via `set_config`. No database-layer check can distinguish the service key from an escalated session. The guard's real value is the PostgREST **table-endpoint** path, where a client cannot inject `SET ROLE`. The hard barriers are the absence of any SQL-execution surface reachable by `anon`/`authenticated`, and `profiles` RLS (Task 9) — and these are not independent: `service_role` has `BYPASSRLS`, so RLS falls with the same escalation, which makes "no client-reachable SQL surface" the load-bearing barrier. Invoker is preferred over definer because it additionally holds inside a definer-hosted SQL surface, where `SET ROLE` is forbidden. **UPDATE-only trigger**: attach `before update … for each row`; OLD is null on INSERT so the predicate would fire on every signup — the INSERT side is closed through `profiles` RLS in Task 9.
  - `private.current_org_ids() returns setof uuid` — `security definer`, `stable`, `set search_path = ''`, returns organization ids from `public.organization_memberships` where `user_id = (select auth.uid())` and `status = 'active'`. **Created at the end of `20261014000300_identity_and_tenancy.sql`, not here** — it reads `public.organization_memberships`, which does not exist until that migration; a forward reference would leave a function that cannot run.

- [ ] **Step 5: Apply both migrations, then verify via catalogue**

  Run: `npm run migrations:check`, then apply the two files through the Composio MCP (history check first) and query `pg_proc` for the functions and `prosecdef`/`proconfig`.
  Expected: `set_updated_at` and `guard_platform_admin` present; `set_updated_at` `prosecdef = true`, `guard_platform_admin` `prosecdef = false` (the invoker exception); both with empty `search_path`; `anon` has neither schema usage nor function execute. `current_org_ids` is verified with Task 6.

- [ ] **Step 6: Run the test to verify it passes** → PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add -A && git commit -m "feat: add private schema and core trigger functions"
  ```

### Task 6: Identity and tenancy schema

**Files:**
- Create: `supabase/migrations/20261014000300_identity_and_tenancy.sql`
- Test: `tests/integration/tenancy-schema.test.ts`

**Interfaces:**
- Consumes: `private.set_updated_at()` and `private.guard_platform_admin()` from Task 5; produces `private.current_org_ids()` itself (moved here from Task 5; it reads `organization_memberships`, created in this migration)
- Produces: tables `profiles`, `organizations`, `organization_memberships`, `clinics`, `clinic_memberships`, `invitations` per the column list above; trigger on `auth.users` creating a `profiles` row on insert.

- [ ] **Step 1: Write the failing test**

  Assert all six tables exist; **RLS is enabled on all six** (`relrowsecurity`, deny-all at this stage); every tenant-owned table has `organization_id`; `organization_memberships` has unique `(organization_id, user_id)` **and** unique `(organization_id, id)`; `clinics` and `organization_memberships` each expose unique `(organization_id, id)`; `clinic_memberships`' two foreign keys are composite and both include `organization_id`; `organizations.slug` is `citext` and unique; the `set_updated_at` trigger maintains `updated_at` on every table that has one; the `guard_platform_admin` trigger exists on `profiles` for **UPDATE only** (not INSERT); `private.current_org_ids` exists with `prosecdef = true` and empty `search_path`.

- [ ] **Step 2: Run it to verify it fails** → FAIL (tables absent).

- [ ] **Step 3: Write the migration**

  Per the column list. Create `unique (organization_id, id)` on every tenant-owned table — **this is what makes the composite foreign keys expressible**, and is a prerequisite for Task 8, not an optimisation.

  The `auth.users` insert trigger must be `security definer` with `set search_path = ''`, inserting `profiles (id, full_name)` from `new.raw_user_meta_data ->> 'full_name'`.

  **Attach the Task 5 triggers.** `private.guard_platform_admin()` on `profiles` **`before update … for each row` ONLY** — never `before insert`: OLD is null there, so the predicate would raise on every signup. The INSERT side of `is_platform_admin` is closed through `profiles` RLS (Task 9), not the trigger. `private.set_updated_at()` on every table carrying an `updated_at` column.

  **Create `private.current_org_ids()` here** (moved from Task 5 — it reads `public.organization_memberships`, which this migration creates): `security definer`, `stable`, `set search_path = ''`, returns organization ids from `public.organization_memberships` where `user_id = (select auth.uid())` and `status = 'active'`; revoke execute from `public`, grant to `authenticated`.

  **Enable RLS (deny-all) on all six tables now.** Supabase grants `anon`/`authenticated` access to new public tables by default, so a table created here and left without RLS is reachable through PostgREST until Task 9 adds policies. `enable row level security` with no policies denies everyone except the owner/service role; Task 9's policies layer on top. **This is a standing rule, not a Task 6 one-off:** every migration that creates a public table enables RLS on it in the same file (Tasks 7 and 8 create `permissions`, `roles`, `role_permissions`, `user_role_assignments`, `patients`, `patient_identifiers`, `tenant_sequences`, `audit_logs`, `platform_settings` — each needs its own enable; `tenant_sequences` matters most, since an unprotected counter lets any authenticated user bump any organization's sequence). The table-wide privileges RLS does *not* cover — `TRUNCATE`, `REFERENCES`, `TRIGGER` — are handled once for everything downstream by the `alter default privileges in schema public revoke … from anon, authenticated` at the top of Task 7's `00400`; later migrations inherit it and must not repeat the per-table revokes. That default ACL binds only objects created by the role that issued it (here `postgres`, which is what the applier uses), so a table created by any other role would not inherit it.

  **`invitations.role_id` is a plain `uuid` here, not a foreign key** — `roles` does not exist until Task 7's `00400`. Task 7 adds the foreign key once the table exists; a forward reference would fail at apply time.

- [ ] **Step 4: Apply, then verify the composite FKs actually span organizations**

  Query `pg_constraint` for `clinic_memberships` and assert each FK has exactly 2 key columns including `organization_id`. A single-column FK here would silently reintroduce the cross-tenant hole — assert the arity, not just the presence.

- [ ] **Step 5: Run the test to verify it passes** → PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: add identity and tenancy schema with composite tenant foreign keys"
  ```

### Task 7: Authorization schema and seed

**Files:**
- Create: `supabase/migrations/20261014000400_authorization.sql`
- Create: `supabase/migrations/20261014000500_authorization_functions.sql`
- Test: `tests/unit/authorization-schema-sql.test.ts` (migration-text invariants) and `tests/unit/permissions-seed.test.ts` (the registry/inline drift guard, which replaces the `scripts/apply-permissions-seed.ts` this task originally specified — see Step 5)

**Interfaces:**
- Consumes: Task 3's `ROLES`/`PERMISSIONS`; Task 6's tables
- Produces: tables `permissions`, `roles`, `role_permissions`, `user_role_assignments`; functions
  - `private.is_member(p_org_id uuid): boolean`
  - `private.is_platform_admin(): boolean`
  - `private.clinic_ids(p_org_id uuid): setof uuid`
  - `private.can(p_org_id uuid, p_permission text, p_clinic_id uuid default null): boolean`

- [ ] **Step 1: Write the failing test**

  Assert the four tables exist; `roles.organization_id` is nullable (NULL = platform role); `user_role_assignments` has unique `(organization_id, user_id, role_id, clinic_id)`. For each of the four functions assert `prosecdef = true`, `provolatile = 's'` (stable), empty `search_path`, `execute` revoked from `public` and granted to `authenticated` only — check `has_function_privilege` for both `anon` and `authenticated`.

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Write `20261014000400_authorization.sql`**

  Four tables per the column list. `roles.is_system` marks seeded roles.

  **Add the deferred foreign key from Task 6:** `alter table public.invitations add constraint invitations_role_id_fkey foreign key (role_id) references public.roles (id);` — `invitations.role_id` was created without it because `roles` did not exist yet. Guard it so a re-run is a no-op (`if not exists` in `pg_constraint`, or `drop constraint if exists` first).

  **Close the cross-tenant role reference (Task 6 review I4).** The FK above only proves the role *exists* — it does not prove it belongs to the row's organization. An admin of org A could invite with a role owned by org B (or a platform role) and grant org-A permissions drawn from another tenant's role. A composite FK cannot express this because platform roles have `organization_id IS NULL` and a composite key never matches a NULL. Add a `security definer`, `set search_path = ''` guard trigger on `invitations` (and on `user_role_assignments`) that raises unless `role.organization_id IS NULL OR role.organization_id = NEW.organization_id`; revoke execute from `public`. **Superseded in part by Task 7's review — read before relying on this.** The `IS NULL` allowance is still correct here (it is what lets a platform role be assigned at all), but the original justification for it was wrong: it claimed the allowance "grants nothing platform-level", which is only true because `private.can` is org-strict and refuses `platform.*` keys outright (Task 7 fix rounds 1–2). It is not the allowance that makes that safe, and nothing in the system now depends on it for correctness — Task 10 must still keep `roles` out of tenant hands, since a tenant able to mint a platform role is the thing the allowance would then carry.

- [ ] **Step 4: Write `20261014000500_authorization_functions.sql`**

  - `private.is_member` — exists in `organization_memberships` for `auth.uid()` with `status = 'active'`.
  - `private.is_platform_admin` — reads `public.profiles.is_platform_admin` for `auth.uid()`.
  - `private.clinic_ids` — clinics reachable through the caller's membership; **all clinics in the org** when the membership has no `clinic_memberships` rows.
  - `private.can(org, permission, clinic)` — requires `is_member(org)` **and** an assignment matching the permission, honouring clinic scope: an assignment with `clinic_id IS NULL` applies org-wide; one with a `clinic_id` applies only to that clinic. When `p_clinic_id` is NULL the check is org-wide.

  **`private.can` must not consult `private.is_platform_admin`.** Platform operators get tenant/subscription visibility through a separate function; granting them `private.can` would expose every tenant's patient records, which the spec forbids as excessive privilege.

- [ ] **Step 5: Write and run the seed script**

  **Inline the platform seed here, between sentinel comments.** Run `generatePlatformScopeSql()` and paste its output between `-- BEGIN GENERATED PLATFORM SEED` and `-- END GENERATED PLATFORM SEED`: all permissions, the platform role at `organization_id NULL`, and its `role_permissions` grants, every statement carrying an on-conflict clause. **Re-running this migration is how the seed is refreshed.** `tests/unit/permissions-seed.test.ts` regenerates the block and fails if the inlined copy differs, so a registry edit without a re-inline cannot pass CI.

  This step originally specified `scripts/apply-permissions-seed.ts` to "call the generator and apply the output". That is not achievable here: nothing in a Node process can **apply** SQL (the Composio MCP is agent-side, and there is no database connection or PAT), and nothing in a Node process can even **import** the generator — `gen-permissions-sql.ts` imports `@/lib/permissions/registry`, a tsconfig path alias that plain Node does not resolve, so vitest is its only working consumer. A script that cannot apply is at best a printer, and a printer is a worse drift guard than a test that can compare. Organization roles are seeded per organization inside Task 8's onboarding RPC (`00600`), which inlines `generateOrganizationScopedRoleSeedTemplate()`.

- [ ] **Step 6: Apply, verify, then run the test** → PASS.

  The rehearsal also compares `select key from public.permissions order by key` against `lib/permissions/registry.ts`. `permissions-seed.test.ts` proves the migration **file** matches the registry; only this comparison proves the **database** does — a registry edit that is re-inlined but never re-applied leaves CI green and the table stale.

- [ ] **Step 7: Commit**

  ```bash
  git add -A && git commit -m "feat: add authorization schema, stable security-definer helpers, and permission seed"
  ```

### Task 8: Tenant data, audit and platform schema

**Files:**
- Create: `supabase/migrations/20261014000600_onboarding_rpc.sql`
- Create: `supabase/migrations/20261014000700_tenant_data.sql`
- Create: `supabase/migrations/20261014000800_audit_and_platform.sql`
- Test: `tests/integration/tenant-data-schema.test.ts`
- Test: `tests/integration/onboarding-rpc.test.ts`
- Test: `tests/integration/audit-log.test.ts`

**Interfaces:**
- Consumes: Task 6 tables, Task 7 `permissions`/`roles`
- Produces: `private.create_organization_with_owner(p_name text, p_slug text, p_clinic_name text, p_timezone text default 'Asia/Kolkata') returns uuid`; tables `patients`, `patient_identifiers`, `tenant_sequences`, `audit_logs`, `platform_settings`; `private.next_sequence_value(p_org_id uuid, p_sequence_key text) returns bigint`; `private.write_audit(p_org_id uuid, p_action text, p_resource_type text, p_resource_id uuid default null, p_metadata jsonb default '{}') returns void`.

- [ ] **Step 1: Write the failing schema test**

  Assert the five tables exist; `patients` has unique `(organization_id, id)` and unique `(organization_id, clinic_id, mrn)`; `patient_identifiers`' FK to patients is composite spanning `organization_id`; `patients.clinic_id`'s FK is composite to `clinics(organization_id, id)`. Assert `mrn` is `text`, **not** a global sequence or integer — the brief forbids exposing sequential database ids as patient identifiers.

- [ ] **Step 2: Write the failing RPC test**

  As a fresh authenticated user, call `private.create_organization_with_owner('A','org-a','Clinic A')`; assert it returns an org uuid, creates exactly one `organization_memberships` row with status `active`, one `clinics` row, and seeds the org-scoped roles plus an `owner` assignment holding `organization_owner`. Assert calling it twice with the same slug raises a unique violation.

- [ ] **Step 3: Write the failing audit test**

  As user A, call `private.write_audit(orgA, 'patient.read', 'patient', somePatientId)`. Assert one row written with `actor_user_id = A`. Assert A can `update` and `delete` an audit row — both must affect zero rows. Assert the metadata is recorded but the function **rejects** any payload containing a key named `note`, `notes`, or `content`, so clinical free-text cannot be smuggled into audit metadata.

- [ ] **Step 4: Run all three to verify they fail** → FAIL.

- [ ] **Step 5: Write the migrations**

  Tables per the column list. The RPC is `security definer`, `set search_path = ''`, `revoke execute … from public`, `grant execute … to authenticated`, and performs all inserts in one transaction. It is the **only** path that bootstraps an organization, which avoids the chicken-and-egg problem of creating the first membership under a policy that requires membership.

  `private.next_sequence_value` must be atomic (row lock or `insert … on conflict do update … returning`) so two concurrent callers cannot receive the same MRN.

  `private.write_audit` is `security definer`, `set search_path = ''`, and is the **only** supported way to write audit rows. `audit_logs` gets RLS with a **select policy only** in Task 9 — no update or delete policy for authenticated users, which is what makes it append-only at the policy layer. This is append-only, not tamper-proof, and the documentation must say so exactly.

- [ ] **Step 6: Apply, verify, run tests** → PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add -A && git commit -m "feat: add tenant data, audit and platform schema with atomic onboarding RPC"
  ```

### Task 9: Row-level security

**Files:**
- Create: `supabase/migrations/20261014000900_rls_identity.sql` … `20261014001200_rls_audit_and_platform.sql`
- Test: `tests/security/rls-policies.test.ts`

**Interfaces:**
- Consumes: Task 6–8 tables, Task 7 helpers
- Produces: RLS enabled on all tenant-owned tables; policies named `tenant_isolation` on each.

- [ ] **Step 1: Write the failing policy test**

  Assert `relrowsecurity = true` on every tenant-owned table; assert each expected policy exists in `pg_policies`; assert each policy's `qual`/`with_check` is non-null. Then, as a seeded user: assert a member sees only their org's rows, and a non-member sees none.

- [ ] **Step 2: Run it to verify it fails** → FAIL (RLS not enabled).

- [ ] **Step 3: Write the four RLS migrations**

  Every policy `to authenticated`, every helper call wrapped `(select …)`. Patterns:

  - Read: `using (organization_id in (select private.current_org_ids()) and private.can(organization_id, '<resource>.read'))`.
  - Clinic-scoped read — the normal case for clinical data — is a **conjunction of three clauses, not alternatives**: `organization_id in (select private.current_org_ids())`, `private.can(organization_id, '<resource>.read', clinic_id)` passing the **row's** clinic (never NULL), and `clinic_id in (select private.clinic_ids(organization_id))`. `can` is the *permission* authority and `clinic_ids` the *reach* authority, and neither implies the other: a user with an org-wide assignment whose `clinic_memberships` are scoped to one clinic passes `can(org, perm, other_clinic)` while that other clinic is absent from `clinic_ids`, so only the conjunction closes it. Written with the two-argument `can` a clinic-scoped reader gets **no rows** — fail-closed, but that silent symptom is exactly what gets "fixed" under deadline by loosening `can`, which is a cross-clinic leak.
  - Write: same predicate in both `using` and `with check`.

  Special cases: `organizations` uses `private.is_member(id)`; `organization_memberships` uses `private.is_member(organization_id)`; `audit_logs` gets **select only** — authenticated users get no update or delete policy, making it append-only; `platform_settings` is readable only when `private.is_platform_admin()`, never by tenant members. **`profiles` and `invitations` are not org-scoped and need explicit policies or they stay deny-all forever:** `profiles` gets `select` and `update` where `id = (select auth.uid())`, and **no INSERT policy at all** (rows are created by the `auth.users` definer trigger; a client INSERT would be the INSERT-side route to `is_platform_admin`, so the update `with check` must also forbid flipping it — the UPDATE-only guard trigger does not cover this path); `invitations` read/write is gated by `private.can(organization_id, 'staff.manage')`. **`roles` must never become tenant-writable**: its INSERT/UPDATE policies carry `with check (organization_id is not null and private.can(organization_id, 'settings.manage'))`, so a tenant admin cannot mint a platform role — `guard_role_org_scope` deliberately permits a platform role in any organization, so without this a NULL-org role created here would be assignable to anyone. **`role_permissions` needs the same care, and its own shape forces it:** the table has no `organization_id` column, so any policy on it must reach the organization through `roles`. Its write policy must both require the role to belong to the caller's organization (`exists (select 1 from public.roles r where r.id = role_id and r.organization_id = (select …))`) **and** refuse platform keys (`permission_key not like 'platform.%'`), or a tenant attaching `platform.tenants.manage` to one of its own roles would satisfy `private.can` for a platform permission. `can` already refuses `platform.*` keys as defence in depth, so a mistake here is inert — but the policy should still say no. **`permissions` stays deny-all or read-only** — it is the registry's reference table, seeded once by migration, and `authenticated` holds table-level INSERT on it by default; a tenant able to insert a key is what would make a case-variant key (`Platform.tenants.manage`) both insertable and matchable, which is the only remaining reason `can` bothers to lower-case the key. **The one sanctioned exception is the onboarding RPC**: `private.create_organization_with_owner` re-upserts all 21 keys with `on conflict (key) do update set description`, so it can write descriptions (it cannot mint a key, and it self-heals registry/database drift). No other client path may write that table. And **`organizations` needs a platform branch**: suspension now makes `private.is_member` false, so a platform operator reading the tenant directory through `private.is_member(id)` alone sees **zero rows** — including the suspended tenants they exist to restore. Its policy must OR in `private.is_platform_admin()`.

  Use `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE …) THEN … $$` guards, not bare `IF NOT EXISTS` policy DDL (SQLSTATE 42601).

- [ ] **Step 4: Apply all four, verify policies via `pg_policies`**

  Assert policy count matches expectation per table and that `audit_logs` has zero update/delete policies.

- [ ] **Step 5: Run the test to verify it passes** → PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: enable RLS with tenant isolation and permission policies on all tenant tables"
  ```

### Task 10: Storage buckets and policies

**Files:**
- Create: `supabase/migrations/20261014001300_storage.sql`
- Test: `tests/security/storage-policies.test.ts`

**Interfaces:**
- Consumes: Task 7 helpers
- Produces: private buckets `patient-documents`, `clinical-attachments`, `investigation-reports`, `org-assets`, `prescription-documents`; storage objects policies.

- [ ] **Step 1: Write the failing test**

  Assert all five buckets exist with `public = false`. Create an object for org A as a member of A and for org B as a member of B; assert A can list/read only A's objects and cannot read B's by path.

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Write the migration**

  Buckets created `insert into storage.buckets (id, name, public) values … on conflict (id) do nothing`. Storage policies parse the first path segment as `organization_id` and gate with `private.is_member(...)` cast from text, plus a permission check where appropriate. **No bucket is public.**

- [ ] **Step 4: Apply, verify `public = false` on all five, run test** → PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A && git commit -m "feat: add private storage buckets with tenant-scoped policies"
  ```

### Task 11: Database types and money/datetime helpers

**Files:**
- Create: `types/database.types.ts` (generated), `lib/utils/money.ts`, `lib/utils/datetime.ts`
- Test: `tests/unit/money.test.ts`, `tests/unit/datetime.test.ts`

**Interfaces:**
- Consumes: applied schema
- Produces: `formatMinor(amount: bigint, currency: string, locale?: string): string`; `type Minor = bigint`; `formatInClinicTz(iso: string, timezone: string, locale?: string): string`; `clinicDayBounds(date: Date, timezone: string): { startIso: string; endIso: string }`.

- [ ] **Step 1: Write the failing money test**

  `formatMinor(123456n, 'INR')` → contains `1,234.56`; `formatMinor(0n, 'INR')` → `'₹0.00'`; `formatMinor(-500n, 'INR')` → `'-₹5.00'`. Assert a round-trip of `parseMinor(formatMinor(x))` equals `x` for a spread of values including `1n`, `99n`, `100n`, `123456789n`.

- [ ] **Step 2: Write the failing datetime test**

  *(Review Focus 4)* `formatInClinicTz('2026-10-14T18:00:00Z', 'Asia/Kolkata')` → `2026-10-15` (23:30 local — the next calendar day in that zone). `clinicDayBounds(new Date('2026-10-14T12:00:00Z'), 'Asia/Kolkata')` returns a 24-hour window whose start is `2026-10-13T18:30:00Z`. Assert both.

- [ ] **Step 3: Run both to verify they fail** → FAIL.

- [ ] **Step 4: Generate `types/database.types.ts`**

  Call Composio `SUPABASE_GENERATE_TYPESCRIPT_TYPES(ref, included_schemas='public')` and write the output. Never hand-edit. Re-generate after every migration batch.

- [ ] **Step 5: Implement the helpers**

  Money takes and returns `bigint` minor units; no float ever appears in the module. Datetime uses `Intl.DateTimeFormat` with an explicit `timeZone` and never the server's ambient zone.

- [ ] **Step 6: Run the tests to verify they pass** → PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add -A && git commit -m "feat: generate database types and add bigint money and clinic-timezone helpers"
  ```

### Task 12: Supabase clients and session handling

**Files:**
- Create: `lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/supabase/proxy.ts`, `proxy.ts`
- Test: `tests/integration/auth-session.test.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- Produces: `createBrowserClient(): SupabaseClient<Database>`; `createServerClient(): Promise<SupabaseClient<Database>>`; `updateSession(request: NextRequest): Promise<NextResponse>`; `getUser(): Promise<User | null>`; `getClaims(): Promise<{ sub: string } | null>`.

- [ ] **Step 1: Write the failing test**

  Sign up a fresh user, assert `getClaims()` returns the user, call `signOut()`, assert `getClaims()` returns null. Assert `proxy.ts` exports a named `proxy` function (not `middleware`).

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Implement the three client modules**

  Follow the current Supabase Next.js pattern exactly. `server.ts` `setAll` writes via `cookieStore.set` inside a try/catch that swallows the Server-Component read-only case. `proxy.ts` `setAll` writes to **both** `request.cookies` and the response, rebuilding `NextResponse.next({ request })` each time — this is the documented invariant; violating it desynchronises browser and server and terminates sessions. Call `await supabase.auth.getClaims()` immediately after client creation.

- [ ] **Step 4: Implement root `proxy.ts`**

  Next.js 16 renamed `middleware.ts` → `proxy.ts` and the export `middleware` → `proxy`. It runs on the Node.js runtime; the edge runtime is **not** supported. Export `config.matcher` excluding `_next/static`, `_next/image`, and files with an extension.

- [ ] **Step 5: Run the test to verify it passes** → PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: add Supabase SSR clients and proxy session refresh"
  ```

### Task 13: Errors, validation, active-org helpers

**Files:**
- Create: `lib/errors.ts`, `lib/validation/auth.ts`, `lib/auth/session.ts`, `lib/auth/active-org.ts`
- Test: `tests/unit/errors.test.ts`, `tests/integration/active-org.test.ts`

**Interfaces:**
- Consumes: Task 12 clients
- Produces: `AppError` with `code`, `status`, `message`; subclasses `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ValidationError` (422), `ConflictError` (409); `toSafeResponse(e: unknown): { status: number; body: { error: string; code: string } }`; `loginSchema`, `signupSchema`, `forgotPasswordSchema`, `resetPasswordSchema`, `createOrganizationSchema`; `getActiveOrg(): Promise<ActiveOrg | null>`; `setActiveOrg(orgId: string): Promise<void>`; `requireActiveOrg(): Promise<ActiveOrg>`; `userCan(permission: PermissionKey): Promise<boolean>`.

  Naming note: the server-side lookup is `userCan`, deliberately **not** `hasPermission` — Task 3 already owns `hasPermission(roles, permission): boolean` as a pure function over an in-memory role list. Two different signatures under one name is a bug waiting to happen at every call site.

- [ ] **Step 1: Write the failing error test**

  Assert `toSafeResponse` never leaks a stack trace, SQL text, or the raw `message` of a non-`AppError`; assert an unexpected `Error('connection string postgres://user:hunter2@…')` yields a generic 500 body with no `hunter2` in the serialised output.

- [ ] **Step 2: Write the failing active-org test**

  *(Review Focus 2)* Seed a user with two memberships; set the cookie to org B, assert `getActiveOrg()` returns B; then delete membership B, assert `getActiveOrg()` returns null rather than B, and that `requireActiveOrg()` throws `UnauthorizedError`.

- [ ] **Step 3: Run both to verify they fail** → FAIL.

- [ ] **Step 4: Implement**

  `toSafeResponse` maps unknown errors to a fixed 500 message. The active-org cookie is `cc_active_org`, HTTP-only, `sameSite: 'lax'`, `secure` in production. `getActiveOrg` **always re-validates** the cookie against a live `organization_memberships` row and never trusts the cookie's contents on their own. A user with no memberships gets `null`, which is what Task 17 renders.

- [ ] **Step 5: Run the tests to verify they pass** → PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: add typed errors, auth validation, and revalidating active-org resolution"
  ```

### Task 14: Payment provider seam

**Files:**
- Create: `lib/billing/provider.ts`, `lib/billing/unconfigured.ts`
- Test: `tests/unit/payment-provider.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type CheckoutInput`, `type CheckoutSession`, `type WebhookEvent`, `type RefundInput`, `type RefundResult`, `interface PaymentProvider`, `getPaymentProvider(): PaymentProvider`, `isPaymentConfigured(): boolean`.

- [ ] **Step 1: Write the failing test**

  Assert every method of `getPaymentProvider()` rejects with `PaymentNotConfiguredError`; `isPaymentConfigured()` is false; assert no HTTP client is instantiated and no Razorpay SDK is imported anywhere in `lib/`.

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Implement the seam**

  Interface plus a stub whose methods reject. No Razorpay dependency is added to `package.json` this increment. Do not add a "test mode" that returns a successful fake payment — that would misrepresent payment capability, which the brief forbids.

- [ ] **Step 4: Run the test to verify it passes** → PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A && git commit -m "feat: add provider-agnostic payment seam (unconfigured; Razorpay deferred to Phase 8)"
  ```

### Task 15: Auth pages

**Files:**
- Create: `app/(auth)/layout.tsx`, `login/page.tsx`, `signup/page.tsx`, `forgot-password/page.tsx`, `reset-password/page.tsx`, `verify/page.tsx`
- Test: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: Task 12 clients, Task 13 schemas and `toSafeResponse`
- Produces: routes `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify`.

- [ ] **Step 1: Write the failing E2E test**

  `tests/e2e/auth.spec.ts`: sign up a fresh user and assert landing on onboarding (not an inbox interstitial); sign out; sign in; assert `/app/dashboard` reachable; request a password reset and assert a generic success message regardless of whether the account exists (no account enumeration).

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Implement the pages**

  Server Components for layout; the forms are Client Components using `react-hook-form` + `zodResolver`. Every mutation is a server action that validates with Zod before touching Supabase, and returns `toSafeResponse` on failure. `verify/page.tsx` detects an already-signed-in session and explains that confirmation is disabled in this environment, rather than rendering a dead interstitial.

- [ ] **Step 4: Run the E2E test to verify it passes** → PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A && git commit -m "feat: add signup, login, password reset and verification pages"
  ```

### Task 16: Application shell and onboarding

**Files:**
- Create: `app/(app)/layout.tsx`, `app/(app)/dashboard/page.tsx`, `app/(app)/onboarding/page.tsx`, `app/(app)/settings/members/page.tsx`, `app/invite/[token]/page.tsx`
- Create: `components/app/sidebar-nav.tsx`, `components/app/org-switcher.tsx`, `components/app/clinic-switcher.tsx`
- Create: `supabase/migrations/20261014001400_invitations.sql`
- Test: `tests/e2e/onboarding.spec.ts`, `tests/e2e/invitations.spec.ts`

**Interfaces:**
- Consumes: Task 13 `requireActiveOrg`/`userCan`; Task 8 RPC
- Produces: routes `/app/dashboard`, `/app/onboarding`, `/app/settings/members`.

- [ ] **Step 1: Write the failing E2E test**

  *(Review Focus 1, 3)* Sign up a user with **zero** memberships and assert `/app` renders an onboarding screen, not a crash or redirect loop. Pre-seed an organization with slug `taken-slug` via the service role, then submit `taken-slug` in the onboarding form and assert a friendly inline error with no 500. Create an organization with a fresh slug and assert the user lands on `/app/dashboard` with the org name visible.

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Implement the shell**

  The `(app)` layout calls `requireActiveOrg()`. If it returns null the layout renders the onboarding route instead of the sidebar shell. `/app/dashboard` displays the active organization name and the caller's role assignments read from the database under RLS — **no fabricated KPI numbers**, since no clinical data exists yet; show an explicit empty state.

- [ ] **Step 4: Implement the switchers**

  `org-switcher` lists only organizations returned by `getActiveOrg`-style membership lookup, never a client-held list. Switching calls a server action that validates membership, then writes the `cc_active_org` cookie.

- [ ] **Step 5: Write the failing invitation test**

  As an organization owner, invite `newdoc@example.com` with role `doctor`. Assert one `invitations` row whose `token_hash` is a SHA-256 digest — the raw token must **not** appear in any column. Assert the invitee, signed in as a different user, visits `/invite/<token>` and, on acceptance, gains an `organization_memberships` row plus a `user_role_assignments` row holding `doctor`. Assert an expired token is rejected and an already-accepted token is rejected without creating a second membership.

- [ ] **Step 6: Implement the invitation flow**

  `private.accept_invitation(p_token text) returns uuid` — `security definer`, `set search_path = ''`, revokes from `public`, grants to `authenticated`. It hashes the supplied token, looks up the invitation, rejects on `expires_at < now()` or `accepted_at is not null`, and creates the membership and role assignment in one transaction. Only `staff.manage` holders may create invitations, enforced by RLS on the `invitations` insert policy.

  Add `app/invite/[token]/page.tsx` and the owner-facing invite form on `/app/settings/members`. Delivery is **not** implemented — the invite token is displayed for manual sharing and the absence of email delivery is recorded as BLOCKED, not described as a working notification.

- [ ] **Step 7: Run the E2E test to verify it passes** → PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add -A && git commit -m "feat: add application shell, organization onboarding, tenant switcher and invitations"
  ```

### Task 17: Marketing shell and platform-admin gate

**Files:**
- Create: `app/(marketing)/layout.tsx`, `app/(marketing)/page.tsx`, `components/marketing/*`
- Create: `app/(platform)/layout.tsx`, `app/(platform)/page.tsx`
- Test: `tests/e2e/platform-gate.spec.ts`

**Interfaces:**
- Consumes: Task 12 clients; Task 13 `toSafeResponse`
- Produces: routes `/` and `/platform`.

- [ ] **Step 1: Write the failing E2E test**

  Assert a normal clinic owner requesting `/platform` receives 404 or is redirected — **not** the tenant directory. Assert the platform route renders for a profile with `is_platform_admin = true` set directly via the service role.

- [ ] **Step 2: Run it to verify it fails** → FAIL.

- [ ] **Step 3: Implement the marketing shell**

  Server Component. Public header, hero, feature highlights and footer using design tokens only. **No testimonials, no customer counts, no uptime or certification claims** — the brief forbids claims that have not been verified. Full copy and page set are Phase 4; this is the visual foundation.

- [ ] **Step 4: Implement the platform gate**

  The `(platform)` layout calls `private.is_platform_admin()` server-side on every request and renders `notFound()` otherwise. It reads the tenant directory — organization names, statuses, member counts only. **No patient data is reachable from this route.**

- [ ] **Step 5: Run the E2E test to verify it passes** → PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "feat: add marketing shell and platform-admin gated console"
  ```

### Task 18: Tenant isolation suite

> **Read the layout note on `tests/integration/`/`tests/security/` before starting this task** (it sits above the migration table). This suite and its mutation harness need a live database that vitest cannot reach in this project, so as written here the steps below cannot run. Until a connection is configured, this task is discharged as a **controller-run harness with recorded runs** against the live project, not a committed vitest file. Decide which at the start of the task, and record the ruling.

**Files:**
- Create: `tests/security/tenant-isolation.test.ts`, `tests/security/fixtures.ts`, `tests/security/mutation-harness.ts`
- Test: this task's own tests

**Interfaces:**
- Consumes: all prior tasks
- Produces: `seedTwoOrganizations(): Promise<{ orgA, orgB, userA, userB, clientA, clientB }>`; `dropPolicy(table, policyName): Promise<void>`; `restorePolicy(name): Promise<void>`; `withMutation<T>(fn: () => Promise<T>, verify: () => Promise<void>): Promise<T>`.

- [ ] **Step 1: Write the isolation test**

  Seed two genuinely separate organizations with separate users, each signed in through its own Supabase client carrying only its own JWT — **never one shared admin account**. For every tenant-owned table assert:

  1. A's `select` returns zero B rows.
  2. A's `select` of B's row by primary key returns nothing.
  3. A's `update` on B's row affects zero rows.
  4. A's `delete` on B's row affects zero rows.
  5. A's `insert` referencing B's id is rejected by the composite FK.
  6. A cannot grant itself a role it does not hold.
  7. A cannot reach `/platform`.
  8. A cannot read B's storage objects.

- [ ] **Step 2: Run it to verify it fails** — it should pass once Tasks 9–10 are correct. **If it fails, that is a genuine finding about the RLS work, not a test bug.** Investigate before touching the test.

- [ ] **Step 3: Write the mutation harness**

  `withMutation` enforces the ordered loop from the spec: apply mutation → **verify the mutation actually applied by querying `pg_policies`/`pg_constraint`** → run the test → assert it fails → restore → assert it passes.

- [ ] **Step 4: Mutation-verify each assertion**

  For each policy under test, drop it, assert the catalogue shows it gone, run the corresponding test, **assert it fails**, restore, assert it passes. Additionally narrow `organization_memberships`' unique `(organization_id, user_id)` to `(user_id)` alone and confirm the cross-tenant uniqueness test fails — that mutation is the one a suite can pass for the wrong reason.

- [ ] **Step 5: Run the full suite to verify it passes** → PASS, with a recorded mutation-verification report.

- [ ] **Step 6: Commit**

  ```bash
  git add -A && git commit -m "test: add mutation-verified two-organization tenant isolation suite"
  ```

### Task 19: Documentation

**Files:**
- Create: `README.md`, `AGENTS.md`, and `docs/{PRD,SRS,ARCHITECTURE,DATABASE_SCHEMA,RLS_POLICIES,SECURITY,DESIGN_SYSTEM,ROUTES_AND_PERMISSIONS,TESTING,DEPLOYMENT,OPERATIONS,IMPLEMENTATION_STATUS}.md`

**Interfaces:**
- Consumes: the whole plan
- Produces: the 15 documentation artefacts.

- [ ] **Step 1: Write `AGENTS.md`**

  Architecture summary, conventions, security rules, commands, and the rule that migrations are applied via Composio and verified against the catalogue.

- [ ] **Step 2: Write the twelve `docs/` artefacts**

  Each describes the **actual** implementation. `SECURITY.md` states the threat model, tenant-isolation strategy, and that audit logs are append-only **without claiming tamper-proofing**. `DEPLOYMENT.md` records re-enabling email confirmation as a mandatory pre-launch step.

- [ ] **Step 3: Write `docs/IMPLEMENTATION_STATUS.md`**

  Completed tasks, **actual command output** for each gate, known defects, every BLOCKED item with its reason, and the next tasks. This file is updated per batch as work proceeds, not written once at the end.

- [ ] **Step 4: Verify no documentation claims unbuilt functionality**

  Grep for "certified", "HIPAA", "SOC 2", "ISO", "99.9", "customers", "integrations with" and confirm each hit is either absent or explicitly marked as not yet implemented.

- [ ] **Step 5: Commit**

  ```bash
  git add -A && git commit -m "docs: add all 15 documentation artefacts reflecting actual implementation"
  ```

### Task 20: Final gate

**Files:**
- Modify: `docs/IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: everything
- Produces: a recorded, honest verification report.

- [ ] **Step 1: Run every gate from clean**

  Run: `npm run typecheck && npm run lint && npm run test && npm run build && npm run e2e`
  Expected: all exit 0. Fix implementation failures; do not suppress them.

- [ ] **Step 2: Run the migration-from-zero check**

  Confirm migrations apply in filename order to a clean schema and produce a working system. Record the actual output.

- [ ] **Step 3: Record results honestly**

  Any gate that cannot run for want of external credentials is recorded as **BLOCKED** with its reason — never as passing.

- [ ] **Step 4: State the conclusion truthfully**

  The product is **not** production-ready at the end of this plan. Phases 4–10 remain unbuilt, and `IMPLEMENTATION_STATUS.md` must not imply otherwise.
