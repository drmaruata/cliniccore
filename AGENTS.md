# ClinicCore — agent instructions

Multi-tenant clinic management on Next.js 16 App Router and Supabase/PostgreSQL with RLS.
The foundation (auth, tenancy, roles, storage, audit, isolation suite) is built. The
product is **not production-ready**.

## Mandatory steps — never skip

These apply to every task, feature, fix and refactor, at every step, without exception.
A skipped step is a blocker, not a warning: stop, complete the step, then continue. Do
not move forward in the task until it is done.

1. **Skills first.** Before writing code or implementing a task or feature, load every
   relevant skill from `C:\Users\Maruata\.agents\skills` or
   `C:\Users\Maruata\.config\opencode\skills`. If a skill covers the work, follow it.
2. **Plugins when needed.** Use the relevant plugin for the job rather than a hand-rolled
   substitute.
3. **Context7 for documentation.** Use the Context7 MCP for any official documentation
   lookup, including library API questions. Do not answer those from memory.

## Read these first

| Source                                                                     | Answers                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/IMPLEMENTATION_STATUS.md`                                            | Append-only log of what was built, measured, deferred and why |
| `docs/superpowers/plans/2026-10-29-cliniccore-clinical-core-phases-5-6.md` | The next plan — clinical core, currently **not started**      |
| `docs/ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/RLS_POLICIES.md`  | Routes, boundaries, tables, policies                          |
| `docs/TESTING.md`, `docs/DEPLOYMENT.md`                                    | Test layers, environment gates, launch blockers               |
| `README.md`                                                                | Stack, install, env names, scripts                            |

Read the tail of the status log; it is thousands of lines. When prose disagrees with
config, scripts or tests, the executable source wins.

## Current state — verify, do not trust this section

- Work on `feature/foundation`; `master` is the untouched base. Do not implement on master.
- The 20-task foundation plan is complete. **61** SQL migrations exist, ending at
  `20261014001880`.
- The clinical phases 5–6 plan is written but no clinical migration, table, route or UI has
  landed. Re-derive with `git log`, `git status` and `supabase/migrations/` before acting.
- A clean tree should pass the gates below. There is no CI workflow; the gates are local.
- Deliberately not working: mail delivery, email confirmation, verified password-reset
  delivery, billing (the seam refuses every call) and clinical modules. Never describe
  these as implemented.

## Commands

```bash
npm install
cp .env.example .env.local     # then fill real values; .env.local is gitignored
npm run dev                    # http://localhost:3000
```

Run the gates **last**, immediately before a commit:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

- `npm run lint` is **four** gates: `eslint .` && `check:secrets` && `format:check` &&
  `migrations:check`. Read the `check:secrets OK` line separately.
- `npm run build` type-checks again; do not fix one failure in two places.
- After any Markdown edit run `npm run format`; `format:check` covers the whole tree.

Focused work:

```bash
npm run test:unit
npm run test:integration
npx vitest run tests/unit/money.test.ts
npx playwright install              # once per @playwright/test version
npm run e2e                         # config builds and starts the app
$env:PLAYWRIGHT_BASE_URL="http://127.0.0.1:3000"; npm run e2e   # PowerShell; reuse server
```

`npm run test:integration` has `--passWithNoTests`; `npm run e2e` does not.

## Architecture

- URL contract is `/app/...`, so the signed-in shell is the **real segment** `app/app/`,
  not a route group. Marketing is `app/(marketing)/` serving `/`; the operator console is
  `app/platform/`. The auth group is `app/(auth)/`; invitations are `app/invite/[token]/`.
- `lib/supabase/` owns Supabase access. `server.ts` starts with `import "server-only"`;
  never import from `lib/supabase/` in a `"use client"` file. Root `proxy.ts` refreshes the
  session; Next 16 ignores `middleware.ts`.
- The database is the authorization authority: RLS plus `private.can`, `is_member`,
  `clinic_ids`. Do not reimplement a permission rule in TypeScript. `userCan` asks
  `public.can`; `getActiveOrg`/`requireActiveOrg` re-validate the cookie against membership.
- An empty membership list can mean a hidden suspended membership, not "belongs to
  nothing". Ask `hasAnyMembership()` before rendering onboarding.
- PostgREST exposes the `public` schema only. Browser RPCs are thin `public.*` wrappers
  over `private.*`; the current surface is 10 functions pinned in
  `tests/integration/public-rpc-privileges.test.ts`. A new wrapper must keep the private
  original's argument list as a prefix; every added argument needs a default.
- `lib/permissions/registry.ts` is the single 15-role / 21-permission matrix.
  `scripts/gen-permissions-sql.ts` emits the seed SQL inlined by migrations. Change the
  registry and regenerate; never hand-edit the seed.
- `supabase/migrations/` is the schema source of truth. There is no ORM and no
  `supabase db push`. 16 public tables, 39 public policies, 20 storage policies and five
  private storage buckets.
- Money is `bigint` paise through `lib/utils/money.ts`; no floating point in money paths.
  Clinic-local days use `clinicDayBounds` in `lib/utils/datetime.ts`; never compute local
  midnight by hand.
- `types/database.types.ts` is generated after migrations. Do not hand-edit its content.
- Server Actions accept `FormData` and object input; normalise both through
  `lib/auth/action-input.ts`.

## Toolchain traps

- Next.js is **16.4.3**, not the Next.js in training data. Read
  `node_modules/next/dist/docs/` before writing app code. Session refresh belongs in root
  `proxy.ts`, not `middleware.ts`.
- TypeScript is pinned to **6.0.3**. TypeScript 7 breaks typescript-eslint loading and
  kills `npm run lint`; do not upgrade it.
- `exactOptionalPropertyTypes: false` is deliberate; the reason and revisit condition are
  in `docs/IMPLEMENTATION_STATUS.md`.
- Tailwind v4 is CSS-first: there is no `tailwind.config.js`. Tokens live in
  `app/globals.css` under `@theme inline`.
- The shadcn CLI re-emits `import { cn } from "cn"`. Repoint generated files at
  `@/lib/utils/cn`; ESLint fails the wrong import. Prettier ignores `components/ui/` on
  purpose — do not reformat generated components.
- Vitest's `include` must keep `.tsx`, or component tests are silently skipped.
  `fileParallelism: false` is deliberate: the security suite drops and loosens live
  policies, whose DDL locks block a concurrent catalogue reader.
- `SUPABASE_SERVICE_ROLE_KEY` may be referenced only from `lib/supabase/server.ts` or
  under `tests/`, never from a `"use client"` file or a `NEXT_PUBLIC_*` name. Test
  fixtures build secret-shaped strings at runtime. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is an
  unread placeholder.
- Regenerating `types/database.types.ts` always produces a formatting diff; prettier
  rewrites the generator output. That diff is expected; restore only formatting, never
  content.

## Database and RLS traps

- Three refusal shapes, three assertions: a `USING` miss **filters** rows (zero rows, no
  error); a failed `WITH CHECK` and a trigger **raise**. Assert the right shape.
- Every refusal needs an authorised positive control beside it. An INSERT refusal alone
  cannot distinguish a refusing policy from a deleted one.
- UPDATE and DELETE also pass the SELECT policy. To prove a write leak, loosen or drop the
  command policy **and** the SELECT policy together.
- `postgres` has `rolbypassrls`; `resetRole()` therefore measures postgres, not the
  principal. Impersonate with `set local role authenticated` plus
  `set_config('request.jwt.claim.sub', ..., true)`. Both are transaction-local.
- `set_config(..., true)` is transaction-local and the last identity wins. Probe one
  identity per transaction or Composio call, never batch two.
- `SECURITY DEFINER` bypasses RLS. Every definer that writes tenant rows must check
  membership itself. Helpers called by policies must keep EXECUTE for `authenticated`;
  revoking one makes rows invisible, not denied.
- Policy totals are pinned in two places: `tests/security/rls-policies.test.ts` (39 public)
  and the ledger test in `tests/security/tenant-isolation.test.ts` (59 public + storage).
  Update both in the same commit as a policy change.
- `pg` rejects multi-command query strings when the query carries parameters. Use one
  checked-out client per transaction; `pool.query` round-robins connections.
- Storage DELETE tests must set `storage.allow_delete_query`, or they measure the delete
  guard rather than the policy.

## Migrations

- Never edit an applied migration. A correction is a new file.
- Filenames must match `^\d{14}_[a-z][a-z0-9_]*\.sql$` and sort after the newest file.
- Apply through the Composio `SUPABASE_APPLY_A_MIGRATION` tool, **one apply per call**.
  The applier derives `schema_migrations.version` from a second-resolution timestamp, so
  batching two files collides on the primary key.
- Never trust the apply response. Verify with `pg_catalog`, `information_schema` or
  `pg_policies`.
- `npm run migrations:check` validates names, order and emptiness. It applies nothing.
- After applying: regenerate the database types, update both policy totals when policies
  changed, and append the measurement to `docs/IMPLEMENTATION_STATUS.md`.

## Testing traps

- `TEST_DATABASE_URL` must use the pooler host (`aws-0-<region>.pooler.supabase.com`,
  user `postgres.<project-ref>`); the direct `db.<ref>.supabase.co` host may not resolve.
  Absent URL skips DB suites; `CI=true` or `REQUIRE_TEST_DATABASE_URL=true` makes absent a
  failure.
- The security suite creates two real tenants and mutates live policy DDL inside
  rolled-back transactions. Use a disposable project, never production, and do not make
  its files parallel.
- Cleanup must verify its own residue. Scope residue checks to ids the caller created;
  other suites also create accounts. Delete children before parents:
  `patient_identifiers` is `ON DELETE RESTRICT`.
- E2E creates accounts through the admin API because public signup is rate-limited to a
  few calls per window. It runs against a production build, in Chromium and Firefox.
- E2E runs `fullyParallel`; give fixtures unique names or one spec sees another's tenant.
- Select E2E controls by accessible name. The shell header's sign-out is also a
  `type="submit"` button, so a generic selector is ambiguous.

## Conventions

- Write comments as one block at the top of a file describing what it does and why. Do not
  scatter commentary through the code.
- `docs/IMPLEMENTATION_STATUS.md` is append-only for new work, but a false record is
  corrected in place and the correction is noted. Record measurements, not assurances.
- `lib/billing/` is a refusal-only seam. Do not add a fake provider, test mode or payment
  SDK; `tests/unit/payment-provider.test.ts` pins its file/export/import surface.
- Check available skills before coding. For library API questions use the Context7 MCP and
  the installed version's docs, not memory.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
