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
  **Tasks 1-17 of 20 are complete** (17 = the marketing shell and the platform-admin
  gate). **Task 18 is next.** Run `git log --oneline` and
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
- `supabase/migrations/` now holds `00100`–`01850` (extensions, core functions, identity/tenancy
  schema, tenancy hardening, authorization schema + platform seed, authorization functions and
  their two corrections, onboarding RPC, tenant data, audit/platform and the Task 8 hardening,
  then the four Task 9 RLS migrations plus `01210`'s identifier correction, `01220`'s privilege
  gates, `01230`'s role guard and `01240`'s grant ceiling, then `01300`'s storage buckets,
  `01400`/`01410`'s storage hardening and `01420`'s MIME allowlist and path guard, then the
  `01600`–`01710` public RPC wrappers and their corrections, then Task 16's `01720`
  invitations, `01730` digest correction, `01740` migration-history name fix, `01750` ceiling
  parameterisation, `01760` invitation ceiling, `01770` currency and locale, the round-2 fixes
  `01780` every grant path, `01790` the proven address, `01800` the creation cap's SQLSTATE and
  `01810` the restored pre-staging clause, the round-3 fixes `01820` the inviter is the
  caller, `01830` the helpers' privileges and `01840` the one membership rule, and Task 17's
  `01850` the platform console's two public functions, `01860`/`01870` the measurement
  probe that removes the console's guard and the correction that restores it, all
  applied — 60 history rows, all named by filename. **RLS is no longer deny-all: 39 policies across 14 of
  the 15 tables**, asserted exactly (name, command, non-null predicates, and the total) by
  `tests/security/rls-policies.test.ts`. `tenant_sequences` has **zero** policies and revoked
  writes by design; its only writer is the `next_sequence_value` definer. `lib/supabase/` and
  `proxy.ts` landed in Task 12; the `(app)` routes landed in Task 16. **Storage:** five private
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

## Task 12/13+ : Supabase clients exist, and the browser CAN now onboard

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

## Task 13+ : the browser has an RPC surface now, and one tenant cannot be deleted

`lib/supabase/` and the root `proxy.ts` landed in Task 12. Task 13 added typed errors, the
validation schemas, and the revalidating active-org resolution. The public RPC surface
landed with it.

- **The browser CAN call RPCs.** `public.can`, `public.create_organization_with_owner` and
  `public.write_audit` are thin wrappers over the `private` originals, and the browser can
  reach them because PostgREST exposes the `public` schema. Measured over real HTTPS with a
  real user's JWT, in `tests/integration/public-rpc.test.ts`. The rule stays in ONE place:
  `userCan` asks `public.can` rather than reimplementing the permission check in
  TypeScript, which is how the rule came to exist twice and drift once.

- **The `public` RPC surface is the browser's only door into the authorization primitives.**
  `public.can`, `public.create_organization_with_owner` and `public.write_audit` are thin
  wrappers over the `private` originals. The permission rule lives in ONE place:
  `userCan` asks `public.can` rather than reimplementing the check in TypeScript, which is
  how it came to exist twice and drift once. `private.write_audit`,
  `private.next_sequence_value` and `private.create_organization_with_owner` no longer have
  EXECUTE for `authenticated` - nothing calls them, and PostgREST's schema setting was the
  only thing containing them.
- **Do not widen the `private` surface by accident.** Ten `private` functions are called by
  RLS policies and are evaluated as the QUERYING role, so revoking their EXECUTE would
  make every row INVISIBLE rather than every row denied - a silent total failure.
  `tests/integration/public-rpc-privileges.test.ts` asserts both the withheld set and the
  untouched set, because that distinction is invisible until it breaks.
- **`userCan`'s clinic parameter is named `assignmentClinicId` because that is what it
  asks.** It answers whether a GRANT of a permission exists for a clinic, NOT whether the
  caller can reach that clinic - `private.clinic_ids` is the access half, and RLS enforces
  it. MEASURED: a user restricted to one clinic, holding an org-wide grant, answers true
  for a clinic they cannot read.
- **`private.next_sequence_value` has no public wrapper, and that is deliberate.** A raw
  counter BUMPER is an abuse vector. It matters because `patient_identifiers` INSERT is
  granted to `authenticated` and the column has no default calling the counter, so
  whoever builds patient registration must settle how the number is obtained.
- **An organization that has roles CAN be deleted, and this record was WRONG until
  Task 17's second review.** The original finding was that `private.guard_role_delete`
  fires on the CASCADE of the organization too, so every organization the product
  creates - fourteen roles each - was undeletable. **CORRECTED by
  `20261014001670` on 2026-10-20**: the guard now returns early when the role's
  organization no longer exists, which is the cascade of an organization's deletion
  rather than a deliberate attempt to delete a role that is still in use. A DELIBERATE
  role delete that still holds grants or assignments is still refused. MEASURED: the
  E2E runs leave 0 organizations behind, and Task 17's own records say so.
- **Tenant creation validates at the door AND in the table, on EVERY write path.** The
  slug is the tenant key used in URLs, so a slash in it breaks routing "far from here" -
  and the browser is now the only path that creates a tenant. CHECK constraints on
  `organizations` and `clinics`, plus a time zone TRIGGER on both tables, because a CHECK
  may not call a function that reads a table and the zone list is a view.
- **A clinic's time zone must be a CANONICAL IANA name, or `UTC`/`GMT`.** Not an
  abbreviation: `CST` is Central or China Standard, `IST` is India or Israel, and a
  clinic's BILLING DAY is computed in that zone. It is also the only form that is stable
  across tzdata releases. MEASURED: of the 598 names in `pg_timezone_names`, ICU rejects
  exactly one - `Factory`, PostgreSQL's own placeholder - so "the database knows the name"
  is not the same as "the application can use it".
- **The public surface CAN delete a tenant, and a created tenant is NOT undeletable.**
  `public.delete_organization(p_org_id)`, added by `20261014001692` on 2026-10-20,
  deletes an organization the calling user administers - it requires `settings.manage`
  in that organization - together with everything under it. The old record that
  `DELETE /rest/v1/organizations` as `service_role` returned 400 "role accountant is
  still in use" was true BEFORE `20261014001670` and is false now, for the reason above.
- **A clinic with NO time zone WAS a landmine, and the column is NOT NULL now.**
  `clinics.timezone` was nullable by design (migration 00300), and
  `Intl.DateTimeFormat` treats a nullish zone as "use the runtime's zone" rather than
  throwing - MEASURED - so such a clinic would have billed in the SERVER's day.
  **CORRECTED by `20261014001670` on 2026-10-20**: the column is `NOT NULL`, and a
  BEFORE INSERT trigger (`private.default_clinic_timezone()`) fills it from the
  organization's own zone, because a column default cannot express that zone. The claim
  that the column is still nullable is FALSE.
- **Audit metadata must be identifiers and codes, not phrases.** A string value with
  whitespace in it, or a key that names clinical free text, is refused - and the refusal
  names the key and the reason. This is a VALUE rule, not a key-name screen: the harm is in
  the prose, and a key-name screen cannot see it, so a misspelled key carrying a sentence
  used to pass. Audit metadata describes what HAPPENED, and a note that lands in
  `audit_logs` outlives the patient row it came from - the table has no foreign keys on
  purpose. Record an id or a code and resolve it. One residual: a single-word value that is
  not a free-text key name is indistinguishable from a code and passes.

## Task 14+ : the billing seam exists, and nothing about billing works

Task 14 added `lib/billing/provider.ts` (the contract and the factory) and
`lib/billing/unconfigured.ts` (the stub). It is a SEAM and nothing more. Consequences the
next agent must not have to rediscover:

- **BILLING IS NOT FUNCTIONAL, AND MUST NOT BE PRESENTED AS THOUGH IT IS.** Every method
  of the provider refuses with `PaymentNotConfiguredError`, `isPaymentConfigured()` is
  `false`, and there is no provider SDK, no HTTP client and no environment variable
  **in `lib/billing/`**. (Scoped to the seam, deliberately: `lib/supabase/server.ts` does
  import an HTTP client, `@supabase/ssr`, so the wider claim would have been false.)
  Pinned by `tests/unit/payment-provider.test.ts`.
- **THERE IS NO "TEST MODE", AND THERE MUST NEVER BE ONE - AND THAT IS NOW ENFORCED, NOT
  JUST DOCUMENTED.** The design spec forbids a mode that returns a successful fake
  payment, because a caller would then believe a clinic had been charged. The suite
  pins the seam's FILE LIST, each module's RUNTIME EXPORTS, the fact that every
  provider-like export is unconfigured and refuses, the fact that the seam reads no
  `process.env`, and a DENY-BY-DEFAULT IMPORT WHITELIST for the seam. A fake cannot be
  added without a test failing - MEASURED by mutation, including a fake exported from
  `unconfigured.ts` and a new file appearing in `lib/billing/`.
- **THE TEST IS SPLIT BY GUARANTEE, AND EACH TEST SAYS WHAT PHASE 8 MUST DO TO IT.** The
  first version carried several guarantees in one test, so a later phase that changed one
  of them would have taken the others with it. Phase 8 **REPLACES** the factory-bound
  refusal test, because a real provider stops refusing. The other guarantees **SURVIVE**,
  but Phase 8 must **EXTEND** four lists to add a provider: the seam's file list, the
  per-module export list, the seam's import whitelist, and the `lib/`-wide sanctioned
  package list. Extending a list is how a real provider is added deliberately - a fake
  cannot be added without a list changing.
- **ONBOARDING MUST NOT PRESENT A PAYMENT STEP** while only the seam exists. Where the
  chosen plan supports a trial, onboarding continues straight to clinic setup. This
  binds Task 17.
- **RAZORPAY WIRING IS PHASE 8 AND IS BLOCKED** pending test keys. The spec's own
  reasons for deferring it: the sandbox needs `subscription_plans`,
  `organization_subscriptions` and `subscription_usage` to exist, and webhook
  verification is security-sensitive code that deserves its own focused pass with
  adversarial tests - forged signature, replayed delivery, out-of-order event, duplicate
  idempotency key. Never record Razorpay as complete.
- **`isPaymentConfigured()` ASKS THE PROVIDER**, because a second source of truth about
  whether payments work is a second thing to get out of step with the first. The
  DERIVATION is pinned by a source-text check, not just the answer: a hardcoded
  `return false` passes every other test in the suite, because the provider and the
  answer would both be false.
- **`configured` IS A PROPERTY, NOT A METHOD**, so the boolean answer lives BESIDE the
  refusal contract rather than inside it. A method answering "am I configured?" would
  have to either break the contract (by answering) or answer nothing (by refusing).
- **MONEY IS THE HOUSE `Minor` TYPE** (`lib/utils/money.ts`), so the seam cannot describe
  an amount in anything but paise. `reasonCode` is a code and not a sentence - a
  CONVENTION, not an enforced rule, and nothing in the seam screens it.
- **`verifyWebhook` TAKES THE RAW BODY** - `string | Uint8Array`, exactly as it arrived.
  A signature is computed over bytes, so a payload that has been parsed and
  re-serialised is a different byte sequence and fails the check looking like a forgery.
- **`CheckoutSession.url` IS A HOSTED PAGE** on the provider's domain, not a client-side
  SDK payload. The seam is server-only, and describing an in-page checkout would put
  provider vocabulary into the browser.
- **`CheckoutInput` AND `RefundInput` CARRY AN `idempotencyKey`.** A caller that
  generates a fresh key on every retry gets a second charge.
- **`PaymentNotConfiguredError` LIVES IN `lib/errors.ts`**, extending `AppError` with
  status 500 and code `payment_not_configured` - 500 and not 503, because an
  unconfigured provider is a gap in this deployment rather than a temporary outage, and
  a 503 would promise that a retry might succeed. Both are pinned in `errors.test.ts`,
  because a mutation to 503 leaves the rest of the repository green.
- **THE SEAM IS SERVER-ONLY, ON EVERY FILE IN IT.** `import "server-only"` sits at the
  top of both `lib/billing/provider.ts` and `lib/billing/unconfigured.ts`, so a
  configured provider's secret key cannot reach a browser. The guard on the entry point
  is only meaningful if the file it reaches is guarded too, which is why the test checks
  every file under `lib/billing/`.
- **THE TYPES CARRY DOMAIN FACTS, NOT PROVIDER FACTS** - with one deliberate exception:
  `WebhookEvent.eventType` stays the provider's own vocabulary, because a seam that
  translated every provider's event names would be a second, lossy translation layer.
  The interpretation belongs to the subscription state machine that Phase 8 adds.
- **THE INTERFACE MEMBERS ARE PROPERTIES, NOT METHODS, ON PURPOSE.** `strictFunctionTypes`
  does not check the parameters of a METHOD declaration, so an implementation could
  narrow `verifyWebhook(payload: string | Uint8Array, ...)` to `string` and still
  typecheck - which is exactly the mistake the raw-body contract exists to prevent. As a
  property of function type, the parameter is checked contravariantly and the narrowing
  is a compile error.
- **A REFUND IS AGAINST A PAYMENT, NOT A CHECKOUT.** `CheckoutSession` and
  `WebhookEvent` carry `providerPaymentId`, and `RefundInput` names the payment being
  refunded. A provider refunds a payment, and a seam with no way to name the payment is
  a seam Phase 8 would have had to extend.
- **`PaymentVerificationError` IS THE FAILURE CONTRACT FOR A FORGED SIGNATURE.** A
  signature that does not verify must reject with it and must never resolve to an event.
  A provider that is UNREACHABLE is a different failure and must not be reported as this
  one - one is an attack, the other is an outage, and an operator reads them differently.
- **A CLIENT COMPONENT MUST USE A TOP-LEVEL `import type`.** `verbatimModuleSyntax` is
  on, so `import { type X } from "@/lib/billing/provider"` still EMITS a runtime import
  and still trips the server-only guard.
- **THE FAKE THE DESIGN SPEC ASKS FOR LIVES IN `tests/fixtures/`, NOT IN `lib/billing/`.**
  The spec wants subscription state "unit-tested against a fake"; the seam's pins forbid
  a fake inside `lib/billing/`, and that is deliberate - the fake belongs where the pins
  do not apply.
- **`lib/` MAY IMPORT ONLY THE PACKAGES ON A SHORT LIST.** `@supabase/ssr` and
  `@supabase/supabase-js` ARE HTTP clients, and they are on it deliberately - they are
  the sanctioned way for this application to talk to Supabase. The rule is that there is
  no OTHER way, so a new HTTP client in `lib/` is a test failure rather than a review
  comment. A RELATIVE import in `lib/` must also resolve inside `lib/` or `types/` - the
  latter holds the generated database types - so a vendored copy of a client cannot be
  reached that way either.
- **THE SEAM'S TYPE SURFACE IS PINNED AT COMPILE TIME, AND `npm run typecheck` IS THE
  GATE THAT ENFORCES IT.** A runtime test cannot hold a type still: `Object.keys` cannot
  see one. MEASURED - before this pin, a mutation that turned `RefundInput.amountMinor`
  from `bigint` into `number` left **every test in the repository green** and only
  typecheck could catch it.
- **PRETTIER 3.9.10 STRIPS THE PARENTHESES IN A CONDITIONAL TYPE'S `extends` CLAUSE, AND
  THAT CHANGES ITS MEANING.** The canonical `Equal<X, Y>` - written
  `(<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)` - comes back
  from `npm run format` with the right-hand parentheses removed, and the stripped form
  evaluates to `true` for EVERY pair. MEASURED, and it is the worst kind of bug: a
  control that reads like a working one. **The type pins in
  `tests/unit/payment-provider.test.ts` therefore use `Extends`, `Same` and `KeysAre`,
  which contain no function types.** Do not "simplify" them back to `Equal`.
- **A TUPLE, NOT AN INTERSECTION, FOR "EVERY ONE OF THESE".** `true & false` is still
  ASSIGNABLE to `true`, so a constraint of `extends true` is satisfied by an
  intersection containing a `false` - and the first version of the amount pins, which
  intersected them, caught nothing. A tuple of booleans fails the constraint properly
  and names WHICH position failed.
- **KEY SETS ARE CHECKED IN BOTH DIRECTIONS.** "Every expected key is present" is
  satisfied by a type that LOST a key, and "no unexpected key is present" is satisfied
  by one that GAINED a key. MEASURED: a mutation that removed `refundId` from
  `RefundResult` passed a one-directional pin.
- **THE EXPORTED PROVIDER IS FROZEN.** The stub is exported and the factory hands out
  that very object, so a caller holding it could `Object.assign` a working
  `createCheckout` onto it and every other caller would receive the fake. `Object.freeze`
  closes that, because a module is always strict and the assignment throws.
- **THE SEAM DESCRIBES A HOSTED CHECKOUT, AND THAT IS A REAL LIMIT.** `CheckoutSession.url`
  is a hosted page on the provider's domain. A provider whose only flow needs a
  publishable key and provider parameters IN THE BROWSER - Razorpay's Orders +
  `checkout.js` - is not describable by this seam as it stands, and Phase 8 must either
  use a hosted flow (a Razorpay Payment Link) or EXTEND the interface. Note that a
  publishable key is NOT a secret, so the server-only boundary is about the SECRET key
  and does not itself forbid one.
- **A REFUND NAMES THE TENANT AND THE PAYMENT; AN EVENT NAMES THE ORDER AND THE
  REFUND.** `RefundInput.organizationId` says whose money is being refunded;
  `WebhookEvent.refundId` is how a caller learns that an ASYNCHRONOUS refund finally
  succeeded or failed, which no return value can tell it.

## Task 15+ : the auth pages exist, and the signed-in application does not yet

Task 15 added the five auth routes, their four server actions, the code-exchange route
handler and the first E2E spec. Consequences the next agent must not have to rediscover:

- **THE URL CONTRACT IS `/app/...`, AND THE ROUTES DO NOT EXIST YET.** The plan states it
  three times: Task 15's brief ("assert `/app/dashboard` reachable"), Task 16's
  "Produces" line, and Task 16's Step 1 ("assert `/app` renders an onboarding screen").
  The plan's FILE TREE spells the directory `(app)`, but the same tree lists the auth
  group as `(auth)` while the brief lists those routes as `/login` - so the tree's group
  names are not url segments, and the prose is the contract. **Task 16 creates
  `app/app/...`**, and until it does, a successful sign-up lands on Next's 404 page.
  The E2E spec therefore asserts the ROUTE and the SESSION COOKIE, not the destination's
  content - the destination's content is Task 16's assertion, in Task 16's spec.
- **THE PASSWORD RESET NEEDS A DEPLOYMENT STEP, AND IT IS NOT DONE.** The recovery mail
  redirects to `${NEXT_PUBLIC_APP_URL}/api/auth/verify?next=/reset-password`, and
  GoTrue refuses to send to a redirect the HOSTED project has not allow-listed.
  `supabase/config.toml` only configures a local `supabase start` stack, so editing it
  does not change the live project. **The hosted project's redirect allow-list must
  include the app URL**, and until an operator does that, no reset mail is sent. Recorded
  as BLOCKED, not as working.
- **THE RESET MAIL CANNOT BE VERIFIED IN THIS ENVIRONMENT.** MEASURED: a reset request
  for an UNKNOWN address returns 200, and a request for a REAL account at
  `example.com` - where the E2E accounts live - is REFUSED, with the provider's code
  `email_address_invalid`. The cause was not established - "no MX record" is the likely
  one, and it is a guess, so it is not written down as a fact. What is measured is the
  difference: the provider only attempts a send for an account it knows. The spec
  therefore asserts the GENERIC response, which is the enumeration guarantee and the
  thing that is verifiable here; that a mail ARRIVES is not verifiable without a
  mailbox, and it is not claimed to work.
- **THE RESET EXCHANGE LIVES IN A ROUTE HANDLER, NOT A PAGE.** The recovery session has
  to be written as a COOKIE, and a Server Component cannot set cookies. So
  `app/api/auth/verify/route.ts` exchanges the code and redirects to a `next` that is
  matched against an ALLOW-LIST - a `next` from the query string that was not checked
  would be an open redirect. The reset PAGE then checks for a SESSION, which is a real
  check, where checking that a `?code=` parameter exists is not.
- **A PAGE TITLE MUST BE A HEADING, AND SHADCN'S `CardTitle` IS NOT.** `components/ui/
card.tsx` renders the title as a `div`, so a page whose title is a `CardTitle` has no
  heading at all - invisible to a screen reader navigating by heading, and to any test
  that looks for one. The auth pages wrap their titles in an `<h1>`.
- **`useActionState`'s DISPATCH RETURNS NOTHING, AND `isPending` NEEDS A TRANSITION.**
  `await formAction(data)` resolves at once, so a loading state built on awaiting it is
  dead. `isPending` - the third element of the hook - is the real signal, but ONLY when
  the dispatch runs inside `startTransition`. MEASURED with the repo's React 19.3.0: with
  the dispatch outside a transition, `isPending` never became true - the values were
  [false, false] - so the button never disabled, a double click fired TWO server
  actions, and React logged "An async function with useActionState was called outside of
  a transition" on every submit. All four forms dispatch inside `startTransition`.
- **A SERVER ACTION MUST ACCEPT `FormData` AS WELL AS AN OBJECT.** A form with an
  `action` and no `onSubmit` posts FormData, and a form with neither puts every field -
  including the password - in the query string, which is browser history, an access log
  and a Referer header. `lib/auth/action-input.ts` normalises both shapes.
- **THE PROVIDER'S RATE LIMIT IS SHARED AND THE E2E SPEC RETRIES.** The public signup
  endpoint allows about two or three calls a window, MEASURED, and the limit is per
  project, so it is shared by every address, every run and every browser project. The
  spec retries a refused call rather than failing on the limit.
- **THE PLAYWRIGHT BROWSER MUST MATCH `@playwright/test`.** The installed browsers are
  per-version, and a browser for an older Playwright leaves every spec failing to
  launch with "Executable doesn't exist" - which reads as a broken test rather than a
  missing browser. `npx playwright install` before the first E2E run.
- **THE E2E SPEC LEAVES NOTHING BEHIND.** It creates ONE account with the admin API,
  goes through the public endpoint exactly once, and removes both - the live database
  reads 0 auth users after a run.

## Task 16+ : the signed-in application exists, and the URL contract is `/app/...`

Task 16 added the application shell, organization onboarding, the tenant switcher and the
invitation flow. Consequences the next agent must not have to rediscover:

- **THE URL CONTRACT IS `/app/...` AND THE DIRECTORY IS `app/app/`.** The plan's file
  tree spells the group `(app)`, but the plan's own "Produces" line, Task 16's Step 1
  ("assert `/app` renders an onboarding screen") and Task 15's brief all say `/app/...`,
  and the same tree lists the auth group as `(auth)` while the brief lists those routes
  as `/login` - so the tree's group names are NOT url segments. **Task 16 therefore
  created `app/app/`, NOT `app/(app)/`.** The live routes are `/app`, `/app/dashboard`,
  `/app/onboarding`, `/app/settings/members` and `/invite/[token]`. A route group would
  have added a pathless directory level with no behaviour, so none was created. Task 17's
  marketing shell replaces the ROOT `app/page.tsx` (which still serves `/`).
- **THE SHELL HAS FOUR STATES, AND ONLY ONE OF THEM IS "NO ORGANIZATION".**
  (1) ZERO memberships -> the onboarding screen, rendered INSTEAD of the shell.
  (2) MEMBERSHIPS, BUT ALL OF THEM HIDDEN -> the "your access is not active" notice,
  NOT onboarding. A member of a SUSPENDED tenant, and a member whose own membership is
  suspended, see NO membership rows - `organization_memberships_select`'s row filter is
  `private.is_member(organization_id)`, which requires an ACTIVE membership in an ACTIVE
  organization - so an empty membership list does NOT mean "you belong to nothing".
  (This state did not exist when the section was first written: the shell then answered
  an empty list with the onboarding screen, and so offered to create a SECOND tenant to a
  member the database was hiding. `public.has_any_membership()` now answers the question
  RLS cannot, because a definer sees the hidden rows.)
  (3) SEVERAL active memberships and no choice -> the PICKER: the user has not chosen
  one, OR the `cc_active_org` cookie names an organization they have left. The house
  rule is that a stale cookie does NOT fall back to another tenant - the choice died, so
  the shell asks again.
  (4) An active organization -> the shell.
- **THE PLAN'S "CALL `requireActiveOrg()`" IS WRONG AS WRITTEN, AND THE CODE USES
  `getActiveOrg()`.** `requireActiveOrg()` THROWS when there is no active organization,
  so it cannot be the thing whose null result routes to onboarding. The brief settles
  it: the layout calls `getActiveOrg()`.
- **THE SIGN-OUT BUTTON IS A `type="submit"` BUTTON IN THE SHELL HEADER, SO A GENERIC
  `button[type="submit"]` SELECTOR IS AMBIGUOUS.** MEASURED: the first invitation E2E
  clicked the sign-out control instead of the invite form's, and the test failed on the
  sign-in page. The specs now click by ACCESSIBLE NAME.
- **INVITATION DELIVERY IS NOT IMPLEMENTED, AND THAT IS BLOCKED.** The owner-facing form
  on `/app/settings/members` DISPLAYS the invitation link for manual sharing and says
  so in the UI. There is no mail provider, no mail send, and no queue. A form that said
  "we have emailed them" would be a lie. The absence of delivery is recorded as BLOCKED
  in `docs/IMPLEMENTATION_STATUS.md`, not as a working notification.
- **THE RAW INVITATION TOKEN IS NEVER STORED.** `invitations.token_hash` holds a
  SHA-256 digest; the raw token exists only in the link the owner copies and in the
  redemption request. The owner hashes it in node (`createHash("sha256")`), the
  database hashes it again in `pg_catalog.sha256`, and the two must agree byte for byte.
  MEASURED: `92e2a3caaa3bec34d48004c7da4036f21c00828f51788c7650b9ee4ba5ef63d5` for
  `probe-token` in postgres AND in node. The E2E computes the digest a THIRD time and
  asserts the stored column against it.
- **`public.digest` DOES NOT EXIST ON THIS PROJECT, AND THE FILE THAT SAID IT DID WAS
  CORRECTED RATHER THAN EDITED.** MEASURED: pgcrypto is installed in the `extensions`
  schema, not `public` - migration 00100's `create extension pgcrypto with schema public`
  was SKIPPED because the extension was already there - so `public.digest(...)` raises
  `42883`. The acceptance function now uses the PostgreSQL BUILT-IN
  `pg_catalog.sha256(pg_catalog.convert_to(...))`, which has no extension and no schema
  to depend on. The correction is `20261014001730_invitation_digest_correction.sql`,
  because an applied migration is never edited. A plpgsql body is NOT validated at
  creation time, so the broken function was CREATED successfully and would have failed
  at the first acceptance.
- **THE INVITATION PATH HAD A GRANT-CEILING HOLE, AND IT IS NOW CLOSED IN SQL.**
  `private.can_grant` already refused an assignment whose role holds a permission the
  grantor does not, and the `user_role_assignments` INSERT policy uses it - but the
  ACCEPTANCE function is a definer, so it created the assignment with no policy in the
  way, and a staff manager could have invited a colleague into a role holding
  `settings.manage`, `patients.export` and `subscription.manage`. The new
  `private.can_assign_role` is `can_grant` PLUS the rule the registry cannot express
  (organization_owner and organization_admin carry byte-identical permission sets -
  MEASURED by migration 01240 - so the subset ceiling cannot tell them apart): only an
  existing organization_owner may grant organization_owner. The `invitations` INSERT
  policy calls it, and `public.grantable_roles` is the thin wrapper the UI asks.
- **THE INVITATION IS ACCEPTED BY A DEFINER, SO IT CHECKS EVERYTHING ITSELF.** A
  definer bypasses RLS, so RLS is not a backstop for it: the caller must be signed in,
  the token must hash to a row, the invitation must be unexpired and unused, the
  organization must be active, and the role must be one of THAT tenant's roles. The
  membership and the role assignment are created in one transaction, and the
  `accepted_at` stamp is taken with `where accepted_at is null` so two simultaneous
  acceptances cannot both win.
- **THE MEMBERSHIP IS REUSED, NOT DUPLICATED, ON ACCEPTANCE.** The unique constraint is
  `(organization_id, user_id)`, so a second membership row is impossible - and the
  function reuses an existing membership instead, which is what lets an invitation add
  a ROLE to somebody who is already a member.
- **THE ROLE ASSIGNMENT'S UNIQUE CONSTRAINT DOES NOT FIRE FOR A NULL `clinic_id`.**
  NULLs are distinct in a unique index, so two org-wide assignments of the same role to
  the same person are both allowed, and `on conflict` would not catch the second. The
  acceptance function guards with `where not exists (...)` instead.
- **THE INVITATION PAGE DOES NOT NAME THE ORGANIZATION, AND THAT IS DELIBERATE.** The
  `invitations` table is readable only by a holder of `staff.manage` in the owning
  organization, and the person opening the link is not a member yet - so the page says
  what is true without naming the tenant, and the organization becomes visible on the
  dashboard the moment the invitation is accepted. A preview RPC is a later task.
- **THE CLINIC SWITCHER IS A SECOND `cc_active_clinic` COOKIE, AND IT IS RE-VALIDATED
  ON EVERY READ.** The list it renders is the clinics the user can REACH, not the
  tenant's clinics: the `clinics` SELECT policy is `current_org_ids()` AND
  `clinic_ids(organization_id)`, so a membership scoped to one clinic sees one clinic
  here. The dashboard shows the active clinic, or "all clinics".
- **THE SWITCHERS ASK THE DATABASE, NEVER THE CLIENT.** The organization list is a
  MEMBERSHIP lookup (`listMemberOrgs`) and not a read of `organizations`: the
  `organizations` SELECT policy is `is_member(id) or is_platform_admin()`, so reading
  the table directly would hand a platform operator the whole tenant directory - right
  for the platform console, wrong for a switcher. Switching calls a server action that
  re-checks membership and then writes the cookie.
- **THE DASHBOARD SHOWS NO NUMBERS, BECAUSE THERE ARE NONE.** No patients, no
  appointments, no invoices - so the page shows the organization, the caller's own role
  assignments and an explicit empty state. A dashboard that shows "142 patients" would
  be a fabrication.
- **THE ROSTER SHOWS USER IDS, BECAUSE `profiles` IS READABLE ONLY BY ITS OWNER.** A
  member's name is not available to another member under the current privacy model, and
  `auth.users` is not readable by a client at all.
- **THE MIGRATION FILE IS `20261014001720_invitations.sql`, NOT THE PLAN'S
  `20261014001400`.** The plan's slot was taken by `20261014001400_storage_hardening.sql`,
  and two files carrying the same fourteen-digit version would make the filename order
  - the order `scripts/apply-migration.ts` applies in - ambiguous. Two more corrections
    follow it: `01730` (the digest) and `01740` (the migration-history row names, which
    the first two applies got wrong - the applier records the `name` it is given, and
    passing the bare stem instead of the file name broke
    `tests/integration/tenancy-schema.test.ts`, which asserts the history names every
    migration file exactly once).
- **THE PUBLIC RPC SURFACE NOW HAS TEN FUNCTIONS** (it had seven when this line was
  written; `has_any_membership` was added by `20261014001840`, and
  `is_platform_admin` and `tenant_directory` by `20261014001850`), and
  `tests/integration/public-rpc-privileges.test.ts` pins the list: `accept_invitation`,
  `can`, `create_organization_with_owner`, `delete_organization`, `export_patients`,
  `grantable_roles`, `has_any_membership`, `is_platform_admin`, `tenant_directory`,
  `write_audit`. `private.can_assign_role` and
  `private.assignment_target_is_member` are POLICY-referenced, so they must stay
  executable by `authenticated` - revoking either would make an assignment or an
  invitation write INVISIBLE rather than denied.
- **LOGIN DOES NOT CARRY A `next`, AND THAT IS A KNOWN LIMITATION.** The sign-in action
  always redirects to `/app/dashboard`, so an INVITED user - who has just been invited
  and has no organization yet - lands on the dashboard, sees the onboarding screen (or
  the suspended notice), and has NO ROUTE BACK to the pending invitation. The
  invitation link still works - it is a capability, and the invitee opens it directly -
  but the product does not carry the user from the sign-in page to it. A `next`
  parameter, matched against an allow-list, is the fix and it is a later task.
- **THE E2E CLEANUP NOW VERIFIES ITSELF.** `tests/helpers/e2e-cleanup.ts` deletes the
  children before the parents, deletes the audit rows (which have NO foreign keys) and
  the creation ledger (which has none either), and then RE-COUNTS what it removed and
  throws if anything survived. A cleanup that silently fails is worse than none.
  MEASURED: after the Task 16 runs the live database reads 0 organizations, 0 audit
  logs, 0 auth users, 0 invitations, 0 memberships, 0 assignments, 0 clinics and 1 role
  (the platform role). The `tenant_creation_events` ledger holds 29 rows, all from
  before this task.
- **THE `tenant_creation_events` LEDGER GREW BY TWO ROWS PER `npm run test`, AND THAT
  WAS A PRE-EXISTING LEAK IN `tests/integration/public-rpc.test.ts`.** The ledger has
  no foreign key, so the row `public.create_organization_with_owner` writes for each
  organization created survives the account and the organization that made it - and
  that file creates tenants over real HTTPS. MEASURED: the count went 29 -> 31 across
  one suite run, and the rows' `user_id` pointed at accounts that no longer existed.
  The cleanup now deletes the ledger rows for the accounts it deleted, and the count
  is stable across a run. The ledger is the rate-limit EVIDENCE for tenant creation,
  so leaving a probe's rows in it is not a neutral thing to do.
- **A `type="submit"` BUTTON IN THE SHELL HEADER IS A TRAP FOR ANY E2E SPEC.** The
  sign-out control is one, and it comes before the page's own forms in the DOM.
- **THE SHELL HAS A SIGN-OUT CONTROL, SO TASK 15's "THERE IS NO SIGN-OUT CONTROL" IS
  OUT OF DATE.** It is a form whose action is the `signOut` server action, it lands on
  the sign-in page, and `tests/e2e/onboarding.spec.ts` covers it. The auth spec still
  clears the cookies by hand, because that spec exercises the auth pages.
- **THE SHELL ONLY EXISTS FOR A USER WITH A TENANT.** A user with zero memberships
  gets the onboarding screen INSTEAD of the shell - so there is no sign-out control,
  no sidebar and no switchers on that screen. An E2E spec that wants the shell has to
  create an organization first.

## Task 16 review fixes : the invitation ceiling is closed, and the rules are PARAMETERISED

The Task 16 review found a privilege escalation in the invitation path and three gaps
around it. All of it is fixed; the facts a later agent must not have to rediscover:

- **THE ESCALATION WAS REAL, AND IT WAS IN THE UPDATE POLICY.** The ceiling was in
  the invitations INSERT policy only. `invitations_update` had no ceiling, and the
  UPDATE policy is what changes the role an invitation will hand out. So a
  `medical_director` (staff.manage plus the doctor's permissions, but not
  `settings.manage`, `billing.manage` or `subscription.manage`) could INSERT an
  invitation for `doctor`, UPDATE its `role_id` to `organization_owner`, and redeem
  the token it already held - `private.accept_invitation` is a definer, so no policy
  stood in the way, and it wrote the `user_role_assignments` row for
  `organization_owner`. **Fixed in both halves**: the UPDATE policy carries
  `private.can_assign_role(organization_id, role_id)`, AND the acceptance function
  re-checks the ceiling FOR `invited_by`.
- **THE RULES ARE NOW PARAMETERISED BY USER, AND `private.can` IS A DELEGATION.**
  `private.is_member`, `private.can`, `private.can_grant` and
  `private.can_assign_role` each delegate to a `*_for` sibling that takes the user as
  a parameter: `is_member_for`, `can_for`, `can_grant_for`, `can_assign_role_for`.
  **THE RULE NOW LIVES IN THE `*_for` FUNCTION** - `private.can` is a one-line
  delegation to `private.can_for((select auth.uid()), ...)`. A later agent reading
  `private.can` will see no rule in it at all, and the unit assertions in
  `tests/unit/authorization-schema-sql.test.ts` read the rule from `can_for` and pin
  the delegation separately. The `*_for` functions are NOT granted to `authenticated`:
  they answer questions about OTHER users, and only definer functions call them.
- **WHY THE PARAMETERISATION AND NOT A SECOND COPY OF THE RULE.** The acceptance path
  has to judge the INVITER, not the acceptor, and `auth.uid()` is the acceptor. A
  second copy of "does this user hold this permission" would be a second copy of the
  most important rule in the database - and this repository has already been bitten by
  exactly that twice (the platform-key clause, and the grant ceiling).
- **THE CEILING IS EVALUATED FOR THE INVITER AT REDEMPTION TIME**, so an invitation
  whose inviter has since lost the relevant permissions is refused. That is the
  fail-closed direction: a ceiling that a demotion could outrun would not be a
  ceiling.
- **MEASURED, THE MUTATION IS VISIBLE.** Replacing `private.can_assign_role` with
  `select true` and running `tests/security/rls-policies.test.ts` fails EXACTLY TWO
  tests - "refuses an invitation naming a role the inviter may not grant" and
  "refuses to move an invitation to a role the writer may not grant" - both with
  "expected a failure matching /row-level security/i but the statement succeeded",
  which is the escalation succeeding. The function was restored byte-for-byte
  afterwards: `md5(prosrc)` is back to `cb34fa61a9f9391554b600c3e005c78d`, and the
  whitespace matters - a one-line redefinition leaves a DIFFERENT md5.
- **AN INVITATION IS NOW BOUND TO THE ACCEPTOR'S ADDRESS.** The acceptance compares
  the stored `citext` address with `auth.jwt() ->> 'email'`, the ACCEPTOR's verified
  claim, and FAILS CLOSED when the claim is absent. So the stored address means
  something, the owner's roster stops showing "Pending" for ever, and a bearer of the
  link who is not the invited person gets nothing. The invite form therefore has to be
  given the INVITEE's own address, and the E2E spec uses the invitee's address for
  the invitation.
- **AN INVITATION THAT NAMES CLINICS IS REFUSED RATHER THAN OVER-GRANTED.**
  `invitations.clinic_ids` used to be ignored, and the acceptance created an
  ORGANIZATION-WIDE assignment - an over-grant. The foundation's invite form offers
  no clinic choice, so the honest behaviour is to refuse such an invitation.
  Honouring `clinic_ids` properly is a later task, and it needs `clinic_memberships`
  rows as well: without them `private.clinic_ids` falls back to ALL of the
  organization's clinics.
- **THE TENANT'S CURRENCY AND LOCALE ARE APPLIED NOW.** The public creation function
  takes `p_currency` and `p_locale` (both defaulted),
  validates them, and applies them to the new tenant in the SAME transaction as the
  creation. The PRIVATE creator is unchanged: its body holds the generated
  organization role seed, whose canonical home is `20261014000600_onboarding_rpc.sql`
  and whose drift guard reads THAT file - re-inlining a 250-line generated block in a
  second migration would leave the guard watching a historical definition. The
  four-argument public function was DROPPED (`create or replace` does not replace a
  changed signature, it creates an overload), and the types were regenerated.
- **A PUBLIC WRAPPER MAY NOW ADD OPTIONAL PARAMETERS**, and the mirror assertion in
  `tests/integration/public-rpc-privileges.test.ts` says so: the private original's
  argument list must be a PREFIX of the wrapper's, and every added parameter must
  carry a default. A wrapper may not change or drop any of the original's - that is
  what broke the first version of the creation wrapper.
- **`switchClinic` IS SCOPED TO THE ACTIVE ORGANIZATION.** The `clinics` SELECT
  policy spans every organization the user belongs to, so a lookup by id alone
  accepted the other tenant's clinic; the action now resolves the active
  organization and requires the clinic to be in it, and the dashboard's
  active-clinic lookup is scoped the same way. MEASURED by the E2E spec, which puts
  the other tenant's clinic into the control by hand and watches the refusal.
- **THE ONBOARDING ACTION MAPS THE CAP'S OWN SQLSTATE, `53400`**
  (`configuration_limit_exceeded`), not `23514`. The cap is five organizations per user
  per 24-hour window, and `23514` is `check_violation` - a CLASS that every other
  check violation in the database shares, so mapping it would have reported all of them
  as the cap. `23514` still has a mapping, and it is honest about being a class. (This
  line said `23514` when it was written; the cap was given its own code in
  `20261014001800`.)
- **THE TOKEN IS STILL IN THE URL, AND THAT IS A RECORDED RESIDUAL.** The invite page
  sends `Referrer-Policy: no-referrer` so the token does not leak to anything the page
  links to, but the URL is the plan's contract (`/invite/<token>`), so the token is
  in the browser's history and in any access log. A one-time code or a fragment would
  fix it and is a later task.
- **THE THREE NEW MIGRATIONS ARE `01750`, `01760` AND `01770`** - the ceiling
  parameterisation, the invitation ceiling and acceptance rewrite, and the currency
  and locale. All applied; the history now has 50 rows.

## Task 16 review, round 2 : ONE ceiling on EVERY path, and a PROVEN address

The second Task 16 review found that the ceiling was still two ceilings, that the
owner clause had no isolating test, and that the email binding was to a claim rather
than to a proven address. All of it is fixed.

- **THERE WERE TWO CEILINGS, AND THEY CONTRADICTED EACH OTHER.** The invitation path
  used `private.can_assign_role` - the SUBSET rule plus the owner-only clause - while
  `user_role_assignments_write` and `user_role_assignments_update` used
  `private.can_grant`, which is the SUBSET rule ALONE. And the subset rule cannot
  tell an `organization_admin` from an `organization_owner`, because they carry
  BYTE-IDENTICAL permission sets (MEASURED by migration 01240 itself). So an
  administrator could run one statement -
  `insert into public.user_role_assignments (organization_id, user_id, role_id) select
org, self, owner_role` - and become the tenant's owner, with `settings.manage`,
  `patients.export` and `subscription.manage`, and could then mint owners through
  the invitation path. **Both paths now call `private.can_assign_role`**, so there is
  ONE ceiling and the SUBSET rule still holds inside it.
- **THE OWNER CLAUSE HAS AN ISOLATING TEST NOW.** A granter who holds the owner's
  whole permission set but is not the owner - DAVE in the security fixture - is
  refused `organization_owner` on the DIRECT path and on the INVITATION path, each
  beside a positive control that a REAL owner is allowed. Every earlier refusal in
  that block was explained by the subset rule, so deleting the owner clause left the
  suite green.
- **MEASURED, THE OWNER CLAUSE IS MUTATION-VISIBLE.** Replacing
  `private.can_assign_role_for` with `select private.can_grant_for(...)` - which
  deletes the owner clause and leaves the subset rule - fails EXACTLY TWO tests:
  "refuses an administrator the owner role, and allows a real owner" and "refuses an
  invitation for the owner role whose inviter is not an owner", both with "expected a
  failure matching ... but the statement succeeded", which IS the escalation
  succeeding. The function was restored byte-for-byte: `md5(prosrc)` is back to
  `4a1f397ab625e129670c2de99a77eaf0`.
- **THE CEILING IS NOW ONE RULE, AND `private.can_assign_role` IS A DELEGATION.** The
  earlier claim that there was "still ONE copy of each rule" was FALSE of the ceiling:
  `can_grant` (the subset rule) and `can_assign_role` (the subset rule plus the owner
  clause) were two. Now `can_grant_for` owns the subset rule and
  `can_assign_role_for` owns the ceiling, and the two public entry points delegate.
- **`private.current_org_ids` IS NO LONGER A THIRD COPY OF THE MEMBERSHIP RULE.** It
  asks `private.is_member_for` for each organization now, so `is_member_for` owns the
  membership rule and the set version and the boolean version cannot disagree.
  **SUPERSEDED BY `20261014001840`, WHICH ALSO FIXED `private.clinic_ids`** - it
  re-derived the same rule in its `mine` CTE, so the rule had TWO copies and this
  section's claim that it had one was FALSE for `clinic_ids`. The unit assertion was
  pinning the duplicate, which made the duplication a requirement rather than an
  accident. `clinic_ids` asks `is_member_for` now too.
- **A CLAIM IS NOT A PROVEN ADDRESS.** The acceptance now requires the ACCEPTOR's
  ACCOUNT to be confirmed (`auth.users.email_confirmed_at is not null`) and to carry
  the invitation's address (`auth.users.email = the invitation's address`), and it
  FAILS CLOSED - no row, an unconfirmed address, or a different address are all a
  refusal. The claim check stays, because it binds the SESSION to the invitation.
  This matters because the signup action signs a user in immediately when "Confirm
  email" is off, which it is here - so anybody could otherwise register the invited
  address and redeem. The E2E probe account is now confirmed EXPLICITLY through the
  admin API, and the invitation spec passing is the proof that the account is
  confirmed.
- **A SUSPENDED MEMBER'S REDEMPTION NO LONGER BURNS THE TOKEN.** The acceptance
  refuses a membership whose status is not `active` - and it refuses BEFORE the
  acceptance stamp, so the invitation is still redeemable once the membership is
  active again. It does not quietly reactivate a suspended member either.
- **THE CURRENCY AND THE LOCALE ARE ASSERTED.** `tests/integration/
onboarding-rpc.test.ts` calls the public RPC with `p_currency`/`p_locale` and reads
  `organizations.currency` and `organizations.locale` back, because the function
  applies them AFTER the tenant exists and nothing else read them back.
- **THE CREATION CAP HAS ITS OWN SQLSTATE, `53400`** (`configuration_limit_exceeded`),
  because `23514` is `check_violation` - a CLASS, shared with every other check
  violation in the database - and the onboarding action was reporting all of them as
  "you have created five clinics in a day". The cap's rule now lives in
  `private.creation_cap_reached()`, so the rule and the code that reports it are in
  one place.
- **AN ACCEPTED INVITATION IS IMMUTABLE.** `invitations.accepted_at` was writable, so
  a staff manager could clear it and re-issue a redeemed invitation - and the raw
  token is the credential. The UPDATE policy now refuses any change to an accepted
  invitation.
- **A CONCURRENT ACCEPTANCE LOSES CLEANLY.** The membership insert's unique violation
  is caught inside the function and turned into the same refusal as a used
  invitation, and the action maps `23505` as a backstop.
- **RECREATING A POLICY FROM AN OLDER MIGRATION FILE LOSES CLAUSES.** `01780` wrote
  the assignment policies out from `01240`, which is NOT the version that was
  effective: `01660` had recreated them with
  `private.assignment_target_is_member(organization_id, user_id)` - the closure of
  gap A3, which stops an assignment being pre-staged for an account that belongs to
  no organization. `01780` dropped it, and the suite caught it: "A3: an assignment
  cannot be pre-staged for a user in no organization" failed with "expected a failure
  ... but the statement succeeded" - the policy had become PERMISSIVE, which is the
  direction that matters. The correction is `20261014001810`, and the lesson general:
  **before recreating a policy, read the LAST definition of it, not an earlier one.**
- **THE NEW MIGRATIONS ARE `01780`, `01790`, `01800` AND `01810`** - the ceiling on
  every grant path, the acceptance that proves the address, the creation cap's own
  SQLSTATE, and the restoration of the pre-staging clause. All applied; the history
  now has 54 rows.

## Task 16 review, round 3 : the inviter is the caller, the helpers' privileges are MEASURED, and the shell tells "hidden" from "absent"

The third Task 16 review found no blocker - Task 16 is judged done - but it left five
gaps and some false records. All of it is closed.

- **THE CEILING'S SUBJECT WAS A COLUMN THE CALLER SUPPLIED.**
  `private.accept_invitation` judges the ceiling for `invited_by`, and nothing
  constrained that column. No escalation was found - the `role_id` is still bounded by
  the CALLER's own ceiling at write time, and widening a role's permissions needs
  `settings.manage` - but two ceilings that can diverge is not a thing to leave in
  place. `20261014001820` adds `and invited_by = (select auth.uid())` to both
  invitations policies, so the ceiling at redemption is judged for the person who
  actually issued the invitation.
- **`private.assignment_target_is_member` WAS EXECUTE-able BY PUBLIC AND ANON.**
  MEASURED live before the fix: `anon_exec=true, pub_exec=true`. It answers "is user X
  an active member of organization Y" - the shape that was ruled unreachable when the
  `*_for` helpers were revoked - and it is a SECURITY DEFINER, so it reads the
  memberships table as postgres. What contained it was `db_schemas = public`, which is
  a CONFIGURATION SETTING and not a boundary. `20261014001830` revokes it from PUBLIC
  and ANON and grants it to `authenticated` explicitly - it is called by two policies,
  and a policy's expression is evaluated as the QUERYING role, so revoking it from
  `authenticated` would make every assignment write INVISIBLE rather than denied.
- **`private.can_grant` NOW HAS NO CALLERS, AND ITS EXECUTE IS REVOKED.** Since
  `20261014001780` every policy that grants a role calls `can_assign_role`, which is
  the subset rule AND the owner-only clause. `can_grant` is the SUBSET rule alone - the
  looser half - and it was executable by every signed-in role. A looser rule that is
  callable is a trap: the next policy to call it would enforce half the ceiling, which
  is exactly the hole the first review found. `20261014001830` revokes it from
  `authenticated` as well, and the catalogue test now pins that.
- **THE `POLICY_REFERENCED` INVENTORY IS NOW DERIVED FROM THE POLICIES, NOT HAND-KEPT.**
  The list had drifted in BOTH directions: `can_grant` was in it after it stopped being
  called, and `assignment_target_is_member` was MISSING although two policies call it.
  So the EXECUTE of either could have been revoked and every assignment or invitation
  write would have become invisible with no test failing.
  `tests/integration/public-rpc-privileges.test.ts` now derives the set from
  `pg_policies` and compares it with the list in both directions, and a new test pins
  the private helpers' EXECUTE to exactly the roles that need it.
- **`private.clinic_ids` RE-DERIVED THE MEMBERSHIP RULE, AND THE UNIT ASSERTION PINNED
  THE DUPLICATE.** Its `mine` CTE asked for "an active membership in an active
  organization" itself, while `private.is_member_for` owns exactly that rule - so the
  rule had two copies, and the test enforced the duplication. `20261014001840` makes
  `clinic_ids` ask `is_member_for`, and the unit assertion now pins the delegation and
  asserts that none of the three re-derives the rule.
- **THE SHELL COULD NOT TELL "NO MEMBERSHIP" FROM "A HIDDEN MEMBERSHIP".**
  `organization_memberships_select`'s row filter is `private.is_member(organization_id)`,
  so a member of a suspended tenant - and a member whose own membership is suspended -
  see no membership rows at all. The shell read the empty list as "you belong to
  nothing" and rendered the ONBOARDING screen, which OFFERED to create a second tenant
  to a member the database was hiding. `public.has_any_membership()` (a definer, so it
  sees the rows the policies hide, and it answers about the CALLER only) now tells the
  two apart, and the shell's fourth state says "your access is not active" instead of
  offering tenant creation.
- **THE NEW MIGRATIONS ARE `01820`, `01830` AND `01840`** - the inviter is the caller,
  the helpers' privileges, and the one membership rule with the shell's new state. All
  applied; the history now has 57 rows.
- **THE APP SHELL LIVES AT `app/app/`, AND THE PLATFORM CONSOLE AT `app/platform/` -
  BOTH REAL SEGMENTS, NOT ROUTE GROUPS.** The design spec's route table says the
  authenticated application is at `/app/...` and the operator console at `/platform/...`,
  and a route group is pathless, so a group named `(app)` would give `/dashboard` and a
  group named `(platform)` would give `/` - which would COLLIDE with the marketing root
  page. The spec's own table is the authority, and its parenthesised names are shorthand
  for "this subtree serves this url prefix". The plan's file list said `app/(app)/...` and
  the spec's tree said `(app)/`; BOTH have been corrected, because they contradicted the
  url contract that four separate statements in the two documents agree on. `app/app/` is
  the shape that satisfies the contract, and it is the only one that does.

## Task 17+ : the marketing shell and the platform console exist, and `/platform` is a REAL segment

Task 17 added the public marketing shell and the operator console. Consequences the
next agent must not have to rediscover:

- **THE MARKETING SHELL REPLACED THE ROOT PAGE, AND THE ROOT PAGE IS GONE.**
  `app/(marketing)/page.tsx` serves `/`, and `app/page.tsx` was DELETED. A route group
  is pathless, so the group adds no segment - and two pages serving `/` is a BUILD
  CONFLICT, not two routes. The ROOT layout (`app/layout.tsx`, which owns `<html>` and
  `<body>`) stays where it is: a route group cannot have a root layout.
- **THE PLATFORM CONSOLE IS AT `app/platform/`, A REAL SEGMENT - NOT
  `app/(platform)/`.** The same rule as the application shell: a pathless group would
  serve `/` and collide with the marketing root. The design spec's route table is the
  authority; its parenthesised names are shorthand for a url prefix.
- **`private.is_platform_admin()` IS UNREACHABLE FROM POSTGREST, SO
  `public.is_platform_admin()` WRAPS IT.** MEASURED (and already recorded above):
  PostgREST exposes the `public` schema only, and a POST to `/rest/v1/rpc/<fn>` naming
  a `private.*` function answers PGRST202 naming `public` as the schema it searched.
  The console's gate could not be evaluated at all until `20261014001850` added the
  wrapper. **Do not reimplement the predicate in TypeScript** - reading
  `profiles.is_platform_admin` in the application would put the rule in two places,
  which is how the platform-key clause and the grant ceiling each drifted once.
- **THE CONSOLE'S GATE IS TWO CHECKS, AND THE DATA-LAYER ONE IS THE ONE THAT MATTERS.**
  `app/platform/layout.tsx` calls the predicate and renders `notFound()` otherwise -
  that is what produces the 404 RESPONSE. `app/platform/page.tsx` asks
  `lib/auth/platform.ts` for the directory, and that module REFUSES to read it for an
  unauthorised caller. Next.js's own authentication guide is the reason: a layout does
  not control whether the rest of the route renders, and layouts do not re-render on
  client-side navigation. A gate that only hides the UI while the data is still read
  is not a gate.
- **THE DATA-LAYER REFUSAL IS NOW UNIT-TESTED, AND IT FAILS CLOSED ON A FAILED READ.**
  `tests/unit/platform-console.test.ts` stubs `lib/supabase/server` and asserts that
  `readTenantDirectory()` returns null for a caller who is not an administrator AND
  that the `tenant_directory` RPC is **never called** - the refusal is BEFORE the read,
  and a directory that was fetched and then discarded has still left the server.
  MEASURED: deleting the refusal line fails THREE of the five tests with "expected
  null but got rows" and "expected [ 'tenant_directory' ] to not include
  'tenant_directory'"; `lib/auth/platform.ts` was restored byte-for-byte
  (md5 `0CDA749F5DC889D5C6913BF704A485B1`). A failed READ now returns null as well -
  half a directory is worse than none, because the caller cannot tell a truncated
  answer from a whole one.
- **THE DIRECTORY'S MEMBER COUNT HAD TO BE TAKEN BY A DEFINER, AND THAT IS MEASURED.**
  `organization_memberships_select`'s row filter is `private.is_member(organization_id)`,
  so a principal who belongs to no tenant sees NO membership rows - **MEASURED: a
  platform administrator reads ZERO membership rows for a tenant with one member,
  while `public.tenant_directory()` reports that member as 1.** A count taken from an
  ordinary read would be zero for every tenant. `tests/integration/platform-console.
test.ts` pins both halves.
- **`public.tenant_directory()` RETURNS EXACTLY THREE COLUMNS - NAME, STATUS AND
  MEMBER_COUNT - AND THAT IS THE WHOLE BOUNDARY.** It cannot return an id, a slug or a
  clinical row, so "no patient data is reachable from this route" is a property of the
  function's SIGNATURE and not of a reviewer's reading of the page. The count is an
  aggregate: it says how many staff a tenant has, never who they are.
- **THE CONSOLE ANSWERS 404, NOT A REDIRECT.** A redirect would tell a clinic owner
  that something exists at `/platform`; a 404 does not. `notFound()` also makes Next
  emit a `noindex` robots tag, and the layout's own metadata says
  `robots: { index: false }`.
- **THE MARKETING PAGE IS PUBLIC AND READS NOTHING.** There is no session read
  anywhere in `app/(marketing)/` or `components/marketing/`: a header or a hero that
  changed for a signed-in visitor would disclose that somebody is signed in. The E2E
  spec asserts it - the public header still offers "Sign in" to a signed-in visitor,
  and the application shell's "Sign out" is absent.
- **THE MARKETING COPY MAKES NO CLAIM THAT HAS NOT BEEN VERIFIED.** No testimonials,
  no customer counts, no uptime, no certification - and no mention of patient records,
  appointments or payments, because NONE of those exist in this release. The four
  feature cards each name something the codebase can be asked about. Full copy and the
  page set are Phase 4; this is the visual foundation, and the footer says so.
  **AND THE COMPOSITE-KEY CLAIM IS NARROW ON PURPOSE.** MEASURED: of the 21 public
  foreign keys, **5 are composite** - the three that tie a row to another tenant's
  clinic, the one to a patient and the one to a membership. The three ROLE references
  are single-column, and a role's organization scope is closed by
  `private.guard_role_org_scope()` - a TRIGGER - and by the policies, not by the
  schema. So the copy names the references that ARE composite instead of claiming
  they all are.
- **`types/database.types.ts` WAS REGENERATED, AND THE GENERATOR'S OUTPUT HAS CHANGED
  SINCE THE FILE WAS LAST WRITTEN.** The committed file was byte-equal to the
  generator's output after stripping whitespace, semicolons and union pipes - that was
  MEASURED once, and it is now FALSE. MEASURED: the current generator emits a
  `Tables<>` helper with an extra fallback branch, an `Enums<>` keyed on `Enums` alone
  rather than on `Enums & CompositeTypes`, and `clinics.Insert.timezone` as REQUIRED
  (migration `01670` made the column NOT NULL, and the committed file predated it).
  The regenerated file is **307** characters longer after normalisation - MEASURED:
  13508 before, 13815 after, of which 129 are the two new RPC entries and 178 the
  generator's changed helper shape - and the normalised hash of the committed file and
  the generator's output now agree again. The app uses none of the changed helpers, so
  nothing broke - but the diff is REAL and is not formatting.
- **THE E2E SPEC FOR THIS TASK IS ONE FILE, `tests/e2e/platform-gate.spec.ts`, AND IT
  COVERS BOTH ROUTES.** The plan names one spec file, so the marketing shell's
  assertions live in it under their own `describe`. It creates its accounts through the
  ADMIN API (the public signup endpoint is rate limited to two or three calls a
  window) and sets `is_platform_admin` through the SERVICE ROLE - never from the
  browser, because `private.guard_platform_admin()` refuses any other writer.
- **THE OPERATOR IN THE E2E SPEC BELONGS TO NO TENANT, ON PURPOSE.** A member of the
  tenant it reads would see the member count whether the query were RLS-governed or
  not, so the count of 1 proves the definer path rather than the policy.
- **THE REFUSED PAGE IS PROVEN TO CONTAIN NO TENANT AT ALL - NOT ONLY THE CALLER'S
  OWN.** The owner's test seeds a SECOND tenant it has no membership in and asserts
  that name is absent too, because asserting only the caller's own tenant would pass
  for a console that leaked every OTHER tenant and none of the caller's.
- **THE RPC SURFACE IS PROVEN OVER REAL HTTP FROM A NON-ADMINISTRATOR, BECAUSE THE
  E2E CANNOT REACH THAT PATH.** The interface never issues `tenant_directory` for an
  unauthorised caller - the route has already 404'd - so
  `tests/integration/platform-console.test.ts` calls it over HTTPS with a real
  signed-in user's JWT and asserts an empty directory. The impersonated transaction in
  the same file proves the FUNCTION refuses; that one proves the SURFACE does.
- **AND THAT HTTP ASSERTION HAS A POSITIVE CONTROL, BECAUSE WITHOUT ONE IT PROVED
  THE TRANSPORT AND NOT THE REFUSAL.** The first version asserted only that a
  non-administrator receives an empty directory - and the database held no
  organization, so an UNGUARDED function would have answered `[]` too. It now asserts
  three things: the predicate is `false` over the SAME token; ONE ORGANIZATION IS
  SEEDED AND KEPT, so an empty directory means REFUSED rather than "there was nothing
  there"; and an ADMINISTRATOR'S TOKEN receives that row, so the pair can only pass if
  the guard is what separates them. **MEASURED:** with the
  `where (select private.is_platform_admin())` clause removed - by a temporary
  correction, never by editing an applied migration - the non-administrator receives
  the seeded row and BOTH assertions fail, while the administrator's still passes. The
  function body was restored FUNCTIONALLY IDENTICAL, not byte-identically: the guard,
  the definer, the `search_path` and the grants are all confirmed live, but the restore
  dropped an inline SQL comment `01850` carried inside its dollar-quotes. MEASURED:
  `01850`'s body was 615 characters with `md5(prosrc)` `f4ca0a10932b35517f42fed887a3b82d`;
  the restored body is 288 characters with `md5(prosrc)`
  `5365ccdf74d4d73685c9afbd763d1bdf` - the live value. The first version of this record
  said "byte-for-byte, before the probe and after the restore", and the pre-probe value
  was the other one: MEASURED and corrected on the third review. The probe and the
  restore are `20261014001860` and `20261014001870`, and they are in the migration
  history on purpose - that history is the record of the measurement. A clean
  migrate-from-zero ends functionally identical to `01850`: same guard, same signature,
  same grants, one comment shorter.
- **THE MARKETING COPY'S TENANCY CLAIM IS ABOUT ROWS, NOT ABOUT COLUMNS.** MEASURED
  from `pg_attribute`: of the 16 public tables, 10 carry an `organization_id` and 6 do
  not - `organizations` is the tenant root, `permissions`, `platform_settings` and
  `tenant_creation_events` are global, `profiles` is per-user, and `role_permissions`
  hangs off a ROLE, which carries the organization. Two of the ten have the column
  NULLABLE (`audit_logs`, `roles` - a platform role belongs to no organization). So the
  copy says "every row of your clinic's own data is tied to the organization it
  belongs to", which is true of ROWS, and not "every tenant-owned table carries its
  organization", which is false of columns.
- **THE CONSOLE'S MEMBER COLUMN IS LABELLED, NOT NARROWED.** The count is of
  membership ROWS in any state, so a suspended member is counted. The column header
  says "Members (any status)" and the table's caption says what the number counts,
  because how a tenant suspends its staff is the tenant's own business and the
  console is a directory, not a tenant's roster. Changing the SQL to count only active
  memberships would have been the other way to close it, and would have made the
  console report a smaller number than the tenant has.
- **TWO OLDER RECORDS IN THIS FILE WERE FALSE, AND ARE NOW CORRECTED IN PLACE:** the
  "an organization that has roles cannot be deleted" finding, and the "clinics.timezone
  is still nullable" finding. Both were fixed by `20261014001670` on 2026-10-20, and
  this file's Task 13+ section says so now.
- **THE `tenant_creation_events` LEDGER IS NOW EMPTY, AND THAT IS A CHANGE THIS TASK
  MADE.** The ledger holds one row per tenant creation, it has NO foreign key, and
  every row in it belonged to an account that no longer exists - MEASURED: all 30 rows
  were orphans. Removing the two organizations a FAILED E2E run had left behind meant
  removing the ledger rows for their accounts - and **the 30-orphan purge was a MANUAL
  one-off, NOT the test helper's doing**: `tests/helpers/e2e-cleanup.ts` deletes ledger
  rows BY `user_id`, for the accounts the probe created, so it cannot remove an orphan
  of any other account. The manual purge removed every orphan row rather than only the
  two that were this task's - so the 29 rows that predate this
  task are gone too. Nothing live was lost (an orphan row cannot count against any
  living account's creation cap), but the "the ledger holds 29 rows" record is no
  longer true, and the ledger is the rate-limit EVIDENCE for tenant creation - so a
  later agent should know the history was cleared rather than assume it never
  existed.
- **THE ONBOARDING SPEC HAD A LATENT CROSS-TEST NAME COLLISION, AND THIS TASK'S SPEC
  FILE EXPOSED IT.** Both tests in `tests/e2e/onboarding.spec.ts` created an
  organization called "Probe Onboarding Clinic", and the suite runs its files in
  parallel - so the test that asserts "no organization with that name was created"
  could see its NEIGHBOUR's. The collision was invisible while the file was the only
  one of its kind; adding a third spec file changed the worker schedule and made it
  fire. Fixed by giving the second test its own name. A spec whose assertion depends
  on a GLOBAL name is a spec that depends on the schedule.
- **A FAILED E2E RUN CAN LEAVE AN ORGANIZATION BEHIND, AND THE CLEANUP THEN REFUSES
  TO DELETE IT.** MEASURED: when the create action was still in flight when the
  assertion timed out, the cleanup deleted the assignments and the action's own
  assignment landed afterwards - so the cascade delete of the organization hit
  `private.guard_role_delete` (the role was in use again) and the organization
  survived. The cleanup's own verification caught it ("cleanup left 1 organization(s)
  with the slug ..."), which is that helper working as designed. The two leftovers
  were removed by hand, and the ledger correction above is the consequence.
