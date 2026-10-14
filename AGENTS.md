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
- **Task 1 of 20 complete. Task 2 (design system) is in its review-fix loop.** Run
  `git log --oneline` and `git status` before you start: the review fixes may be sitting
  uncommitted on your machine. The briefs are in
  `.superpowers/sdd/cliniccore-foundation/`.
- **A clean tree on this branch should be green on all six gates.** If you are not sure,
  run them rather than trusting a summary — including this one:
  `npm run typecheck && npm run lint && npm run check:secrets && npm run test &&
npm run build && npm run format:check`.
- Nothing exists yet for `supabase/`, `lib/supabase/`, `proxy.ts`, or the route
  groups. Task 3 onward creates them.
- `README.md` does not exist yet — it is Task 19's deliverable.

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

## How to work here

1. **Invoke the relevant skill before writing or editing any code.** Skills live in `C:\Users\USER\.agents\skills` and `C:\Users\USER\.config\opencode\skills`. OpenCode also ships skills for Next.js, Tailwind, shadcn, testing and security — check before assuming none applies.
2. **Use the context7 MCP for anything involving an official library doc** (`tools.context7["resolve-library-id"]` then `tools.context7["query-docs"]`), especially Next.js 16, Tailwind v4, shadcn, `@supabase/ssr` and Vitest. Do not answer from memory — this stack has moved past what training data covers.
3. Use the relevant plugins/extensions when they help; do not bolt them on unasked.
4. Task work in this repo follows the SDD flow in `.superpowers/sdd/cliniccore-foundation/`: read the task brief, implement, then run all four gates and record the outcome.
5. Prefer measurement over assertion. This project's history is a run of implementers reporting results their own change had invalidated — when a change invalidates a measurement, re-run it and correct the write-up rather than restating it.

## AGENTS.md hygiene

- `next dev` owns the `<!-- BEGIN:nextjs-agent-rules -->` … `<!-- END:nextjs-agent-rules -->` block below and re-adds it if you delete it (`node_modules/next/dist/server/lib/generate-agent-files.js`). Content outside the markers is preserved verbatim — put your content outside them and commit the block with your work to keep the tree clean.
- Do not duplicate what `docs/IMPLEMENTATION_STATUS.md` already records. Link to it instead.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
