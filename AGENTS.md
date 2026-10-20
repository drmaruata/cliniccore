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

- **Branch `feature/foundation` (master is the untouched base). Do not implement on master.**
  **Tasks 1–13 of 20 are complete** (13 = typed errors, validation schemas, and the
  revalidating active-org resolution). **Task 14 is next.** Run `git log --oneline` and
  `git status` before you start. Briefs, reports and review packages are in
  `.superpowers/sdd/cliniccore-foundation/`.

  A third review found this section claiming Task 11 was next and that `lib/supabase/`
  and `proxy.ts` “do not exist yet” — while a LATER section of this same file described
  them as landed. The file that tells the next agent what to do next was wrong about what
  to do next. If you find a contradiction here, believe the gates and `git log`, not this
  section.

- **A clean tree on this branch should be green on all six gates.** If you are not sure,
  run them rather than trusting a summary — including this one:
  `npm run typecheck && npm run lint && npm run check:secrets && npm run test &&
npm run build && npm run format:check`.
- **Run the gates LAST, immediately before the commit.** A doc or plan edit made after a
  green run re-breaks `format:check` and leaves the report claiming a `lint 0` it no longer
  has. This happened twice on Task 6. `npm run format` after any markdown edit.
- `supabase/migrations/` now holds `00100`–`01240` (extensions, core functions, identity/tenancy
  schema, tenancy hardening, authorization schema + platform seed, authorization functions and
  their two corrections, onboarding RPC, tenant data, audit/platform and the Task 8 hardening,
  then the four Task 9 RLS migrations plus `01210`'s identifier correction, `01220`'s privilege
  gates, `01230`'s role guard and `01240`'s grant ceiling, then `01300`'s storage buckets,
  `01400`/`01410`'s storage hardening and `01420`'s MIME allowlist and path guard), all applied —
  25 history rows, all named by filename. **RLS is no longer deny-all: 39 policies across 14 of
  the 15 tables**, asserted exactly (name, command, non-null predicates, and the total) by
  `tests/security/rls-policies.test.ts`. `tenant_sequences` has **zero** policies and revoked
  writes by design; its only writer is the `next_sequence_value` definer. `lib/supabase/`,
  `proxy.ts`, the route groups and the rest of `supabase/` do not exist yet. **Storage:** five private
  buckets (`patient-documents`, `clinical-attachments`, `investigation-reports`, `org-assets`,
  `prescription-documents`), all `public = false`, 20 policies on `storage.objects` all `to
authenticated`, and `allowed_mime_types` = PDF/JPEG/PNG/DICOM/text. Object tenancy is the
  object NAME (`<org>/<clinic>/<file>`, `<org>/<file>` for org-assets) because a text path cannot
  carry a foreign key — so the project's composite-tenant-FK rule is satisfied here BY POLICY,
  not by constraint.
- **Task 9 was reviewed and fixed (`01220`). Four lessons bind later tasks.**
  (1) **A permissive `USING` is a hole even when the `WITH CHECK` is tight** — a review probe
  showed a member holding _no role at all_ rewriting `organization_memberships.user_id` and
  enrolling an arbitrary account into the tenant. Gate **writes** on a _permission_; bare
  `is_member` is only ever right for reading a tenant's own directory. (2) **Ask what a
  cascade removes, not just what the statement touches** — deleting a seeded role cascaded away
  the deleter's own `settings.manage`, and re-creating a role _requires_ it, leaving the tenant
  with no administrators and no client repair path. **But note how that first fix FAILED:** it
  gated the delete on `is_system is not true`, and `scripts/gen-permissions-sql.ts` populates that
  column from `role.isPlatform`, so **every tenant-seeded role is `is_system = false`** and the
  clause was a no-op. The test that "proved" it hand-seeded `is_system = true` — a state no
  production path produces. `01230` replaces it with `not private.role_in_use(id)`, the actual
  invariant. **Before gating on a column, find what populates it and prove the values your
  fixture asserts are the values the product produces** — a fixture that hand-builds a state no
  code path can reach will prove anything you like. **This is now a three-way disagreement** about
  `roles.is_system`: the plan says "marks seeded roles", the generator emits `isPlatform`, and
  `01230` no longer relies on it. Reconcile before trusting it again. (3) **A refusal-only suite
  cannot tell a working policy from a missing one.** Replacing three write policies with
  `with check (false)` left the policy count and the non-null assertions intact and every test
  green, with three tables permanently unwritable; a re-review later neutered **seven** command
  policies the same way. **Every refusal needs an authorised-write positive control beside it** —
  and for INSERT that control is the _only_ thing distinguishing a refusing policy from a deleted
  one, since both raise the identical message. (4) **Three refusal shapes, three assertion
  shapes:** an RLS `USING` miss **filters** the row out (`toEqual([])`), while a failed
  `WITH CHECK` and a trigger both **raise** (`expectRejection`). Getting this wrong produced three
  false failures in this task alone.
- **Three traps Task 9 added, each of which produced a wrong measurement before it produced
  a failure.** (1) **The applier derives `schema_migrations.version` from a second-resolution
  timestamp**, so two applies batched into one Composio call collide on `schema_migrations_pkey`
  (23505); `idempotency_key` does not prevent it. **One apply per call, always.** (2) **`resetRole()`
  returns to the session user**, which is postgres — the table owner, which bypasses RLS. A test
  that calls it before asserting measures postgres, not the principal, and passes for the wrong
  reason; one Task 9 assertion did exactly that. (3) **RLS filters a non-permitted UPDATE/DELETE
  out of the row set instead of raising** — the statement succeeds and affects zero rows, so "it
  threw" is the wrong assertion; assert on the RETURNING rows and on the unchanged value, or you
  will also pass against a policy set that filtered nothing and failed for an unrelated reason.
  A fourth: a staged fixture throw outside the caller's `try`/`finally` leaks one of the pool's
  four connections and every later test then times out — presenting as a slow suite rather than as
  the constraint violation that broke it.
- **SECURITY DEFINER means RLS is bypassed, so every helper must check membership itself.**
  `private.*` functions are owned by `postgres` and all tables have `relforcerowsecurity = false`,
  so Task 9's policies are **not** a backstop for them. Every definer function that **writes** rows
  for an organization must check `private.is_member` itself — `write_audit` and
  `next_sequence_value` shipped without it, and any tenant could falsify another tenant's audit
  trail or bump its MRN counter. (The rule is about _writers_, not every helper taking an
  organization id: `can`, `clinic_ids` and `is_member` must not check membership, because
  `is_member` **is** that predicate.) Task 9 has now taken those grants, and the standing
  caution is why they matter: a stray `grant insert on audit_logs to authenticated`, or a `drop function` (which would drop the
  grants `create or replace` silently preserves), reopens the hole silently. `audit_logs` and
  `platform_settings` deliberately carry **no foreign keys** — a cascade would erase the trail
  when the tenant or the actor is deleted — and `authenticated`'s INSERT/UPDATE/DELETE on
  `audit_logs` is revoked so append-only does not depend on Task 9 writing no policy.
  **PostgREST exposes the `public` schema ONLY** — resolved by measurement, not inference:
  `GET /rest/v1/` returns `info.title = "standard public schema"` and lists the 15 public
  tables plus one Supabase helper RPC; `POST /rest/v1/rpc/<fn>` against any `private.*`
  function returns PGRST202 naming **`public`** as the schema it searched. So **all twelve
  `private.*` helpers are unreachable from the browser, including
  `create_organization_with_owner`** — Task 12 must add `public` wrappers (the smaller
  change, and it keeps the authorization primitives in one place). Two traps when re-checking:
  `pgrst.db_schemas` is unreadable from SQL, and **a PowerShell `Set-Content -Encoding utf8`
  body carries a UTF-8 BOM**, which makes PostgREST answer PGRST102 "Empty or invalid json" —
  indistinguishable from "function not found", and it produced exactly the opposite answer
  here on the first attempt. Write bodies with
  `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`.
- **Four rulings from Tasks 5–7 that later tasks must not re-litigate.** (1) No database-layer
  check can unforgeably identify the service role under PostgREST (`authenticator` holds SET
  on `service_role` by design), so role checks such as `guard_platform_admin` are
  defence-in-depth, not boundaries — see `docs/IMPLEMENTATION_STATUS.md`, Task 5. (2)
  `private.can` is **org-strict and platform-key-refusing**: it admits only roles of the organization being asked about _and_ refuses any key whose lower-cased form starts `platform.` (`lower(p_permission) not like 'platform.%'`). Both clauses are load-bearing — org-strict alone left a tenant able to attach `platform.tenants.manage` to its own role, because `permissions` is one global table with no scope column — and `lower()` is there because the grant match is exact text, so without it a key spelled `Platform.tenants.manage` would both insert and match. So a platform role or platform permission is unreachable through `can` however it is attached, and `guard_role_org_scope`'s `organization_id IS NULL` allowance is inert. Do not "simplify" either clause away. Task 9 kept `roles` INSERT/UPDATE policies at `organization_id is not null`, gave `role_permissions` a policy that reaches the organization through `roles` (it has no `organization_id` column) and refuses `platform.%` keys — with `lower()`, because the plan's plain `not like` would admit `Platform.tenants.manage` and leave `can`'s lower-case as the only remaining defence — and left `permissions` read-only with its writes revoked. (3) `private.clinic_ids` returns the **empty set** to a non-member and never filters `clinics.is_active` — a deactivation must not erase access to retained records. (4) **Three of the four helpers require `organizations.status = 'active'`** (a join on `organizations` in `current_org_ids`, `is_member` and `clinic_ids`; `can` inherits it through `is_member`), so suspending or archiving a tenant actually cuts PHI access. `private.is_platform_admin` deliberately does **not** check it — a platform operator must keep seeing suspended tenants in order to restore them. Do not "fix" that into a lockout; Task 9's `organizations` policy ORs in `private.is_platform_admin()` so an operator still sees the suspended tenants they exist to restore, and a test asserts they do. Clinic-scoped policies are a three-clause **conjunction** (`current_org_ids`, `can(org, perm, row_clinic_id)`, `clinic_ids`): the two-argument `can()` returns no rows, and that silent failure is what invites loosening `can` into a cross-clinic leak. `tests/security/rls-policies.test.ts` pins **each clause separately** — one user whose only defence is `can`, one whose only defence is `clinic_ids` — because either clause alone is a cross-clinic leak. The one place the conjunction was deliberately _not_ used is `patient_identifiers`, which has no `clinic_id` and delegates both dimensions to the patients policies (correction `01210`); its original two-argument `can` clause silently hid every clinic-scoped reader's identifiers. Catalogue assertions now run as REAL integration tests: `tests/integration/` has a direct Postgres connection via `TEST_DATABASE_URL` (`tests/integration/helpers/database.ts`), which is the only way to read `pg_proc`, `pg_policies`, `pg_constraint` and `pg_index` - PostgREST returns none of them. With no `TEST_DATABASE_URL` they skip, but `CI=true` or `REQUIRE_TEST_DATABASE_URL=true` makes a missing URL FAIL so they cannot rot silently in CI. **Behavioural** assertions **now run too.** `set local role authenticated` plus `select set_config('request.jwt.claim.sub', $1, true)` inside a `pg` transaction reproduces the principal PostgREST builds from a JWT, and both are transaction-local so `rollback` restores them. `tests/integration/onboarding-rpc.test.ts` and `audit-log.test.ts` therefore exercise real behaviour and leave nothing behind. They still do **not** cover PostgREST itself — for that see the next bullet, which is measured rather than assumed. What this replaces is the older claim in `docs/IMPLEMENTATION_STATUS.md` that behavioural assertions "still cannot run"; that reasoning was from PostgREST and was simply wrong. The plan-named `tests/integration/migration-applier.test.ts` is **closed as obsolete** — its premise was that a Node script applies migrations, and it does not; the script emits a manifest and the agent applies through the MCP. Migration-source invariants remain runnable `tests/unit/*.test.ts`, which guard the file rather than the applied database; that is why the post-apply `md5(prosrc)` comparison is recorded per task. Function-body assertions must go through the `latestDefinition` helper, which reads every migration in filename order - an assertion that reads one file directly silently misses a later correction migration.
- **RLS has now been verified through the REAL path, not just the direct connection.** Every Task 9 test
  impersonated a principal over a `pg` connection running as the table OWNER, which BYPASSES RLS - a reasonable
  proxy, not the product. Verified separately with 3 real auth users, 3 real signed JWTs and HTTPS to
  PostgREST: a member sees only their own org's rows; a member who holds NO permission sees nothing even
  though they are a member; a non-member sees nothing; `auth.uid()` resolves from the JWT; and a permitted
  write actually **succeeds** over HTTP (1 row, value changed) while a cross-tenant write returns **0 rows
  with no error** and leaves the database untouched. JWT verification is real: signature flipped, forged
  signature, and **payload rewritten to `role: service_role` with the genuine signature all return 401**
  (PGRST301) - so the role claim cannot be tampered with. That is the HTTP-layer half of the Task 5 ruling
  that no database check can identify the service role: the signature does it, before any policy runs.
  Not covered: rate limiting, CORS, error-message leakage, load behaviour, or a PostgREST upgrade
  silently changing schema exposure. **Repeat the schema measurement if `db_schemas` is ever touched** -
  it is cheap and documented above.
- **Probing a real tenant over HTTP: delete children before parents.** `delete from organizations`
  alone leaves a probe tenant behind (`patients` and `clinics` block it), and a `.catch(() => {})` in the
  cleanup makes that invisible - it happened, and was caught only because the script printed its own
  residual row counts. Always report the residual.
- **PostgreSQL's `format()` fills `%s` POSITIONALLY and has NO declared parameter names.**
  Task 10 shipped a CRITICAL because 01300 selected between four policy templates with
  ONE shared argument list: the one-placeholder INSERT and DELETE branches consumed the
  first argument, which was the **read** predicate — so a read-only clinician could
  create and permanently delete PHI on three of five buckets. Named arguments are **not**
  the fix: `format($t$ %(bucket)L $t$, bucket => x)` fails with _"function format(text,
  bucket => unknown) does not exist"_ because `format()` is declared `VARIADIC "any"`.
  **The rule: one template per call site, each carrying exactly the arguments it
  consumes**, so no shared list exists for a branch to reach into.
- **A test control whose expected value is identical for a permitted and an unpermitted
  principal proves NOTHING.** Three times in Task 9/10 this bit: a "positive control" held
  only read permissions and so passed _because_ of the write bug; a control asserted a
  bucket was empty when the fixture seeded no rows, so its value matched a principal whose
  policy had been **deleted**; a control ran after `resetRole()` and so measured the table
  owner. **For every control, ask what it would return if the policy were DROPPED — not
  merely that it passes today.** And remember the two refusal shapes: an INSERT/UPDATE
  WITH CHECK failure and a trigger **raise**, while a policy `USING` miss on
  UPDATE/DELETE **filters to zero rows**. A refusal-only assertion cannot tell a refusing
  policy from an absent one.
- **`postgres` has `rolbypassrls = true`** — it bypasses RLS regardless of ownership, and
  `storage.objects` is owned by `supabase_storage_admin`, not `postgres`. So `resetRole()`
  before a measurement is worse than "no longer impersonating": it silently measures a
  role that bypasses RLS. Two further Task 10 traps: **`ALTER POLICY ... RENAME TO` needs
  table ownership and fails 42501** on Supabase-managed tables; and
  `storage.protect_delete()` refuses a direct DELETE on `storage.objects` for **everyone**
  unless `storage.allow_delete_query` is set, so every DELETE test must set that GUC or it
  measures the trigger instead of the policy.
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
- **`types/database.types.ts` is generated, and `prettier` reformats it.** Regenerating via
  `SUPABASE_GENERATE_TYPESCRIPT_TYPES` always produces a diff against the committed file —
  prettier adds member semicolons and collapses the leading `|` on union types. **That diff is
  expected; do not "fix" it and never hand-edit the content.** Verified equal: after stripping
  whitespace, semicolons and union pipes, both files hash to the same value. `types/` is
  deliberately _not_ in `.prettierignore` (unlike `components/ui`) so the format gate still
  covers a file the application imports.
- **`clinicDayBounds` walks for the day boundary, and the walk step is load-bearing — do not
  "optimise" it into a binary search or a local-midnight calculation.** Three wrong designs in a row:
  (1) subtracting the zone offset from a UTC-midnight guess assumes one instant reads `00:00:00` local,
  false where a DST transition lands _on_ local midnight — Havana, Santiago, Asuncion, Amman, Gaza,
  Jerusalem, St_Johns, three of them every year, **1 460 wrong boundaries and 97 windows that excluded
  their own input** over 37 zones × 1990-2031; (2) a binary search justified by "a local date only ever
  moves forward", which is false — a fall-back crossing local midnight moves it **backwards**, so the
  search converges on the LAST crossing, **57 more cases** across all 418 zones; (3) a 300-second walk
  step, which steps _over_ a 60-second run (St_Johns 2005-10-30) and returns a window that contains the
  instant but **spans the gap** — it passes containment and fails only a tiling check. The step is
  therefore **30 seconds**, a 2× margin under the measured shortest run, with a 32-hour sanity bound as
  backstop. **MEASURED: 601 920 samples over all 418 zones, zero failures; every zone tiles exactly;
  a third review probed ~28 million instants against three independent oracles and could not break it.**
  Cost: ~11 ms for the first call covering a `(zone, day)`, then ~5 µs memoised. The memo key
  deliberately excludes the hour — with the hour in it, a 30-day × 4-clinic report costs 2 880 cold
  keys and **~31 s** instead of 120 keys and **~1 s** (both measured). The key is sound only because
  every hit is containment-checked before use.

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

## Task 13+ : Supabase clients exist, and the browser CAN now onboard

`lib/supabase/` and the root `proxy.ts` landed in Task 12. Task 13 added typed errors, the
validation schemas, the revalidating active-org resolution, and the public RPC surface.
Consequences the next agent must not have to rediscover:

- **The browser CAN create an organization.** `public.create_organization_with_owner` was
  added as a thin wrapper over the `private` original, and PostgREST exposes the `public`
  schema, so a signed-in browser can call it. This is what unblocks Task 17's onboarding.
  `types/database.types.ts` is regenerated after every migration, so its `Functions` section
  is the list of what the browser can actually call.
- **The invitation-acceptance RPC must be a definer.** `organization_memberships` INSERT
  and DELETE are both closed by policy, so accepting an invitation cannot write the
  membership row as the caller.
- **`lib/supabase/server.ts` can only be tested through the `server-only` alias in
  `vitest.config.ts`.** The package's entry point THROWS on import outside a React Server
  Component bundler — that is the real boundary, not a lint convention — so without the alias
  to `tests/helpers/server-only-stub.ts` the module is unimportable from a test. It shipped
  with zero coverage while `getUser()` contradicted its own `Promise<User | null>`. If you
  add a server-side client and find it untestable, the alias is why, not a missing test.
- **An assertion that any leftover probe user exists is wrong under parallel vitest.** Test
  FILES run in parallel and two suites each create an auth user, so a global residue check
  makes every file fail on its neighbour's. Scope it to the ids the caller created.

## Task 14+ : the browser has an RPC surface now, and one tenant cannot be deleted

`lib/supabase/` and the root `proxy.ts` landed in Task 12. Task 13 added typed errors, the
validation schemas, and the revalidating active-org resolution. The public RPC surface
landed with it.

- **The browser CAN call RPCs.** `public.can`, `public.create_organization_with_owner` and
  `public.write_audit` are thin wrappers over the `private` originals, and the browser can
  reach them because PostgREST exposes the `public` schema. Measured over real HTTPS with a
  real user's JWT, in `tests/integration/public-rpc.test.ts`. The rule stays in ONE place:
  `userCan` asks `public.can` rather than reimplementing the permission check in
  TypeScript, which is how the rule came to exist twice and drift once.

- **Do not widen the `private` surface by accident.** Ten `private` functions are called by
  RLS policies and are evaluated as the QUERYING role, so revoking their EXECUTE would
  make every row INVISIBLE rather than every row denied - a silent total failure.
  `tests/integration/public-rpc-privileges.test.ts` asserts both the withheld set and the
  untouched set, because that distinction is invisible until it breaks.

- **An organization that has roles cannot be deleted.** `private.guard_role_delete`
  refuses to delete a role that still has grants or assignments, and it fires on a CASCADE
  delete of the organization too. MEASURED: every org the onboarding RPC creates has
  fourteen roles, so every org the product creates is undeletable. That matters for tenant
  offboarding and for a PHI system that may have to erase a tenant outright. The fix is to
  make the guard distinguish a cascade from a deliberate role deletion - a change to a
  security trigger, and therefore a separate piece of work with its own review.
