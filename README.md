# ClinicCore

[![Status: foundation only](https://img.shields.io/badge/status-foundation%20only-orange)](#project-status-and-limitations)
[![Next.js](https://img.shields.io/badge/Next.js-16.4.3-black?logo=nextdotjs&logoColor=white)](#tech-stack)
[![React](https://img.shields.io/badge/React-19.3.0-61DAFB?logo=react&logoColor=black)](#tech-stack)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3-3178C6?logo=typescript&logoColor=white)](#tech-stack)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.3.3-06B6D4?logo=tailwindcss&logoColor=white)](#tech-stack)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL%2017-3FCF8E?logo=supabase&logoColor=white)](#tech-stack)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-5FA04E?logo=nodedotjs&logoColor=white)](#prerequisites)

Multi-tenant clinic management built on Next.js 16, React 19 and Supabase/PostgreSQL. This
repository is the **foundation: Phases 1–3 only** — tooling, the design system,
authentication, tenancy, row-level security, the role/permission model, private storage, the
audit foundation, and a mutation-verified tenant-isolation suite.

**It is not production-ready.** There are no patients, appointments, invoices or reports in
the product surface; Phases 4–10 are unbuilt. The authoritative history of what was built,
measured and deferred is [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

## What works today

- Signup, sign-in, sign-out, email-verification status page, password-reset request and reset
  form.
- Organization onboarding: create a tenant and its first clinic in one transaction, with the
  creator as owner.
- Organization and clinic switchers, with the active choice re-validated against membership
  on every request.
- Invitation creation with a copyable link, and acceptance bound to the invitee's account
  address.
- 16 public tables under row-level security, 39 public policies and 20 storage policies,
  verified against the live catalogue.
- 15 seeded roles over 21 permission keys, with a tenant-scoped grant ceiling and a
  single-owner rule.
- Five private storage buckets, with tenancy derived from the object path.
- An append-only audit log, a definer-only writer, and metadata restricted to identifiers and
  codes.
- An operator console at `/platform` that lists tenant names, statuses and member counts, and
  answers 404 to everyone else.

## Why ClinicCore

- **Tenant isolation is structural.** Row-level security is the authority, composite foreign
  keys make a cross-tenant reference unrepresentable, and storage policies derive tenancy
  from the object path. Isolation does not depend on application code remembering to filter.
- **Authorization has one home.** `private.can` and its sibling helpers are the single
  permission rule. The browser asks `public.can`; it never reimplements the rule.
- **The isolation suite is mutation-verified.** It creates two real tenants, runs
  cross-tenant assertions for every tenant-owned table, and applies 38 recorded mutations
  inside rolled-back transactions to prove each policy is load-bearing rather than merely
  present.
- **It is an honest base for clinical work.** The tenancy, roles, storage and audit layers
  are built and tested; the clinical phases can add tables and policies without weakening a
  boundary that already exists.

## Tech stack

Versions are the ones pinned in `package.json`, `tsconfig.json` and
`supabase/config.toml`; `package-lock.json` is the resolved truth for the installed tree.

### Application

| Layer             | Technology                                       | Version        | Used for                                                                      |
| ----------------- | ------------------------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| Runtime           | Node.js                                          | `>=24`         | Next.js server, scripts, tests                                                |
| Language          | TypeScript                                       | 6.0.3          | Strict, `ES2022`, `bundler` resolution, `verbatimModuleSyntax`                |
| Framework         | Next.js (App Router, Turbopack)                  | 16.4.3         | Server Components, Server Actions, route handlers, `proxy.ts` session refresh |
| UI runtime        | React / React DOM                                | 19.3.0         | Server and client components, `useActionState`                                |
| Styling           | Tailwind CSS (CSS-first, PostCSS plugin)         | 4.3.3          | Design tokens in `app/globals.css` (`@theme inline`); no `tailwind.config.js` |
| Component system  | shadcn/ui (`radix-nova`, CLI) + Radix primitives | 4.21.4 / 1.8.1 | `components/ui/`, form controls, dialogs, menus                               |
| Icons             | lucide-react                                     | 1.57.0         | Icon set                                                                      |
| Class composition | `clsx` + `tailwind-merge` via `@/lib/utils/cn`   | 2.1.1 / 3.7.0  | Single class-merge engine; the unrelated npm `cn` package is banned by ESLint |
| Variants          | class-variance-authority                         | 0.7.1          | Component variants                                                            |
| Animation         | tw-animate-css                                   | 1.4.0          | Utility animation classes                                                     |
| Forms             | react-hook-form + `@hookform/resolvers`          | 7.90.0 / 6.0.0 | Client form state and validation                                              |
| Validation        | Zod                                              | 4.6.7          | Shared input schemas in `lib/validation/`                                     |

### Data and security

| Layer             | Technology                                       | Version / detail                | Used for                                                                                  |
| ----------------- | ------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| Database          | PostgreSQL (Supabase hosted)                     | 17 (`supabase/config.toml`)     | 16 public tables, `private` schema, plpgsql, triggers, composite tenant FKs               |
| Extensions        | `citext`, `pgcrypto`                             | —                               | Case-insensitive slugs/emails; `gen_random_uuid()` needs no extension on PG 13+           |
| API layer         | PostgREST                                        | Supabase managed                | Exposes the `public` schema only; 10 public RPC wrappers                                  |
| Authentication    | Supabase Auth (GoTrue)                           | Supabase managed                | Email/password signup, sign-in, sign-out, recovery, JWT sessions                          |
| Auth clients      | `@supabase/ssr` + `@supabase/supabase-js`        | 0.12.7 / 2.117.3                | Cookie-based browser and server clients in `lib/supabase/`                                |
| Server boundary   | `server-only`                                    | 0.0.1                           | Fails the bundle if a client component imports server code                                |
| Authorization     | RLS + `private.can` / `is_member` / `clinic_ids` | 39 public + 20 storage policies | Single permission authority; org-strict and platform-key-refusing                         |
| Storage           | Supabase Storage                                 | 5 private buckets               | Patient documents, clinical attachments, investigation reports, org assets, prescriptions |
| Money             | `bigint` paise helpers in `lib/utils/money.ts`   | —                               | No floating point in money paths                                                          |
| Date/time         | `Intl` / ICU + `lib/utils/datetime.ts`           | —                               | Clinic-local billing days; DST-safe `clinicDayBounds` walk                                |
| Schema management | Raw SQL migrations in `supabase/migrations/`     | 61 files                        | No ORM; applied through Composio, never `supabase db push`                                |
| Generated types   | `types/database.types.ts`                        | regenerated                     | Typed Supabase client surface                                                             |

### Tooling and tests

| Layer                 | Technology                                  | Version         | Used for                                                                  |
| --------------------- | ------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| Unit tests            | Vitest + jsdom                              | 5.0.4 / 30.1.2  | Unit, integration and security suites (`tests/`)                          |
| Browser tests         | Playwright                                  | 1.64.0          | Four E2E specs under `tests/e2e/`                                         |
| Direct database tests | `pg`                                        | 8.23.1          | Catalogue, RLS and transactional assertions via `TEST_DATABASE_URL`       |
| Linting               | ESLint (flat config) + `eslint-config-next` | 9.39.5 / 16.4.3 | `eslint .`, plus two repository gates below                               |
| Formatting            | Prettier                                    | 3.9.10          | `prettier --check .`; generated shadcn files are ignored on purpose       |
| Secret gate           | `scripts/check-no-secrets.ts`               | —               | Forbids service-role references outside allowed paths and secret literals |
| Migration gate        | `scripts/apply-migration.ts --check`        | —               | Filename, order and non-emptiness validation; applies nothing             |

Deliberately absent: an ORM, a client state library, a mail provider, a payment SDK and a
`Dockerfile`. Billing is a server-only seam whose methods all refuse; see
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

## Prerequisites

| Requirement           | Version / note                                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js               | `>=24` (`package.json` `engines`)                                                                                                                                                                                                                                                                                     |
| npm                   | 11.x measured on the development machine                                                                                                                                                                                                                                                                              |
| Supabase project      | hosted; the browser and server clients read `NEXT_PUBLIC_SUPABASE_URL`                                                                                                                                                                                                                                                |
| Composio MCP          | the only migration applier; there is no Supabase Personal Access Token                                                                                                                                                                                                                                                |
| Docker / Supabase CLI | **not required** for the scripts in this repository; no Dockerfile. `supabase/config.toml` serves a local stack only. Applying the migrations from zero still needs one of Docker, the Supabase CLI, or a Supabase PAT, so that clean-room apply is recorded BLOCKED - see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill in real values; never commit .env.local
npm run dev                  # http://localhost:3000
```

The application needs a hosted Supabase project. Create one, apply the migrations (below), and
put its URL and publishable key in `.env.local`. A local Supabase stack is optional and is not
what the committed `supabase/config.toml` deploys.

## First run

1. Open `http://localhost:3000/signup` and create an account. In this repository's hosted
   project email confirmation is disabled, so signup starts a session immediately; a real
   deployment must re-enable confirmation.
2. Open `/app/onboarding`, name the organization and its first clinic, and submit. The creator
   becomes the organization owner and is signed into the tenant.
3. `/app/dashboard` shows the organization, the caller's role assignments and the active
   clinic. Use the header switchers to change organization or clinic.
4. `/app/settings/members` creates an invitation. **No email is sent**; copy the displayed link
   and share it manually.
5. The invitee signs in with the invited address and opens `/invite/<token>`. The invitation
   is accepted by a database definer, which checks the account, the address, the expiry and
   the role ceiling.
6. `/platform` is the operator console. It answers 404 unless the signed-in account is a
   platform administrator.

## Environment variables

Names only. Values live in `.env.local`, which is gitignored; `.env.example` is the only
tracked template.

| Name                                   | Scope              | Read by                                                                                                      |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | browser + server   | `lib/supabase/*`                                                                                             |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server   | `lib/supabase/*`                                                                                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`        | unused             | retained placeholder; no client reads it, and the plan's fallback to it is not implemented                   |
| `SUPABASE_SERVICE_ROLE_KEY`            | **server only**    | allowed in `lib/supabase/server.ts` and under `tests/`; read only by `tests/helpers/auth-session-fixture.ts` |
| `SUPABASE_PROJECT_REF`                 | operator tooling   | the Composio migration apply                                                                                 |
| `TEST_DATABASE_URL`                    | server only, tests | `tests/integration/helpers/database.ts`                                                                      |
| `NEXT_PUBLIC_APP_URL`                  | server             | the password-reset redirect                                                                                  |

`NEXT_PUBLIC_SUPABASE_ANON_KEY` exists because the plan requires the clients to fall back to it
when the publishable key is absent. The clients do not implement that fallback and read no
`ANON_KEY` variable, so it is an unread placeholder; the publishable key is the only one in use.

`SUPABASE_SERVICE_ROLE_KEY` must never be prefixed `NEXT_PUBLIC_` and must never be
referenced from a `"use client"` file. `npm run check:secrets` enforces the path rule; the
`import "server-only"` line at the top of `lib/supabase/server.ts` is the boundary that
fails at bundle time.

## Scripts

| Script              | What it does                                                                          |
| ------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`       | Next.js development server                                                            |
| `npm run build`     | `next build` (Turbopack); type-checks as part of the build                            |
| `npm run start`     | serve the production build                                                            |
| `npm run typecheck` | `tsc --noEmit`                                                                        |
| `npm run lint`      | **four** gates: `eslint .` && `check:secrets` && `format:check` && `migrations:check` |
| `npm test`          | `vitest run` (unit, integration and security suites)                                  |
| `npm run format`    | `prettier --write .`                                                                  |

A green `eslint` pass says nothing about the other three gates inside `lint`. Read the
`check:secrets OK` line separately; it is the security half. Run the gates **last**,
immediately before committing:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Migrations

SQL files in `supabase/migrations/` are the source of truth. They are applied through the
Composio Supabase MCP (`SUPABASE_APPLY_A_MIGRATION`), one apply per call, and every apply is
verified by querying `information_schema` / `pg_catalog` / `pg_policies` — never by trusting
the apply response body. `scripts/apply-migration.ts --check` (part of `npm run lint`)
validates the filenames, order and non-emptiness. It does **not** apply anything.

A correction is always a new file. Never edit an applied migration. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Tests

| Suite       | Location             | Needs                                                          |
| ----------- | -------------------- | -------------------------------------------------------------- |
| Unit        | `tests/unit/`        | nothing external                                               |
| Integration | `tests/integration/` | `TEST_DATABASE_URL`; skips when absent, fails in CI            |
| Security    | `tests/security/`    | `TEST_DATABASE_URL`, a live Supabase project, service-role key |
| E2E         | `tests/e2e/`         | Playwright browsers, a live project, a running server          |

```bash
npm run test:unit
npm run test:integration
npx vitest run tests/unit/money.test.ts
npx playwright install   # once per @playwright/test version
npm run e2e
```

`TZ`-independent datetime tests, money helpers, the permission registry, the payment seam,
design tokens and the server/client boundary are unit-tested. The security suite creates two
real tenants, runs cross-tenant assertions for every tenant-owned table, and proves the
assertions load-bearing by applying 38 recorded mutations inside rolled-back transactions.
See [`docs/TESTING.md`](docs/TESTING.md).

## Documentation

| Document                                                           | Contents                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [`docs/PRD.md`](docs/PRD.md)                                       | Problem, personas, scope, non-goals, acceptance criteria                       |
| [`docs/SRS.md`](docs/SRS.md)                                       | Numbered requirements with their honest status                                 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                     | Route topology, boundaries, tenancy, dependency directions                     |
| [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md)               | 16 tables, constraints, triggers, indexes, migration order, buckets            |
| [`docs/RLS_POLICIES.md`](docs/RLS_POLICIES.md)                     | The 39 public and 20 storage policies, helper privileges, refusal shapes       |
| [`docs/SECURITY.md`](docs/SECURITY.md)                             | Threat model, isolation strategy, known limits                                 |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md)                   | Brand tokens, Tailwind v4 CSS-first setup, components, accessibility residuals |
| [`docs/ROUTES_AND_PERMISSIONS.md`](docs/ROUTES_AND_PERMISSIONS.md) | Every route and guard, 15 roles, 21 permission keys, the ceiling               |
| [`docs/TESTING.md`](docs/TESTING.md)                               | Test layers, mutation rules, environment hazards, coverage gaps                |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)                         | Environment, migration delivery, pre-launch steps                              |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md)                         | Runbook: tenants, invitations, audit, storage, incidents                       |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)   | The append-only ledger of what was built and measured                          |
| [`AGENTS.md`](AGENTS.md)                                           | Rules and measured traps for the next agent                                    |

## Getting help

Start with the documentation table above; [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
is the most current account of what works. Report non-sensitive bugs and documentation gaps in
the repository's GitHub issue tracker.

**Do not open a public issue for a suspected cross-tenant disclosure.** Read
[`docs/SECURITY.md`](docs/SECURITY.md) first. That document records that no security contact
address is committed yet, so a deployment must add one before launch.

There is no support SLA, chat channel or hosted service; this is a self-hosted foundation.

## Contributing and maintainers

Maintained by the repository owner, `@drmaruata`, at
<https://github.com/drmaruata/cliniccore>.

- Work on `feature/foundation`; `master` is the untouched base. Do not implement there.
- Read [`AGENTS.md`](AGENTS.md) before changing code. It records the measured toolchain,
  migration and RLS traps.
- Run the full gate set (`typecheck`, `lint`, `test`, `build`) before opening a pull request.
  There is no CI workflow, so state in the pull request which gates you ran.
- No `CONTRIBUTING.md` or `CODE_OF_CONDUCT.md` is committed yet. For anything beyond a small
  fix, open an issue first so the scope can be agreed.

## License

No `LICENSE` file is committed in this repository.

## Project status and limitations

Not working, or not verifiable in this repository:

- **No email delivery.** Invitation links are displayed for manual sharing; no mail provider
  is configured. Invitation delivery is **BLOCKED**.
- **Email confirmation is disabled** in the hosted project. Re-enabling it is a mandatory
  pre-launch step (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)). Signup therefore signs a
  user in immediately.
- **Password-reset mail is unverified.** The hosted project's redirect allow-list must include
  the app URL before a reset mail can be sent, and no mailbox was available to prove delivery.
- **Billing is a seam only.** Every provider method refuses; there is no Razorpay integration
  and no test mode. Nothing about payments is functional.
- **No clinical modules.** Patients exist as schema and RLS only — there is no patient UI and
  no patient data outside the isolation tests. The clinical phases 5–6 plan is written but not
  started.
- **Environment-wide testing gaps:** no rate-limit, CORS, error-message-leakage or load
  testing. The platform console answers 404 to non-operators by design.
- **Not production-ready.** Phases 4–10 remain.
