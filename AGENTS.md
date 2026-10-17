# ClinicCore — agent instructions

Living document. Keep it current: when a task changes how the next agent should work, update this file in the same commit.

## Where the truth lives

| Source                                                              | What it answers                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/superpowers/plans/2026-10-14-cliniccore-foundation.md`        | The 20-task build plan. Task N's brief is authoritative over any older habit.                                                                                            |
| `docs/superpowers/specs/2026-10-14-cliniccore-foundation-design.md` | Design spec / phases.                                                                                                                                                    |
| `docs/IMPLEMENTATION_STATUS.md`                                     | Append-only decision log. Every "why" (TS pin, `exactOptionalPropertyTypes`, `server-only`) is recorded here with its measurement. Read before changing a toolchain pin. |
| `.superpowers/sdd/cliniccore-foundation/progress.md`                | SDD ledger: per-task rulings, review findings, open carry-overs. Git-excluded via `.git/info/exclude`.                                                                   |

Global constraints in the plan (money as `bigint` paise, no floating point in money paths, composite tenant FKs, `private.can` as the single RLS authority, migrations via Composio not `supabase db push`) bind every task. Read the constraint list before writing SQL.

## Current state

Read this section as a claim to **verify**, not a fact. Everything here goes stale the
moment the next task lands; the previous version of this section named a scratch file
that had already been deleted and sent the next agent chasing it. Re-derive from the
gates instead — they are the only source of truth.

- Branch `feature/foundation` (master is the untouched base). Do not implement on master.
- **Tasks 1–8 of 20 are complete and diffed** (Task 8 = onboarding RPC, tenant data, audit and platform schema, plus a review-fix round). Task 9 is next. Run `git log --oneline` and `git status` before you start. Briefs, reports and review packages are in `.superpowers/sdd/cliniccore-foundation/`.
- **A clean tree on this branch should be green on all six gates.** If you are not sure,
  run them rather than trusting a summary — including this one:
  `npm run typecheck && npm run lint && npm run check:secrets && npm run test &&
npm run build && npm run format:check`.
- **Run the gates LAST, immediately before the commit.** A doc or plan edit made after a
  green run re-breaks `format:check` and leaves the report claiming a `lint 0` it no longer
  has. This happened twice on Task 6. `npm run format` after any markdown edit.
- `supabase/migrations/` now holds `00100`–`00810` (extensions, core functions, identity/tenancy
  schema, tenancy hardening, authorization schema + platform seed, authorization functions and
  their two corrections, onboarding RPC, tenant data, audit/platform and the Task 8 hardening),
  all applied. RLS is **enabled deny-all** on all fifteen tables and there are **zero policies** —
  the policies are Task 9. `lib/supabase/`, `proxy.ts`, the route groups, `README.md` and the
  rest of `supabase/` do not exist yet.
- **SECURITY DEFINER means RLS is bypassed, so every helper must check membership itself.**
  `private.*` functions are owned by `postgres` and all tables have `relforcerowsecurity = false`,
  so Task 9's policies are **not** a backstop for them. Every definer function that **writes** rows
  for an organization must check `private.is_member` itself — `write_audit` and
  `next_sequence_value` shipped without it, and any tenant could falsify another tenant's audit
  trail or bump its MRN counter. (The rule is about _writers_, not every helper taking an
  organization id: `can`, `clinic_ids` and `is_member` must not check membership, because
  `is_member` **is** that predicate.) Task 9 is the first thing to touch grants on these tables —
  a stray `grant insert on audit_logs to authenticated`, or a `drop function` (which would drop the
  grants `create or replace` silently preserves), reopens the hole silently. `audit_logs` and
  `platform_settings` deliberately carry **no foreign keys** — a cascade would erase the trail
  when the tenant or the actor is deleted — and `authenticated`'s INSERT/UPDATE/DELETE on
  `audit_logs` is revoked so append-only does not depend on Task 9 writing no policy.
  **Whether PostgREST exposes the `private` schema at all is UNRESOLVED**
  (`pgrst.db_schemas` is unreadable from SQL); if it does not, Task 12 needs `public` wrappers.
- **Four rulings from Tasks 5–7 that later tasks must not re-litigate.** (1) No database-layer
  check can unforgeably identify the service role under PostgREST (`authenticator` holds SET
  on `service_role` by design), so role checks such as `guard_platform_admin` are
  defence-in-depth, not boundaries — see `docs/IMPLEMENTATION_STATUS.md`, Task 5. (2)
  `private.can` is **org-strict and platform-key-refusing**: it admits only roles of the organization being asked about _and_ refuses any key whose lower-cased form starts `platform.` (`lower(p_permission) not like 'platform.%'`). Both clauses are load-bearing — org-strict alone left a tenant able to attach `platform.tenants.manage` to its own role, because `permissions` is one global table with no scope column — and `lower()` is there because the grant match is exact text, so without it a key spelled `Platform.tenants.manage` would both insert and match. So a platform role or platform permission is unreachable through `can` however it is attached, and `guard_role_org_scope`'s `organization_id IS NULL` allowance is inert. Do not "simplify" either clause away. Task 9 must still keep `roles` INSERT/UPDATE policies at `organization_id is not null`, give `role_permissions` a policy that reaches the organization through `roles` (it has no `organization_id` column) and refuses `platform.%` keys, and leave `permissions` **deny-all or read-only** — it is a reference table, and a tenant able to insert a key is what makes the case variant worth defending at all. (3) `private.clinic_ids` returns the **empty set** to a non-member and never filters `clinics.is_active` — a deactivation must not erase access to retained records. (4) **Three of the four helpers require `organizations.status = 'active'`** (a join on `organizations` in `current_org_ids`, `is_member` and `clinic_ids`; `can` inherits it through `is_member`), so suspending or archiving a tenant actually cuts PHI access. `private.is_platform_admin` deliberately does **not** check it — a platform operator must keep seeing suspended tenants in order to restore them. Do not "fix" that into a lockout; Task 9's `organizations` policy needs an `is_platform_admin()` branch, or an operator will see zero tenants. Task 9 must write clinic-scoped policies as a three-clause **conjunction** (`current_org_ids`, `can(org, perm, row_clinic_id)`, `clinic_ids`): the two-argument `can()` returns no rows, and that silent failure is what invites loosening `can` into a cross-clinic leak. The plan's live-DB test suites are discharged as controller-run catalogue rehearsals plus runnable `tests/unit/*.test.ts` text assertions; there is no DB connection vitest can reach — read the layout note in the plan before writing any test. Function-body assertions must go through the test's `latestDefinition` helper, which reads every migration in filename order — an assertion that reads one file directly will silently miss a later correction migration.
- **Rehearsal trap:** `set_config('request.jwt.claim.sub', …, true)` is transaction-local, so
  two identity probes batched into one Composio MCP call share a transaction and the **last
  identity wins**. Probe one identity per call or you will measure your own batching (this
  reported an active member as a non-member).

## Commands

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint . && npm run check:secrets && npm run format:check
npm test               # vitest run
npm run build          # next build (Turbopack); runs typecheck itself
npm run format         # prettier --write .
```

Run in that order before claiming done. Two things catch people out:

- **`lint` is three gates, not one.** A green `eslint` pass tells you nothing about the secret gate or formatting. `npm run lint` exits non-zero on any of the three; read the `check:secrets OK` line separately to know the security half passed.
- **`build` type-checks too**, so a typecheck failure shows up twice. Don't fix it in two places.

Focused runs:

- `npm run test:unit`, `npm run test:integration`, `npm run e2e`
- Single file: `npx vitest run tests/unit/cn.test.tsx`
- Playwright against a server you already started: set `PLAYWRIGHT_BASE_URL`.

## Framework and toolchain traps

These were all measured. Each one silently produces a green build and a wrong result.

- **Next.js is 16.4.0, not the Next.js in your training data.** Read `node_modules/next/dist/docs/` before writing app code. Notably: session refresh goes in **`proxy.ts` at the repo root, not `middleware.ts`** (see `01-app/03-api-reference/03-file-conventions/proxy.md`).
- **TypeScript is pinned to `6.0.3`. Do not upgrade it to 7.x.** typescript-eslint's supported range is `>=4.8.4 <6.1.0`; on TS 7 ESLint cannot even load its config and `npm run lint` dies. Revisit only when typescript-eslint#10940 ships, and re-measure rather than assume. Rationale and evidence: `docs/IMPLEMENTATION_STATUS.md`.
- **`exactOptionalPropertyTypes: false` is deliberate**, not an oversight. Third-party prop types (shadcn, `@supabase/ssr`, React) reject it. There is a revisit condition in the status doc.
- **`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` are all on.** The comment in `tsconfig.json` explaining the one exception is a real `//` comment — TypeScript 6 accepts comments but rejects a `"// ..."` JSON _key_ with `TS5023`.
- **Tailwind v4: there is no `tailwind.config.js`.** Design tokens live in `app/globals.css` (`@theme inline`), loaded as a PostCSS plugin.
- **`app/shadcn.css` is vendored on purpose.** Do not "restore" `@import "shadcn/tailwind.css"` — it puts a devDependency on the build-time CSS resolution path and breaks `--omit=dev` production builds. The vendored file exists to supply the `@custom-variant data-open` / `data-closed` that `alert-dialog.tsx` drives its animation from; deleting it fails no build and only kills the dialog animation.
- **Font variable name is `--font-geist-sans`,** emitted by `next/font` in `app/layout.tsx`. `--font-sans` and `--font-heading` in `@theme inline` point at it. Making `--font-sans: var(--font-sans)` self-referential resolves to the guaranteed-invalid value and silently drops every heading to the system font — no error anywhere.
- **A `"use client"` file must never import from `lib/supabase/`.** `check-no-secrets` rule 3 is the backstop, but `import "server-only"` as the **first line** of `lib/supabase/server.ts` is the real boundary — it fails at bundle time. Do not treat a green `check:secrets` as proof the boundary is sound.
- **`SUPABASE_SERVICE_ROLE_KEY` may only be referenced from `lib/supabase/server.ts` or under `tests/`**, and never from a `"use client"` file. Rule 4 (hard-coded `sb_secret_…` / `eyJ…` literals) applies everywhere including `tests/` with no path exemption — test fixtures build secret-shaped strings at runtime instead. `.env.example` is scanned like any other file; it is the only tracked env template.
- **`shadcn add` re-emits `import { cn } from "cn"`** — the unrelated npm package, whose merge engine does not know this project's custom colours and therefore cannot collapse `bg-primary` against `bg-success`. CSS source order then decides the colour. This is now a hard ESLint error (`no-restricted-imports`, scoped to `components/**` and `app/**` in `eslint.config.mjs`), so repoint generated files at `@/lib/utils/cn` and let lint tell you when you forget. `components.json`'s `aliases.utils` is set correctly and is **not** a defence — the CLI emitted the bad import anyway. The assertion in `tests/unit/cn.test.tsx` stays because it also covers the `package.json` dependency entry, which ESLint cannot see.
- **`components/ui` is in `.prettierignore` on purpose** — generated code is kept byte-for-byte as the CLI emitted it so the diff against a fresh `shadcn add` stays meaningful. Lint and tests still cover those files; only formatting skips them. Do not "fix" formatting there.
- **Vitest's `include` glob must keep `.tsx`.** A `*.test.ts`-only glob reports success while skipping every component test. Do not narrow it.

## Testing quirks

- `vitest.config.ts` runs in `jsdom` so shadcn components can render.
- `tests/e2e/` and `tests/integration/` currently hold only tracked placeholders. Playwright browsers are **not installed** — run `npx playwright install` before the first real E2E spec.
- The `e2e` / `test:e2e` scripts carry `--pass-with-no-tests` as a temporary measure. **Task 15 removes it** when it adds the first real spec; after that an empty spec set must be a hard failure again.
- Playwright's `webServer` runs `npm run build && npm run start`, not `dev`, so a build-time break cannot hide from E2E.
- A scratch measurement file must never be left in `tests/` (see Current state). That is how the current red gates happened.

## Supabase and Composio MCP

**Migrations are applied through the Composio MCP**, not `supabase db push` — there is no Supabase PAT. Files in `supabase/migrations/` are the source of truth; Composio is only the applier.

- Tool: `SUPABASE_APPLY_A_MIGRATION` (`ref`, `name`, `query`, `idempotency_key`). Project ref is in `.env.local` as `SUPABASE_PROJECT_REF`.
- Fall back to `SUPABASE_BETA_RUN_SQL_QUERY` only when the applier rejects `DO $$` blocks.
- **Never trust the apply response body.** Verify every apply by querying `information_schema` / `pg_catalog` / `pg_policies`.
- Guard policy and extension DDL in `DO $$ … $$` against `pg_catalog`; `SUPABASE_APPLY_A_MIGRATION` can reject `IF NOT EXISTS` policy DDL with SQLSTATE 42601.

Connected Composio apps: **supabase, github, cloudflare, firecrawl, tavily, neon, instagram, payhip**. Reach for these instead of writing bespoke API calls. Check what is actually connected before assuming a toolkit is available.

## How to work here. DO NOT SKIP THESE STEPS

1. **Invoke the relevant skill before writing or editing any code.** Skills live in `C:\Users\USER\.agents\skills` and `C:\Users\USER\.config\opencode\skills`. OpenCode also ships skills for Next.js, Tailwind, shadcn, testing and security — check before assuming none applies.
2. **Use the context7 MCP for anything involving an official library doc** (`tools.context7["resolve-library-id"]` then `tools.context7["query-docs"]`), especially Next.js 16, Tailwind v4, shadcn, `@supabase/ssr` and Vitest. Do not answer from memory — this stack has moved past what training data covers.
3. Use the relevant plugins/extensions when they help; do not bolt them on unasked.
4. Task work in this repo follows the SDD flow in `.superpowers/sdd/cliniccore-foundation/`: read the task brief, implement, then run all four gates and record the outcome.
5. Prefer measurement over assertion. This project's history is a run of implementers reporting results their own change had invalidated — when a change invalidates a measurement, re-run it and correct the write-up rather than restating it.
6. **DO NOT WRITE NUMEROUS COMMENTS IN THE CODE. IF IT IS REQUIRED TO WRITE COMMENTS, WRITE IT AT THE TOP TO DESCRIBE WHAT THE CODE DOES AND WHAT IS IT USE FOR.**

## AGENTS.md hygiene

- `next dev` owns the `<!-- BEGIN:nextjs-agent-rules -->` … `<!-- END:nextjs-agent-rules -->` block below and re-adds it if you delete it (`node_modules/next/dist/server/lib/generate-agent-files.js`). Content outside the markers is preserved verbatim — put your content outside them and commit the block with your work to keep the tree clean.
- Do not duplicate what `docs/IMPLEMENTATION_STATUS.md` already records. Link to it instead.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
