# ClinicCore

Multi-tenant clinic management, built on Next.js 16 and Supabase. This repository is the
**foundation: Phases 1–3 only** - tooling, the design system, authentication, tenancy,
row-level security, the role/permission model, private storage, the audit foundation, and a
mutation-verified tenant-isolation suite. **It is not production-ready.** There are no
patients, appointments, invoices or reports in the product surface; Phases 4–10 are unbuilt.

The authoritative history of what was built, measured and deferred is
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md). Do not treat a summary
elsewhere as more current than that log.

## Prerequisites

| Requirement           | Version / note                                                                    |
| --------------------- | --------------------------------------------------------------------------------- |
| Node.js               | `>=24` (`package.json` `engines`)                                                 |
| npm                   | 11.x measured on the development machine                                          |
| Supabase project      | hosted; the browser and server clients read `NEXT_PUBLIC_SUPABASE_URL`            |
| Composio MCP          | the only migration applier; there is no Supabase Personal Access Token            |
| Docker / Supabase CLI | **not required**; no Dockerfile. `supabase/config.toml` serves a local stack only |

## Install

```bash
npm install
cp .env.example .env.local   # then fill in real values; never commit .env.local
npm run dev                  # http://localhost:3000
```

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
immediately before committing.

## Migrations

SQL files in `supabase/migrations/` are the source of truth. They are applied through the
Composio Supabase MCP (`SUPABASE_APPLY_A_MIGRATION`), one apply per call, and every apply is
verified by querying `information_schema` / `pg_catalog` / `pg_policies` - never by trusting
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

## Honest status

Implemented and exercised in this repository:

- Signup, sign-in, sign-out, password-reset request, tenant onboarding, tenant switching,
  clinic switching, invitation creation and acceptance, platform console.
- 16 public tables under RLS, 39 public policies and 20 storage policies, verified against the
  live catalogue; 10 public RPC functions reachable by PostgREST.
- 15 seeded roles over 21 permission keys, with a tenant-scoped grant ceiling and a
  single-owner rule.

Not working, or not verifiable here:

- **No email delivery.** Invitation links are displayed for manual sharing; no mail provider
  is configured. Invitation delivery is **BLOCKED**.
- **Email confirmation is disabled** in the hosted project. Re-enabling it is a mandatory
  pre-launch step (see `docs/DEPLOYMENT.md`). Signup therefore signs a user in immediately.
- **Password-reset mail is unverified.** The hosted project's redirect allow-list must include
  the app URL before a reset mail can be sent, and no mailbox was available to prove delivery.
- **Billing is a seam only.** Every provider method refuses; there is no Razorpay integration
  and no test mode. Nothing about payments is functional.
- **No clinical modules.** Patients exist as schema and RLS only - there is no patient UI and
  no patient data outside the isolation tests.
- **Environment-wide testing gaps:** no rate-limit, CORS, error-message-leakage or load
  testing. The platform console answers 404 to non-operators by design.
- **Not production-ready.** Phases 4–10 remain.
