# Implementation status

Append-only log. Newest entry last.

---

## Task 1 â€” Project scaffold and toolchain gates

Branch: `feature/foundation`
Node v24.16.0, npm 12.1.0, Windows + PowerShell.

### TypeScript version â€” resolved by measurement, not assumption

The brief's Step 5 said to install `typescript@7` and only fall back to
`typescript@^5.9` if diagnostics were "spurious or absent". **That fallback
condition was not met, and `typescript@7` was still rejected.** Both facts were
observed; the reasoning is below.

**Measurement method.** A throwaway `ts-probe/` file exercised every strict flag
from Step 2 (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes: false`) plus a
generic (`identity<T>`), an indexed access (`rows[0]`), `satisfies`, and a const
assertion. Every _expected_ error was marked `@ts-expect-error`, so a missing
diagnostic surfaces as `TS2578: Unused '@ts-expect-error' directive` rather than
silently passing. The probe was deleted after measurement and is not committed.

#### Run 1 â€” `typescript@7.0.2` (`npx tsc --version` â†’ `Version 7.0.2`)

`tsc --noEmit` behaved correctly. Confirmed diagnostics:

| Flag                                    | Observed diagnostic                                       |
| --------------------------------------- | --------------------------------------------------------- |
| `strict` (strictNullChecks / arg types) | `TS2345` on `len(null)`, `len(42)`                        |
| `noUncheckedIndexedAccess`              | `TS2532 Object is possibly 'undefined'` on `rows[0].name` |
| `noImplicitAny`                         | `TS7006` on `(x) => x`                                    |
| `noImplicitOverride`                    | `TS4114` on an unmarked `greet()` override                |
| `noFallthroughCasesInSwitch`            | `TS7029 Fallthrough case in switch.`                      |
| `exactOptionalPropertyTypes: false`     | `{ label: undefined }` accepted (no error)                |

Two of my own probe mistakes, not toolchain faults, produced the only other
output: the `@ts-expect-error` for fallthrough must sit on the _falling-through_
clause, not the following one; and a `protected` member cannot be read from
outside the class.

**So Step 5's literal fallback condition ("spurious or absent" diagnostics) was
NOT triggered. `npm run lint` nonetheless failed hard:**

```
$ npm run lint
> eslint . && npm run check:secrets

typescript-eslint does not support TS 7.0.
Please see
https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0 to run
typescript-eslint using the TS 6 API.
See also https://github.com/typescript-eslint/typescript-eslint/issues/10940 for tracking typescript-eslint's support
for TS >=7.1

Oops! Something went wrong! :(
ESLint: 9.39.5
Error: Cannot read config file: H:\cliniccore\node_modules\eslint-config-next\dist\core-web-vitals.js
Error: typescript-eslint does not support TS 7.0.
    at Object.<anonymous> (H:\cliniccore\node_modules\eslint-config-next\node_modules\typescript-eslint\dist\index.js:52:11)
```

`npm ls typescript` likewise marks the install `invalid`:

```
"typescript@7.0.2 deduped invalid: \">=4.8.4 <6.1.0\" from
 node_modules/eslint-config-next/node_modules/typescript-eslint, ..."
```

Step 5 (pin TS 7) and Step 6 (`npm run lint` exits 0) are therefore mutually
exclusive as literally written. Step 6 was treated as binding, because a lint
gate that cannot load its config is not a gate.

#### Run 2 â€” `typescript@6.0.3`

`typescript@6.0.3` is a published stable (note: it is **not** the `latest`
dist-tag, which is `7.0.2`; `npm view typescript@6 version` â†’ `6.0.3`). It is
inside typescript-eslint's supported range `>=4.8.4 <6.1.0`, and it is the exact
version Microsoft's own error message points to ("run typescript-eslint using
the TS 6 API").

- `npx tsc --version` â†’ `Version 6.0.3`
- `npm run typecheck` â†’ exit 0
- `npm run lint` â†’ exit 0 (typescript-eslint loaded cleanly, no warning)
- `npm test` â†’ 13 passed
- `npm run build` â†’ exit 0, Next 16.4.0 + Turbopack

**Decision: pin `typescript` to `6.0.3` exactly.** Rationale:

1. It is the newest TypeScript for which every gate in the definition of done
   provably passes, and the newest one the Next.js 16 lint stack supports.
2. It is materially newer than the `^5.9` fallback the brief anticipated, so
   this is the least-surprising resolution rather than a retreat to the fallback.
3. It keeps a _single_ TypeScript in the tree. The "side-by-side" arrangement
   Microsoft's post suggests would mean `tsc` on 7.0.2 and typescript-eslint on
   a second copy â€” two compilers that can disagree, for no observed benefit.

**Revisit condition.** Upgrade to `typescript@>=7.1` once
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
ships, and re-run this measurement. Do not assume the fix; re-measure.

### Why `exactOptionalPropertyTypes: false` is a deliberate exception

Brief Step 2 requires this be documented as a deliberate exception rather than
an oversight. It is the single flag left off from the strict family.

With `exactOptionalPropertyTypes: true`, `{ prop?: T }` rejects an explicit
`prop: undefined`. Almost every third-party prop type in this stack is written
as `prop?: T` without that constraint in mind, so enabling it produces errors at
component boundaries we do not control â€” shadcn/ui primitives, `@supabase/ssr`
options, React's own children/signature types. The cost is a cast at each of
those seams.

The flag buys real safety, so this is a **revisit condition**, not a permanent
ruling: if Task 2's shadcn pass shows a low cast count, or if a later task needs
optional-property precision, turn it on and measure. What we accept today is that
`{ prop: undefined }` is indistinguishable from `{ prop: missing }` at the type
level. That is tolerable only because every optional prop in this codebase is
rendered through `cn()` and guarded at the read site.

The comment also lives inline in `tsconfig.json`, directly above the setting.
(Note for future editors: TypeScript 6 accepts real `//` comments in
`tsconfig.json`, but rejects a JSON _key_ named `"// something"` with
`TS5023: Unknown compiler option`. Task 1 originally tried the key form and
`tsc` rejected it.)

### HARD OBLIGATION â€” `lib/supabase/server.ts` must start with `import "server-only"`

Carried forward into whichever task creates the Supabase server client. This is
the **primary** enforcement layer for the service-role boundary; the lint gate is
the secondary one.

- `server-only` fails at **bundle time**, inside React Server Component
  boundaries. Nothing in the codebase can talk the bundler out of it.
- The lint gate (`scripts/check-no-secrets.ts` rule 3) catches the mistake
  earlier and in review, but it is a lexical scanner: it models the specifiers
  it knows (`@/lib/supabase/â€¦`, `lib/supabase/â€¦`, relative `../lib/supabase/â€¦`)
  and cannot follow a re-export through an alias it does not recognise.

Consequence for the Supabase task: **do not** treat a green
`npm run check:secrets` as evidence that the boundary is sound. `server-only` is
what makes it sound. `server-only` is already a dependency (`package.json`); as of
this commit it is imported by nothing, and that is expected until the Supabase
task lands.

### Files created

`package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
`eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`,
`playwright.config.ts`, `.gitignore`, `.gitattributes`, `.env.example`,
`lib/utils/cn.ts`, `scripts/check-no-secrets.ts`, `app/layout.tsx`,
`app/globals.css`, `app/page.tsx`, `tests/unit/check-no-secrets.test.ts`,
`tests/unit/cn.test.tsx`, `tests/integration/placeholder.ts`,
`tests/e2e/placeholder.ts`.

Five files are not in the brief's list; all are mechanical prerequisites, not
design decisions: `postcss.config.mjs` (Tailwind v4 has no `tailwind.config.js`
and must be loaded as a PostCSS plugin), `app/page.tsx` (Next.js 16 needs at
least one route), `.prettierignore` (otherwise `format:check` reflows the
authored planning documents under `docs/superpowers/`),
`tests/integration/placeholder.ts` and `tests/e2e/placeholder.ts` (both script
targets must exist before their tasks land).

See `.superpowers/sdd/cliniccore-foundation/task-1-report.md` for the full
report.

### OBLIGATION FOR TASK 15 â€” remove `--pass-with-no-tests` from `e2e`

`package.json` currently defines:

```json
"e2e": "playwright test --pass-with-no-tests"
```

Task 1 has no E2E specs by design. Without the flag, `npm run e2e` fails with
`Error: No tests found` (exit 1) for a reason that is not a defect â€” there is
simply nothing to run â€” which makes the gate lie in both directions: it reports
failure for a healthy repo, and it would report success for a repo whose specs
failed to be collected.

**Task 15 must remove `--pass-with-no-tests` from both the `e2e` and
`test:e2e` scripts when it adds the first real spec.** From that point on an
empty or uncollectable spec set must be a hard failure again. Do not carry the
flag forward past Task 15.

---

## Task 2 â€” design system, and the toolchain rules it established

Branch: `feature/foundation`. Base commit: `a35571f` (Task 1).

This entry records the decisions that belong in a log rather than in a report
nobody reads by default. The design tokens themselves are documented in
`app/globals.css` and enforced by `tests/unit/design-tokens.test.ts`.

### `shadcn` and `tw-animate-css` live in `devDependencies`, not `dependencies`

Neither package is imported from JavaScript. Both are reached only through an
`@import` in `app/globals.css`, which **Tailwind resolves from `node_modules` at
build time** and never emits into the JS bundle. Nothing at runtime requires
them, so a production dependency is the wrong home.

The reason it mattered: `app/globals.css` originally contained
`@import "shadcn/tailwind.css"`. That put a devDependency on the build-time CSS
resolution path, so any build that installs with `--omit=dev` could not resolve
it. Vercel installs devDependencies for its build phase, so the green local and
Vercel builds never exercised that path â€” which is why this went unnoticed
through Task 2's own review.

**Do not move either package back to `dependencies`.** If a dependency audit or
a "tidy the manifest" pass proposes it, the correct response is that the package
is build-time only.

### `tailwindcss` is a devDependency AND the single point of failure for the CSS build

Stated separately and emphatically because it is the one most likely to be
"tidied" away by a well-meaning future change.

`tailwindcss` is a devDependency. `next build` loads it as a PostCSS plugin
(`postcss.config.mjs`) and every token, every utility and every
`@custom-variant` in the app comes out of it. If someone moves it to
`dependencies` on the reasoning that "it's the styling framework, it obviously
belongs in prod":

- **TypeScript will not notice.** `tsc --noEmit` has nothing to say about it.
- **Vitest will not notice.** `tests/unit/design-tokens.test.ts` parses
  `app/globals.css` as _text_. It never runs Tailwind. It will keep passing,
  and keep passing, against a stylesheet the build can no longer produce.
- **`npm run lint` will not notice.**
- The failure is a build failure with a PostCSS resolution error, which is
  noisy â€” but only once you have removed devDependencies, which a local
  `npm install` never does.

So: the visible symptom is fine. The reason to care is that the one gate which
_looks_ like it covers the design system (the token test) has a structural blind
spot, and `tailwindcss` moving sections is exactly the kind of change that is
made without running a production build. **Treat "tailwindcss â†’
dependencies" as a change requiring a `--omit=dev` build to verify.**

### `app/shadcn.css` is vendored, not imported from the package

`@import "shadcn/tailwind.css"` was replaced by a 40-line vendored file
carrying only the two `@custom-variant` blocks the generated components actually
use (`data-open`, `data-closed` â€” verified by grepping every `data-*:` variant
in `components/ui/*.tsx`; nothing references the accordion keyframes,
`no-scrollbar`, `scroll-fade-*` or `shimmer-*`).

Consequence for anyone tempted to restore the package import: losing these rules
**fails no build and fails no test**. `components/ui/alert-dialog.tsx` drives its
enter/exit animation from `data-open:animate-in` and `data-closed:animate-out`,
and `components/shared/confirm-dialog.tsx` is built on that alert dialog. Delete
them and the dialog simply pops in with no animation â€” a silent visual
regression. Measured effect of the vendoring: the compiled stylesheet is
identical for the variants and 900 bytes smaller, having dropped dead
`--scroll-fade-*` / `--shimmer-*` registrations.

### One merge engine: `cn` comes from `@/lib/utils/cn`, never from the `cn` package

`shadcn@latest init` with the `radix-nova` style emits
`import { cn } from "cn"` into every file it generates â€” an unrelated npm
package whose merge engine does not know this project's custom theme colours
and therefore cannot collapse `bg-primary` against `bg-success`. Both survive on
the element and CSS source order decides the colour.

`components.json` already sets `"aliases": { "utils": "@/lib/utils/cn" }`. **That
is not a defence.** The CLI emitted the bad import anyway. Three independent
guards now exist, each catching something the others cannot:

- ESLint `no-restricted-imports` scoped to `app/**` and `components/**` â€” fails
  at lint time, before tests.
- `tests/unit/cn.test.tsx` â€” catches quote styles and subpath forms ESLint's
  pattern does not, and asserts `package.json` has no `cn` dependency, which
  ESLint cannot see at all.
- `AGENTS.md`, for the human.

### Compensating rules in `app/globals.css` for generated variants that fail as text

`--primary` does two jobs â€” the `default` Button's fill (fine, paired with
`--primary-foreground`) and the `link` variant's text (2.93:1, not fine). Only
`--brand-primary` is mandated; `--primary` is a token this project chooses, so
the fix is at the token and variant layer, not the palette.

`components/ui/` is generated and is not hand-edited for colour. Instead,
`app/globals.css` carries unlayered rules keyed on `data-slot` + `data-variant`
(both already emitted by the generated code, so they survive a future
`shadcn add`). `tests/unit/design-tokens.test.ts` then reads **every** variant
out of `button.tsx` and `badge.tsx` and requires each to clear AA against what
it actually paints, or to have such a rule â€” and requires the rule's own token
to clear AA too. A new `shadcn add` shipping `variant="subtle": "text-primary"`
fails the suite without anyone thinking of it.

### Round 3 â€” the colour maths under that gate was wrong, and the ruling that fell with it

**OKLab needs the sRGBâ†’linear-light step.** `srgbToOklab` fed gamma-encoded
channels straight into the LMS matrix, computing `cbrt(gamma)` where the spec
says `cbrt(linear)`. They agree only at 0 and 1. For a neutral grey,
`L == relativeLuminance^(1/3)` is the defining property: sRGB 0.10 â†’ linear Y
0.0100 â†’ L **0.2156** (the broken function gave 0.4642), 0.50 â†’ 0.2140 â†’ **0.5982**
(0.7937), 0.90 â†’ 0.7874 â†’ **0.9234** (0.9655). Round-trip `oklabToSrgb(srgbToOklab(x))`
is exact for neutrals and for every brand hex. **Do not remove the
linearisation** â€” the suite pins it by round-trip, by the `L == Y^(1/3)` property,
and by a negative control asserting `L(0.5)` is _not_ `cbrt(0.5)`.

**The gate takes the MINIMUM of two compositing models.** `mixOklab` (oklab
interpolation, what `color-mix(in oklab, â€¦)` specifies) and `compositeGammaSrgb`
(gamma-sRGB premultiplied, what a translucent layer actually contributes) are
different computations. The controller's ruling named oklab interpolation as "the
conservative model, the lower of the two" â€” measurement says it is the HIGHER on
both samples the palette uses: dark `--destructive` on its own `/20` wash is
4.96:1 oklab vs 4.83:1 gamma, and light on `/10` is 5.23:1 vs 5.10:1. The gate
therefore asserts the minimum, and a test bounds the gap at 0.5:1 across every
variant/mode/host (max observed: 0.45:1 on `button:outline` dark). The dispatch's
5.70:1 / 5.76:1 pair corresponds to the **/10** wash, not /20 â€” the /20 pair is
4.83 / 4.96.

**The destructive defect is WCAG 1.4.11, the boundary, not the text.** Round 2's
2.06:1 dark text failure was an artefact of the broken transform; the text is
4.83â€“4.96:1 and was never failing. What actually fails is the control's edge: the
tint against the page is 1.19:1 (light `/10`), 1.42:1 (light `/20`), 1.13:1
(dark `/10`), 1.34:1 (dark `/20`), and clears 3:1 only at about 70% opacity. So
the compensating rule paints a solid `--destructive` fill under
`--destructive-foreground` (6.06/6.33:1 light, 6.46/5.90:1 dark) and is
**unscoped** â€” the round-2 `.dark`-only scoping rested on the false 2.06:1 and
left light mode shipping a 1.19:1 edge on the app's most safety-critical button.

**Because that rule is unconditional, it deletes hover feedback** â€” it outranks
the generated `hover:bg-destructive/20` for the same layer reason. `--destructive-hover`
exists to put it back, and its direction is mode-dependent: `color-mix(â€¦
var(--destructive) 88%, black)` is right in light (6.33:1 â†’ 20.62:1) and
catastrophic in dark (6.69:1 â†’ **1.09:1**), because dark `--destructive` is a
light coral under a near-black ink. The token moves off `--destructive` toward
`--foreground` instead, which is automatically the right way in each mode. The
gate holds every hover compensation to AA; without that assertion a broken hover
fill passes, because the resting gate reads unprefixed utilities only.

### OBLIGATION FOR A LATER TASK â€” `--input` on `--muted` is 2.83:1 in light mode

Measured, not asserted. `--muted` is `oklch(0.955 0.004 250)` against
`--background`'s `oklch(0.985 0.002 250)`, so a form control sitting on a muted
panel has an under-contrast edge, where the same control on `--background` clears
3:1. This is the same class of defect as the `--border` finding Task 2 fix round
1 closed, one declaration over, and it was outside what that round was asked to
change. Decide whether `--input` should clear 3:1 on `--muted` too, or whether
WCAG 1.4.11 does not apply to an input on a panel â€” then either fix the token or
gate it.

### OBLIGATION FOR A LATER TASK â€” `bg-white` and friends escape the colour gate

`tests/unit/design-tokens.test.ts` rejects hex literals, Tailwind's numeric
palette (`bg-red-500`) and literal colour functions in component files. It does
**not** reject `bg-white`, `text-black`, `bg-transparent` or `bg-current`: the
palette regex is anchored on the numeric suffix, because a bare
`-(red|blue|â€¦)-` prefix pattern would also flag `border-border` and `bg-muted`,
which need their own allowlist-of-one decision. `--card` is white in light mode,
so `bg-white` is exactly what a contributor reaches for. Needs its own rule plus
that decision.

### RECORDED, NOT FIXED â€” test fixtures leak palette colours into the stylesheet

Tailwind scans the whole project, so the throwaway merge fixtures in
`tests/unit/cn.test.tsx` (`bg-red-500`, `text-blue-500`) cause Tailwind to emit
`--color-red-500`, `--color-blue-500`, `--color-slate-200`, `--color-zinc-900`,
`--color-black` and `--color-white` into the production stylesheet. Tests are
deliberately outside the gate's scan roots â€” they are not product UI surface,
and the fixtures have to name a real palette class to exercise merging â€” so this
is not a violation of any rule. Cosmetic, but it means the shipped stylesheet is
not purely a function of shipped components.

### RECORDED â€” M8, the CSS gate reuses a TypeScript comment stripper

`findHexLiterals` and the per-file component scan both call `stripComments` from
`scripts/check-no-secrets.ts`. It works only because CSS and TypeScript share
the `/* â€¦ */` form. A CSS-native stripper is the correct fix.

See `.superpowers/sdd/cliniccore-foundation/task-2-report.md` for the full
report, including the contrast measurements behind every token value.

## Task 3 — permission registry (single source of truth)

- The role x permission matrix lives once, in lib/permissions/registry.ts
  (21 permissions, 15 roles). scripts/gen-permissions-sql.ts is the only thing
  that turns it into SQL; Task 7 inlines generatePlatformScopeSql(), Task 8
  inlines generateOrganizationScopedRoleSeedTemplate() with a concrete
  organization id substituted for {{ORGANIZATION_ID}}.
- **Determinism is the contract**: same registry in, byte-identical SQL out,
  independent of declaration order (pinned by reversed-input tests). The
  generator never emits timestamps. Do not hand-edit generated SQL.
- _*platform_super_admin holds the four platform.* permissions and nothing
  clinical._* Platform operators see the tenant directory, subscription and
  usage — never patient records. This is the registry-level half of the
  plan's rule that private.can() must not consult is_platform_admin().
- **Known risk**: the generated SQL has never been executed. Tests pin its
  text shape only; Task 7's apply is the first proof it is valid PostgreSQL.
- **Gate interaction to expect**: lib/ is a scan root of the design-token
  no-hex gate. Any new .ts/.tsx/.css file under lib/ changes that
  gate's pinned file count (see tests/unit/design-tokens.test.ts,
  walks the component tree) and the update is intentional — the pin exists
  so scan-set changes are visible diffs.

## Task 3 fix round 1 — schema conformance and idempotency

- **
  oles.is_system, not is_platform** (review C2): both the plan and the
  spec define is_system; the generator had emitted is_platform, which fails
  at apply time with undefined_column. The generator and its tests now use
  the plan's column names throughout, including

ole_permissions(role_id, permission_key) and select r.id, p.key
(review C1 — the old grants statement selected a nonexistent permissions.id).

- **unique nulls not distinct (organization_id, key) on
  oles** (review I1).
  A plain unique index treats NULLs as distinct, so
  on conflict (organization_id, key) do update never fires for the platform
  row at organization_id NULL, and re-seeding duplicates the role and fans
  the grants out (measured on the project's PostgreSQL 17.11: 1 -> 2 role rows,
  2 -> 4 grant rows). Both candidate remediations were measured —

ulls not distinct (works) and a partial unique index with
on conflict (key) where organization_id is null (works) — and the

ulls not distinct form was chosen for the smaller, schema-only diff that
cannot affect organization-scoped rows. The plan's Task 6/7 schema line is
amended accordingly. Task 7 must not "fix" it back to a plain unique.

- **Grants insert now carries on conflict (role_id, permission_key) do nothing**
  (review I2): the second seed apply previously raised unique_violation.
- **lab_technician no longer holds investigations.order**: lab techs fulfil
  orders, they do not place them. Ordering remains held by medical_director,
  doctor, nurse and clinical_assistant.
- Generator input is now validated for key shape (^[a-z_]+(\.[a-z_]+)+$ for
  permissions, ^[a-z_]+$ for roles) and single-line descriptions, so an
  off-pattern key fails loudly instead of producing broken or injectable SQL.

## Task 4 - migration delivery harness

- supabase/migrations/*.sql is the source of truth; scripts/apply-migration.ts
  validates and emits a manifest ({ name, idempotencyKey, sql }); the agent
  applies each entry via the Composio MCP (SUPABASE_APPLY_A_MIGRATION) and
  verifies against information_schema / pg_catalog. A Node script cannot call
  the MCP and there is no Supabase PAT, so the applier is the agent, by design.
- Filename convention is enforced by --check: YYYYMMDDhhmmss_snake_case.sql.
  A timestamp-prefixed file that does not end in .sql is rejected as a
  probable mistake rather than silently ignored.
- Idempotency keys are the bare filename stem - stable, human-greppable, unique
  per file by construction (two files cannot share a filename in the flat
  migrations directory; a duplicate check was removed as dead code that no
  failing test could justify).
- supabase/config.toml is generated by 'supabase init' for a future PAT or
  local 'supabase start'; the harness itself never reads it.

## Task 4 fix round 1 - the apply path is measured, and it does NOT dedupe

- The manifest -> SUPABASE_APPLY_A_MIGRATION -> catalogue-verify path was
  exercised end to end against the live project with a throwaway probe
  migration: applied, verified in information_schema, recorded in history,
  dropped, and the history row removed. The database is back to 0 public
  tables / 0 history rows.
- **Measured: re-applying a migration under the same idempotency_key is NOT
  rejected.** The applier re-executed the SQL and failed only on the probe's
  non-idempotent 'create table' (42P07). The idempotency key deduplicates
  nothing; migrations must rely on their own idempotent guards PLUS the
  workflow's history check. Anyone applying migrations MUST first list
  supabase_migrations.schema_migrations and skip file names already recorded
  (match on name - the version column is an apply timestamp, not the key).
- The apply response body reports success with an empty payload; the
  catalogue is the only verification that counts (both stated before, now
  measured).
- 'npm run migrations:check' is part of the lint gate: a misnamed migration
  file fails the standard gates rather than waiting for apply time.

## Task 5 - extensions, private schema, core trigger functions

- Extensions: citext and pgcrypto, each created `with schema public` inside a
  `DO ` block guarded against `pg_catalog.pg_extension`. The pin is not
  cosmetic: without it, placement follows the applier's search_path (citext
  landed in public only by luck; pgcrypto was preinstalled in `extensions` and
  skipped as already present). `gen_random_uuid()` is core since PG13;
  pgcrypto is retained for future crypt/digest use, not for UUIDs.
- The private schema is the RLS recursion-break: `revoke all from public`,
  `grant usage to authenticated`. Verified: `anon` has no schema usage and
  no function execute; `public` cannot execute either function.
- `set_updated_at()` is security definer with `search_path = ''`.
  `guard_platform_admin()` is SECURITY INVOKER gating on
  `current_user::text = 'service_role'`.

### Measured constraint - no database-layer check can identify the service role

- Under PostgREST every request runs in a session whose `session_user` is
  `authenticator`. Measured on this project: `authenticator` holds SET on
  `service_role` (`pg_auth_members.set_option = true`) - required for the
  service key to work at all - while `authenticated` holds neither MEMBER nor
  SET.
- `SET ROLE` checks `session_user`, not `current_user`. Measured: after
  `SET LOCAL ROLE authenticated` (a role with no SET option on
  `service_role`), `SET ROLE service_role` still succeeded because
  `session_user` was privileged.
- Therefore any SQL-executing session can `SET ROLE service_role` and forge a
  `current_user`-based check, exactly as it can forge the
  `request.jwt.claim.role` GUC via `set_config` (PUBLIC-executable).
- Consequence: `guard_platform_admin` is DEFENCE-IN-DEPTH, not an unforgeable
  boundary. Its real value is the PostgREST table-endpoint path, where a client
  cannot inject `SET ROLE`. The hard barriers are the absence of a
  SQL-execution surface reachable by anon/authenticated and the `profiles` RLS
  policies (Task 9) - and these are not independent: `service_role` has
  `rolbypassrls = true`, so RLS falls with the same escalation, making "no
  client-reachable SQL surface" the load-bearing barrier. Tasks 9/12/13 must not
  treat a role check as a security boundary.
- The two migrations were edited and re-applied once, in fix round 1, after the
  forgeable-GUC finding: they had been applied minutes earlier inside the same
  task loop, nothing depended on them, and a fresh replay must receive the
  corrected pair. History was reset 1:1 with the files. This exception closes
  once `00300` lands or a second environment exists - from then on
  corrections are new migration files, per the README rule.

## Task 6 - identity and tenancy schema

- Six tables: profiles, organizations, organization_memberships, clinics,
  clinic_memberships, invitations. Tenant isolation is structural - every
  tenant table carries organization_id and unique (organization_id, id); child
  tables reference parents through COMPOSITE FKs that both include
  organization_id, so a row cannot point across organizations even if app code
  is wrong. Verified at the catalogue: both clinic_memberships FKs are arity 2
  with organization_id in the key.
- RLS is enabled DENY-ALL on all six tables in Task 6, not deferred to Task 9.
  Supabase grants anon/authenticated access to new public tables by default, so
  without this the tables are PostgREST-reachable in the window before Task 9.
  Task 9's policies layer on top; enable row level security is idempotent.
- invitations.role_id is a plain uuid in Task 6 - roles does not exist until
  Task 7's 00400. Task 7 adds the FK. A forward reference would fail at apply.
- Behavioural rehearsal (then cleaned up): an auth.users insert creates the
  profiles row via the AFTER INSERT trigger; a postgres session is blocked from
  flipping is_platform_admin; a service_role session succeeds. The service-role
  leg requires SET ROLE service_role - a plain postgres tool session is
  fail-closed, as the Task 5 N4 note warned.
- tests/integration/tenancy-schema.test.ts is discharged as a controller-run
  catalogue rehearsal: no DB connection string or PAT exists, so vitest cannot
  reach Postgres. A shared note in the plan records this for later tasks.

## Task 6 fix round 1 - review findings closed

- Four Important findings from the Task 6 review, all closed. I1: the
  substitution ruling was too broad - migration-TEXT assertions are runnable, so
  tests/unit/tenancy-schema-sql.test.ts now guards (11 tests) the composite-FK
  arity, the six RLS enables, the UPDATE-only guard, current_org_ids' shape, and
  the hardening indexes/revokes; only live-DB assertions remain controller
  rehearsals. I2: Task 9 must create profiles (select/update self, NO insert
  policy, with check forbidding an is_platform_admin flip) and invitations
  (private.can(org,'staff.manage')) policies, or they stay deny-all forever.
  I3: new migration 20261014000310 adds organization_memberships_user_id_idx -
  current_org_ids filters user_id and Task 9 calls it in every tenant policy.
  I4: invitations.role_id and user_role_assignments.role_id are not org-scoped by
  the FK; Task 7 must add a definer guard trigger requiring
  role.organization_id IS NULL OR = the row's organization_id (a composite FK
  cannot express it - platform roles have NULL organization_id).
- 00310 also revokes TRUNCATE/REFERENCES/TRIGGER from anon/authenticated on the
  six tables (RLS does not cover table-wide operations) and closes
  create_profile_for_new_user's PUBLIC execute grant. Verified: all three
  privileges false for anon+authenticated, row SELECT retained, history 4 rows.
- Standing rule recorded: every migration creating a public table enables RLS on
  it in the same file (Supabase default-grants anon/authenticated on new public
  tables). Applies to Tasks 7 and 8.
- Ruling: profiles.full_name is app-authoritative and signup-seeded from
  raw_user_meta_data; auth metadata updates do not propagate and no sync trigger
  is added (no metadata-update path exists). A future profile-edit flow writes
  profiles.full_name directly.
- Systemic: the plan's live-DB suites (Tasks 5-9) are converted to text-level
  unit tests where possible and controller rehearsals otherwise; Task 18's
  mutation-verified tenant-isolation harness cannot run without a connection and
  is flagged for re-scope or connection configuration before Task 18.

### Tooling: graphify output is now ignored (gate integrity)

- The `.opencode` graphify plugin writes `graphify-out/` (untracked) and
  `.opencode/plugins/graphify.js` at the start of a test run. `prettier --check
.` walks the filesystem and honours no git exclusion, so after any
  `npm run test` the formatting gate went red with no source change behind it
  - and `graphify-out/` was not gitignored, so the plan's `git add -A`
    commit steps would have staged it.
- `graphify-out` and `.opencode` are added to `.prettierignore` (generated
  output, same rationale as `components/ui`) and `/graphify-out/` to
  `.gitignore`. This is why `lint` was briefly red during Task 6 fix round 1.

## Task 6 fix round 2 - re-review findings

- N1: the fix-round-1 commit left format:check red on docs/IMPLEMENTATION_STATUS.md
  (a note appended after the gates ran), so its "lint 0" was stale. Fixed; the
  gate run is now the last step. This is the AGENTS.md rule made concrete: when a
  change invalidates a measurement, re-run it rather than restate it.
- N2/N3: tests/unit/tenancy-schema-sql.test.ts now asserts current_org_ids()'s
  predicate (user_id = (select auth.uid()) AND status = 'active') and the FKs'
  on delete cascade, so dropping either fails CI.
- N4/N5: the plan's supersede note applies to any task naming a live-DB suite
  (Tasks 5-11, 18); Task 18's own section now carries the re-scope pointer.
- N6: Task 7's role_id guard text states why platform roles (organization_id IS
  NULL) are permitted and that the rule must not be tightened to a strict match.

## Task 7 - authorization schema, helpers and platform seed

- Four tables plus the four helpers every Task 9/10 policy calls. Tenant
  integrity is again structural: user_role_assignments carries organization_id,
  a composite FK scoping clinic_id to its own organization (MATCH SIMPLE leaves
  the org-wide NULL row unconstrained), and the role reference is guarded by
  private.guard_role_org_scope on both invitations and user_role_assignments.
- nulls not distinct is load-bearing on BOTH nullable uniques. On roles it makes
  the platform row conflict so the seed does not duplicate it; on
  user_role_assignments it makes an org-wide assignment conflict so a re-grant
  cannot duplicate it. Measured: indnullsnotdistinct = true on both indexes.
- The table-wide privilege revoke is now on the DEFAULT ACL
  (alter default privileges in schema public revoke truncate, references,
  trigger from anon, authenticated), so every table created from 00400 onward
  inherits it and no later migration repeats per-table revokes. Measured: the
  default ACL reads anon=arwdm/authenticated=arwdm.
- clinic_ids returns the EMPTY set to a non-member. The plan's "all clinics when
  the membership has no clinic_memberships rows" rule would otherwise hand the
  whole organization to anyone who asked, since a non-member has no scoping rows
  either. It does NOT filter on clinics.is_active: a deactivated clinic's records
  carry retention obligations, and filtering them would make a deactivation
  erase access to history. Deactivation is a scheduling concern; visibility is a
  record-retention concern.
- private.can admits ONLY roles of the organization being asked about
  (`r.organization_id = p_org_id`). This is load-bearing, not a simplification:
  staff.manage holders may invite a platform role and the accept flow turns that
  into an assignment, so admitting platform roles here would hand a tenant
  principal platform.tenants.manage and the rest of the platform matrix while
  profiles.is_platform_admin stayed false. Platform roles are reachable only
  through the separate platform function. Task 9 must additionally keep `roles`
  INSERT/UPDATE policies carrying `organization_id is not null`, so no tenant can
  mint a platform role in the first place.
- private.can never consults private.is_platform_admin (pinned by a test, not just
  by review): platform operators reach tenants through a separate function, and
  granting them can() would expose every tenant's patient records.
- The platform seed is INLINED in 00400 between sentinel comments rather than
  applied by scripts/apply-permissions-seed.ts, which cannot be built here:
  nothing in a Node process can apply SQL (the Composio MCP is agent-side, and
  there is no database connection or PAT), and nothing in a Node process can even
  import the generator, because gen-permissions-sql.ts imports a `@/` tsconfig
  path alias that plain Node does not resolve - vitest is its only working
  consumer. Re-running 00400 refreshes the seed; tests/unit/permissions-seed.test.ts
  fails if the inlined block drifts from lib/permissions/registry.ts. The rehearsal
  must ALSO compare the live permissions table against the registry, since only the
  file-level guard is automated.
- Rehearsed live and cleaned: clinic-scoped vs org-wide permission scope, the
  non-member leak, cross-org role and cross-org clinic rejection, the
  nulls-not-distinct dedupe, and the platform-role allowance.
- Measurement trap: set_config(..., true) is transaction-local, so batching
  several identity probes into one MCP call makes them share a transaction and
  the last identity wins. The first rehearsal run therefore reported an active
  member as a non-member. Rehearse one identity per call.

## Task 7 fix round 2 - the second escalation route, and suspension that did nothing

- private.can now refuses platform.* keys: `p_permission not like 'platform.%' and
...`. Fix round 1 made can org-strict, which closed the platform-ROLE route but
  not the platform-KEY one - permissions is a single global table with no scope
  column, so a tenant attaching platform.tenants.manage to one of its OWN roles
  satisfied the org check and got a platform permission. Enforced in code rather
  than trusted to the seed, because the registry test only proves the generator
  emits no such grant, not that the database refuses one.
- organizations.status is now enforced. It existed and was read by NOTHING, so
  suspending or archiving a tenant cut no access at all - which undercuts
  platform.tenants.manage's own description. current_org_ids, is_member and
  clinic_ids join organizations and require status = 'active'; can inherits it
  through is_member. Measured across active/suspended/archived/reactivated:
  suspension is now effective AND reversible.
- Both fixes live in 20261014000510_tenant_status_and_scope.sql rather than an
  edit to 00500: the migration-edit exception closed once 00300 landed, so from
  here on corrections are new files. History is 7 rows, 1:1 with the files.
- tests/unit/authorization-schema-sql.test.ts now reads every migration in order
  and asserts on the LAST definition of each helper, modelling create or replace,
  so a later correction file cannot hide behind an earlier one. Three assertions
  are prohibitions, because each of those mistakes leaves a working function:
  can must not mention is_platform_admin, must not admit a NULL-organization
  role, and must refuse platform.* keys. can's caller predicate is pinned too -
  without it the function degenerates to "does any member of this org hold this
  permission".

## Task 7 fix round 3 - case-insensitive platform keys, and an inaccurate claim removed

- private.can lower-cases before the platform-key refusal
  (lower(p_permission) not like 'platform.%'), in
  20261014000520_platform_key_case.sql. The refusal was case-sensitive while the
  grant match is exact text, so a key spelled Platform.tenants.manage would both
  insert and match; authenticated holds table-level INSERT on permissions by
  default, so Task 9 must also leave that reference table deny-all or read-only.
  Staged and measured: the case variant is refused, and with a positive control
  added a legitimate patients.read still returns true.
- Corrected an inaccurate claim rather than leaving it: only THREE of the four
  helpers honour organizations.status - current_org_ids, is_member and
  clinic_ids. private.is_platform_admin deliberately does not, because a platform
  operator must keep seeing suspended tenants in order to restore them. The wrong
  claim was in AGENTS.md, the file later agents are told not to re-litigate,
  where it invited an implementer to "fix" it into a tenant lockout. Task 9's
  organizations policy therefore needs an is_platform_admin branch, or an
  operator sees zero tenants.
- Task 7's review loop is declared CONVERGED by an independent reviewer (no
  Critical, no Important) after three rounds.

## Task 8 - onboarding RPC, tenant data, audit and platform schema

- private.create_organization_with_owner is the ONLY path that bootstraps an
  organization, because no RLS policy could ever let a newcomer insert the first
  membership. The org-scoped role seed is GENERATED from the registry and inlined
  in the function body with the organization id left as the plpgsql variable
  v_org_id; tests/unit/onboarding-seed.test.ts fails if it drifts. Organization
  roles are seeded here and nowhere else. The owner assignment is org-wide.
- audit_logs and platform_settings deliberately have NO foreign keys. An audit
  trail must outlive the row it describes: a cascade from organizations would
  erase a tenant's history when the tenant is deleted, and one from auth.users
  when the actor's account is closed. The test suite pins the absence as a
  prohibition, since it reads as an oversight otherwise.
- private.write_audit screens metadata with a RECURSIVE walk over objects AND
  arrays. Measured first: a jsonpath wildcard ($.**.keyvalue()) silently skips
  array elements, so {"items":[{"note":...}]} passed it - the type-filtered
  variant failed too. It is a key-name blocklist (note/notes/content, case-
  insensitive, depth 32) and therefore a speed bump, not a guarantee: summary or
  narrative passes it. Platform-scoped events (organization_id NULL) are refused
  unless private.is_platform_admin, matching the rule that platform authority is
  the profiles boolean.
- patients is the first PHI table: composite FK (organization_id, clinic_id) ->
  clinics closes cross-tenant attachment, and mrn is TEXT with no sequence
  anywhere - a global sequence would make identifiers enumerable across tenants.
  private.next_sequence_value is a single per-tenant upsert, so it is atomic by
  row lock; verified single-session (1, 2, 3) but NOT under concurrency.
- patient_identifiers references its patient ON DELETE RESTRICT with an explicit
  index on the referencing columns (its own unique on (organization_id, kind,
  value) cannot serve that FK).
- tenant_sequences is the documented exception to the standing updated_at rule:
  only the security-definer function writes it, so it maintains updated_at inline
  instead of carrying a trigger.
- tests/helpers/migration-text.ts holds readMigration and latestDefinition for all
  three invariant suites, so a correction migration cannot hide behind the file an
  older suite was written against.

## Task 8 fix round 1 - the audit trail was falsifiable by any tenant

- CRITICAL, closed: private.write_audit accepted ANY organization_id. It is
  SECURITY DEFINER owned by postgres with relforcerowsecurity = false on every
  table, so it bypasses RLS entirely and Task 9's policies were no backstop. Any
  authenticated user of the SaaS could plant fabricated rows in another tenant's
  audit trail, with unconstrained action/resource_type text, carrying clinical
  free text through those columns instead of the screened metadata. It now
  requires private.is_member(p_org_id), which also refuses writes for a suspended
  tenant. private.next_sequence_value had the identical hole and the identical
  guard - cross-tenant counter bumping is what RLS on tenant_sequences exists to
  prevent. Both measured 42501.
- The audit screen's depth bound was defeatable (a key nested 33 levels passed)
  while the header claimed the walk descended "at any depth". jsonb is a tree and
  cannot be cyclic, so the recursion terminates on its own - the predicate was
  only a hole, and it is gone. Measured: depth-33 note blocked, same payload with
  a clean key accepted.
- Added an 8 KiB metadata cap: each node in the walk becomes two CTE rows carrying
  a jsonb copy, so an unbounded array was reachable by any authenticated user as a
  denial-of-service vector, and a large string value would have been stored as one
  enormous row. Measured 23514 on a 9 KB payload.
- Append-only no longer depends on a promise about a future file: authenticated
  held INSERT/UPDATE/DELETE on audit_logs from Supabase's default grants (00400's
  default-ACL revoke covers only truncate/references/trigger), so the property
  rested entirely on Task 9 writing no update policy. Now revoked at the table;
  SELECT retained so Task 9's select-only policy is unaffected and write_audit
  still writes as the owner.
- The free-text screen remains a key-name blocklist: summary, narrative, a
  misspelling, or a key with surrounding whitespace all pass it. Recorded as a
  speed bump, not a guarantee.
- Forward risks recorded: organization creation is uncapped (app-layer rate limit,
  and each call row-locks 21 global permissions rows so concurrent onboardings
  serialize); a platform-scoped audit event is unreachable from service_role
  because auth.uid() is NULL, so Task 13 needs a sanctioned path; and whether the
  private schema is reachable from PostgREST at all is UNRESOLVED
  (pgrst.db_schemas is not readable from SQL) - settle it before Task 12.

## Task 8 convergence

- Task 8's review loop is CONVERGED: an independent re-review found 0 Critical and
  0 Important outstanding after one fix round. C1/I1/I2/I3/I5 are closed in the
  deployed database, not merely narrowed.
- Evidence worth keeping: the reviewer mutation-tested the invariant suite against
  six realistic regressions (deleting either is_member guard, re-adding the depth
  bound, deleting the size cap, deleting the audit_logs revoke, swapping is_member
  for the weaker is_platform_admin) and all six were killed.
- Carried forward: a platform operator cannot write an org-scoped audit row for a
  tenant they are not an active member of, so the SUSPENSION audit event has no
  writer - a completeness gap for Task 13's sanctioned path, not a hole. The 8 KiB
  cap bounds metadata only; action and resource_type remain unconstrained text. The
  deployed write_audit body equals the committed file minus its inline comments (zero
  behavioural delta) - the drift class the reviewer raised, recurring in the round
  that promised an md5 check.
- AGENTS.md wording corrected: the membership check binds definer functions that
  WRITE rows for an organization, not every helper that takes an organization id -
  is_member is that predicate and must not check itself.

## Task 8 fix round 2 - all five convergence Minors closed

- The writer predicate on private.write_audit is now is_member OR
  is_platform_admin. The org-strict version had left the suspension audit event
  with no writer: recording it means writing an org-scoped row for an
  organization the operator is not, and must not be, an active member of. A
  platform administrator's authority is the profiles boolean, not a role, and a
  tenant can never satisfy that alternative. Measured with the organization
  suspended: the administrator's organization.suspended row written, the tenant in
  that organization 42501, a cross-tenant tenant write 42501.
- p_action (128 bytes) and p_resource_type (64 bytes) are now bounded alongside
  the 8 KiB metadata cap. Those two columns are exactly what the metadata screen
  concedes it cannot police, so an unbounded value there was an unbounded row.
- Measured and recorded for the first time: md5(pg_proc.prosrc) against the last
  create or replace in the migration files, comments stripped, because Postgres
  does not store them. Seven of eight private functions match byte-for-byte;
  create_organization_with_owner drifts 9055 vs 8297 purely from whitespace in my
  re-apply, with substance proven identical by sorted-set md5s. RUN THIS AFTER
  EVERY APPLY - a file-only drift guard structurally cannot see a bad apply,
  which is how two of this task's own errors reached the database unnoticed.

## Integration tests: catalogue assertions are real tests again

- The standing ruling that every DB-state assertion be discharged as a
  controller-run rehearsal is SUPERSEDED for CATALOGUE assertions.
  `tests/integration/helpers/database.ts` opens a direct Postgres connection from
  TEST_DATABASE_URL, which is the only way to read pg_proc, pg_policies,
  pg_constraint and pg_index - PostgREST returns none of them.
- tests/integration/tenancy-schema.test.ts is the first real integration file: six
  tables with RLS enabled, both clinic_memberships foreign keys composite and
  spanning organization_id, citext unique slug, both nulls-not-distinct uniques,
  the UPDATE-only guard trigger, the four updated_at triggers, current_org_ids as a
  stable definer with search_path="" that anon cannot execute or even reach the
  schema for, TRUNCATE/REFERENCES/TRIGGER revoked, and migration history 1:1 with
  the files on disk.
- The suite SKIPS when TEST_DATABASE_URL is absent so a contributor without the
  database password still gets a green npm run test - but CI=true or
  REQUIRE_TEST_DATABASE_URL=true makes a missing URL FAIL instead, because a
  suite that skips silently in CI is how coverage rots unnoticed. Both paths print
  one line saying which happened.
- The secret never enters code: TEST_DATABASE_URL is read from the environment or
  .env.local (both gitignored) and no connection string is ever built by
  concatenation, so check-no-secrets has nothing to flag. .env.example carries an
  inert placeholder documenting the pooler form.
- BEHAVIOURAL assertions still cannot run and stay controller rehearsals: every
  table is RLS deny-all until Task 9, and the helpers live in private, whose
  PostgREST exposure is still unresolved. Task 18's isolation harness now has a
  path - direct connection for the catalogue half, PostgREST with real user JWTs
  for the isolation half.
- These tests connect as the database owner and therefore bypass RLS. They can
  inspect the catalogue; they cannot prove tenant isolation, and must never be
  cited as if they did.

### Measured: use the pooler, not the direct host

- TEST_DATABASE_URL pointed at db.<project-ref>.supabase.co:5432 with user
  postgres, and every test failed with `getaddrinfo ENOTFOUND`. Measured from
  this machine: that hostname does NOT resolve, while
  aws-0-ap-south-1.pooler.supabase.com resolves and accepts TCP on both 5432 and 6543. The pooler username is postgres.<project-ref>, not plain postgres. With
  the pooler form the suite runs: 11/11 pass against the live catalogue.
- Two of those 11 failed on first run because MY expectations were stale, not
  because the database was wrong - the table list was compared in declaration
  order against a name-ordered query, and the updated_at trigger list was missing
  `patients`, which Task 8 added. Both fixed. This is the value of the suite
  working: it disagrees with you loudly.
- The suite connects as the database owner and bypasses RLS. It can inspect the
  catalogue; it cannot prove tenant isolation.

### Task 9: behavioural assertions DO run over a direct connection

The Task 8 note above - "BEHAVIOURAL assertions still cannot run" - is
**SUPERSEDED**, and it was wrong to write. It reasoned from PostgREST, but the
blocker was never PostgREST.

Measured: `set local role authenticated` plus
`select set_config('request.jwt.claim.sub', $1, true)` reproduces, inside a plain
`pg` transaction, exactly the principal PostgREST builds from a user's JWT. Both
statements are transaction-local, so `rollback` restores both. That makes real
behaviour testable with no HTTP layer and no JWT signing:

- `tests/integration/onboarding-rpc.test.ts` - calls the RPC as a tenant and
  counts what it created.
- `tests/integration/audit-log.test.ts` - the refusals in `write_audit`, which
  are the assertions that matter most because Task 9's policies are NOT a
  backstop for it (SECURITY DEFINER, owner `postgres`, `relforcerowsecurity =
false`).
- Both roll back, so the suite leaves no tenant-shaped rows behind. That matters
  more than usual here.

What this still does NOT cover: PostgREST itself - schema exposure, JWT
verification, HTTP behaviour - and therefore tenant isolation through the real
API. That stays Task 18's job. The direct connection is the wrong tool for
isolation testing regardless, because the owner bypasses RLS.

#### Asserting the DATABASE matches the registry, not just the file

`onboarding-rpc.test.ts` computes its expected grant count from
`lib/permissions/registry.ts` rather than hard-coding a literal. This is
deliberate and it is a different assertion from the existing drift tests:
`onboarding-seed.test.ts` proves the MIGRATION FILE matches the registry, and
this proves the DATABASE does. Those failed separately, twice, in this project -
the file was regenerated while the database kept the old matrix.

#### Two traps the suite hit on its first run

1. **A rejected statement aborts its whole transaction.** Asserting two failures
   in a row reports "current transaction is aborted" for the second one, which
   reads as a broken guard when the guard is fine - the exact false negative the
   earlier rehearsals produced. `expectRejection` in
   `tests/integration/helpers/database.ts` wraps each expected failure in its own
   savepoint. Without it, five tests lied at once.
2. **`has_table_privilege(...) as delete` is a syntax error.** DELETE and SELECT
   are reserved; the aliases must be `can_delete` / `can_select`. Caught by
   running, not by reading.

Also worth recording: my own first draft asserted both that `public` holds no
sequences and that `audit_logs.id` is bigint from a `bigserial`. Those
contradict. `patients.mrn` is the thing that must not be sequence-backed
(enumerable across tenants, and a format baked into the schema); `audit_logs`
deliberately has one. Narrowed to `no sequence is owned by patients`, plus the
exact expected set `['audit_logs_id_seq']` so a new sequence cannot appear
unnoticed.

Every refusal test carries a positive control. A guard that refused everything
would satisfy each failure case on its own.

### Task 9: `migration-applier.test.ts` closed as obsolete

The plan named `tests/integration/migration-applier.test.ts`, which would have
"applied a migration" and asserted it landed. That test cannot exist: the
premise was that a Node script applies migrations, and it does not - a Node
script cannot reach the Composio MCP and there is no Supabase PAT. The script
emits a manifest; the agent applies. A test cannot assert a database effect by
calling a thing that has none.

The script's real obligations (name validity, ordering, idempotency-key
derivation) are covered by `tests/unit/migration-manifest.test.ts`. The
database's real state is covered per-task by the `md5(prosrc)` comparison plus
the catalogue assertions in `tests/integration/`. The plan and this log now say
so, so the next agent does not go looking for a missing file.

### Task 9 correction: the skip guard was missing from four suites

Measured, after a commit whose message implied these tests would skip without a
URL: a bare `npm run test` **failed all 34** with `ENOTFOUND`, it did not skip.

Cause: the skip policy lived inline in `tenancy-schema.test.ts` as 14 lines of
`missing` / `mustRun` / `dbDescribe` boilerplate, and the four later files never
copied it. It is now `dbDescribe` in `tests/integration/helpers/database.ts`,
used by all five - boilerplate that can be forgotten is boilerplate in the wrong
place.

Measured, all three branches:

| Condition                                  | Result                                         |
| ------------------------------------------ | ---------------------------------------------- |
| bad URL present (`.env.local` direct host) | **34 fail**, `ENOTFOUND` - loud                |
| no URL at all                              | **34 skipped**, suite green                    |
| no URL + `CI=true`                         | **34 fail**, prints "required here but absent" |

Only ABSENCE skips. A present-but-wrong URL fails on purpose: a suite that
silently skipped while pointed at the wrong database would report coverage it
does not have. That distinction is the whole point of the guard and is now
written down next to it.

**The repository is currently RED on a bare `npm run test` and stays that way
until `TEST_DATABASE_URL` in `.env.local` is changed to the pooler form.** The
agent does not edit `.env.local`; it is operator-owned and gitignored. The fix:

    TEST_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres

Two things make the direct host wrong here, and both are easy to miss: it is
**IPv6-only** (so DNS fails from an IPv4-only machine, which is why the failure
mode is ENOTFOUND rather than a timeout), and the pooler requires the username
`postgres.<project-ref>`, not plain `postgres`. Supabase's dashboard shows the
direct connection string first, which is how the wrong value got pasted in.

### Task 9: RLS applied. 39 policies across 14 of 15 tables.

Baseline before this task: 15 tables, RLS enabled, **zero policies**, `authenticated`
holding INSERT/UPDATE/DELETE on every one of them. Deny-all was the only thing
containing that.

After: 39 policies. `tenant_sequences` has none by design - its only writer is the
`next_sequence_value` definer, and its writes are revoked.

Verified in `tests/security/rls-policies.test.ts`, 17 tests. The catalogue half
asserts the exact policy set - name, command, non-null qual/with_check, and the
**total**, so an unlisted policy fails the test. The behavioural half is the security
argument: it impersonates principals and asserts what each can see.

#### The clinic-scope conjunction is tested from both sides

`private.can` and `private.clinic_ids` are independent authorities, and the suite
pins each one separately:

- **alice** holds a clinic-scoped assignment in clinic 1, and no clinic_memberships,
  so `clinic_ids` returns every active clinic. Only `can` stops her. Drop that clause
  and she reads another clinic's patients.
- **bob** holds an org-wide assignment but a `clinic_memberships` row limiting him to
  clinic 1, so `can` permits every clinic. Only `clinic_ids` stops him. Drop that
  clause and he reads another clinic's patients.

One test would not have found either defect.

#### Correction 01210: patient_identifiers was wrong, and wrong quietly

The original policy carried its own two-argument `can(organization_id,
'patients.read')` beside the EXISTS on the parent patient. Redundant - the patients
policy already decides - and wrong, because the two-argument form passes only an
ORG-WIDE assignment: its predicate is `a.clinic_id is null or a.clinic_id = NULL`.

MEASURED consequence: a clinic-scoped doctor could read their patients and then found
none of their identifiers. An MRN present on one screen and absent from the next, with
no error anywhere in the stack. This is the same fail-closed-for-the-wrong-reason
shape the plan warns about for the two-argument `can`, reached from a different
direction. The identifiers policies now delegate both permission and clinic to the
patients policies.

#### Three measurement traps this task added

1. **The applier derives `schema_migrations.version` from a second-resolution
   timestamp.** Two applies batched into one Composio call collide on
   `schema_migrations_pkey` (23505), and `idempotency_key` does not prevent it. One
   apply per call, always.
2. **`resetRole()` returns to the SESSION USER**, which is postgres - the table owner,
   which bypasses RLS. A test that calls it before asserting is measuring postgres, not
   the principal. One assertion here did exactly that and passed while counting a row
   the principal cannot see.
3. **RLS filters a non-permitted UPDATE/DELETE out of the row set rather than raising.**
   The statement succeeds and affects zero rows. "It threw" is therefore the wrong
   assertion for a filtered write; assert on the RETURNING rows and on the unchanged
   value. Asserting a throw would also pass against a policy set that filtered nothing
   and failed for an unrelated reason.

#### Carried forward

- A platform administrator cannot edit their own `profiles` row through the client
  (`is_platform_admin is not true` in the WITH CHECK, which also avoids an RLS
  self-reference). Service role only. Cosmetic, safe direction.
- `organization_memberships` INSERT and DELETE are closed. The invitation-acceptance
  RPC must write memberships as a definer.
- Whether PostgREST exposes `private` is still unresolved and still matters for Task 12.

### Task 9 review and fix pass

An independent review on a fresh context was dispatched against commit a9d83b3 with
an explicit instruction not to modify any file. It EXECUTED every finding against the
live database rather than reasoning about it. Twelve findings. I had independently
found the Critical one myself by probe before its report arrived; the two paths
agreed.

Four fixes applied in `20261014001220_privilege_gates.sql`, corrections as a new file
so 00900-01210 stand as applied. Each had a test written first and watched fail.

#### Critical, fixed: `organization_memberships` UPDATE was a tenant-enrolment primitive

Gated on bare `is_member`, in both USING and WITH CHECK. This table IS the tenant
boundary - `current_org_ids`, `is_member` and `clinic_ids` all read it.

MEASURED, as a member holding **no role at all**: rewriting another member's row's
`user_id` to an arbitrary `auth.users` id changed 1 row. The outsider then read the
tenant's organizations, its clinics and its whole staff roster. The same principal
could restore a deliberately revoked employee, or suspend the administrator who
locked them out. No `audit_logs` row either - tenant writes to it were revoked in
Task 8, so there was no trace.

INSERT was already closed, and closing it was the policy's stated intent - "stops a
tenant from manufacturing a membership". UPDATE defeated exactly that intent. Now
gated on `staff.manage`, the permission that means "manages staff".

No PHI was reachable: `can()` separately requires a role assignment, so this was
directory-level disclosure and tenancy tampering, not clinical exposure.

#### Important, fixed: three more loose USING clauses

- **`roles` DELETE had no `is_system` floor.** MEASURED: an org_admin deleting the
  org_admin role cascaded away six role_permissions and its assignments, dropping the
  deleter's own `settings.manage` and `staff.manage`. Re-creating the role then
  failed, because creating one REQUIRES `settings.manage` - the delete had just taken
  it. The tenant had no administrators and **no client path to repair that**. This was
  also an addition the plan did not ask for: it specified only INSERT/UPDATE on roles.
- **`organizations` UPDATE was also bare `is_member`.** MEASURED: a clinician with no
  permissions set `currency='XXX'`. Not cosmetic - money is bigint minor units OF the
  tenant's currency, so flipping it relabels every stored amount; `timezone` feeds the
  `clinicDayBounds` report windows; `slug` is the tenant's public identifier. Now
  `settings.manage`, with the platform branch left unconditional so an operator can
  still restore a tenant.
- **`roles` UPDATE carried `settings.manage` in its WITH CHECK but not its USING** -
  the only asymmetric policy in the set. Not a hole, but it made an unprivileged
  UPDATE raise 42501 where every other policy filters silently, so a caller could not
  distinguish "not permitted" from "no such row".

#### Important, fixed: the suite could not tell a refusal from an absence

The reviewer's mutation test is the finding worth keeping: replacing
`patients_write`, `patient_identifiers_write` and `role_permissions_write` with
`with check (false)` left the policy count at 39 and the qual/with_check assertions
passing, because `false` is non-null - and **every test in the file still passed**
with three tenant tables made permanently unwritable. One table of twelve had a
positive control.

Five new tests now prove an authorised write succeeds on patients (create, edit,
delete), patient_identifiers, role_permissions, clinics and clinic_memberships. They
passed BEFORE the fix, which is itself the answer: those policies were correct, and the
gap was only ever coverage.

A second, subtler half: for INSERT refusals, a _deleted_ policy and a _refusing_ one
raise the identical message, so `it("refuses...")` cannot tell them apart. Only the
positive control can. My own new tests got this wrong first - they asserted `[]` on a
refused INSERT, which cannot happen, because a failed WITH CHECK raises rather than
filtering. That asymmetry is now written into the tests.

#### Minor, fixed here

- An assignment or invitation could name a **platform role** (organization_id NULL).
  Inert - `can()` refuses platform keys - and the only real barriers were that
  `roles_select` hides the id and UUIDs are unguessable. Neither is a control, and the
  acceptance RPC that would resolve it is Task 12. Now refused at the policy layer.
- `invitations.clinic_ids` is a bare `uuid[]`, which cannot carry the composite foreign
  key every other tenant reference in this schema uses, so a cross-tenant clinic id
  could be stored. Latent - the composite FK would reject it at accept time - but it
  reintroduced exactly the reference the design otherwise eliminates. Now checked.
- Documented that `clinics` has no INSERT policy, the only client-side closure with
  nothing recording it.

#### Minor, ledgered not fixed

- **A platform operator cannot read the audit trail of the tenant they are restoring.**
  DECLINED, deliberately: `audit_logs.metadata` is PHI-shaped and tenant-scoped, and
  granting an operator blanket read of it is a larger disclosure than the restoration
  workflow needs. The suspension reason belongs on the organizations row. If a
  restoration ever needs "why", that is a product decision, not a policy default.
- **A `staff.manage` holder can self-grant `organization_owner`.** Owned by Task 12:
  the registry carries an explicit GRANT-CEILING OBLIGATION saying the permission model
  cannot express hierarchy. The database has no backstop and the suite tests none of
  it. Recorded so it is not lost, not fixed here.
- **`patients.read` versus `patients.export`.** RLS is row-level and grants no column
  or aggregate control; `patient_identifiers_select` hands a read-only holder every
  identifier value, one row at a time. Belongs to whichever task builds the export
  flow.

#### What the review confirmed as correct

The three-clause clinic conjunction holds from both sides; platform-permission
escalation is closed on both spellings including the case variant; `profiles` is
airtight; append-only and the closed tables rest on revoked grants rather than on
policy absence; TRUNCATE/REFERENCES/TRIGGER are revoked on all 15 tables; no `to anon`
policy and no `force row level security` anywhere; and the `patient_identifiers`
delegation does NOT rest on an ordering assumption - the EXISTS is evaluated as the
querying user so `patients_select` applies, and the composite FK pins the
organization.

### Task 9 re-review: two of the four fixes did not hold

A second independent review, fresh context, aimed at the fix pass rather than the original
work. It re-executed every exploit and, more usefully, hunted for what the fixes BROKE. Ten
findings. Two of my four Important/Critical fixes were inert.

#### The lesson I wrote into AGENTS.md was false

01220 gated `roles` DELETE on `is_system is not true`. `scripts/gen-permissions-sql.ts:158`
populates that column from `role.isPlatform`, so **every tenant-seeded role is
`is_system = false`** - measured against a tenant built by the real onboarding RPC, all
fourteen. The clause was therefore equivalent to the `organization_id is not null` already
sitting beside it: a no-op.

Worse, the test that "proved" the fix hand-seeded its fixture with `is_system = true`, a
state no production path produces. It proved the clause works against a fixture the product
can never reach. The lockout it was written for still reproduces exactly:

```
DELETE organization_owner        -> rows: 1
grants cascaded: 0 | assignments left: 0
re-create the role               -> refused: new row violates row-level security policy
```

That is a tenant with no assignments and no way to make any, and I had already written the
false claim into `AGENTS.md` in the same commit.

**There are now three descriptions of `roles.is_system` and no two agree**: the plan says
"marks seeded roles", the generator emits `isPlatform`, and the generator's own header
comment repeats the plan's claim. That single disagreement is what made the defect
invisible to two review passes. `01230` stops relying on the column and uses the real
invariant - `not private.role_in_use(id)`, a role nobody holds can be deleted - so the guard
holds whatever `is_system` means. **The disagreement itself is still open** and is recorded
for whoever owns the seed.

#### Second non-holding fix: `user_role_assignments_update` never got the guard

01220 added the EXISTS to the INSERT. The UPDATE did not get it, and
`guard_role_org_scope` permits a platform role by design - so re-pointing an assignment at
the platform role succeeded on UPDATE while the identical move on INSERT was refused. Inert
today (`can()` is org-strict), but the stated purpose of that fix was to stop saying no now
rather than leaving it to a later task to remember, and half the statement types still said
yes.

#### Also fixed

- **`roles` UPDATE freely changed `key` and `is_system`.** `key` is the identity the registry
  maps through; `is_system` is the delete guard's input. Both are now pinned by a
  `BEFORE UPDATE` trigger - it has to be, because a policy would need a subquery on `roles`
  from inside `roles`' own policy, which is the infinite-recursion case, and a subquery sees
  the row as it is NOW rather than as it was.
- **Seven more command policies could be neutered to `with check (false)` with all 29 tests
  green.** `roles_update`, `invitations_update`, `invitations_delete`,
  `user_role_assignments_update`, `user_role_assignments_delete`,
  `role_permissions_update`, `patient_identifiers_update`. All seven now have an authorised
  write exercised. My own test asserting "alice cannot update roles" was the very
  anti-pattern the file's header warns about - green against a policy refusing everybody -
  and now carries a positive control.

#### A false comment, corrected rather than papered over

01220 asserted that a member could not suspend their own organization, "by accident",
because `is_member` requires `status = 'active'` on the new row. That is wrong: `is_member`
is `STABLE`, so inside a `WITH CHECK` it reads the **statement-start snapshot** - the OLD row.
Measured: an org_admin suspended their own tenant successfully, after which the row vanished
from every query and reactivation returned zero rows. Row-level security cannot express
"only this column may change status"; closing it properly means a definer RPC, which belongs
with tenant administration. **Left open and recorded, not declared fixed.**

#### Open findings carried forward, with exact repro

- **CRITICAL, unchanged and re-confirmed: a `staff.manage` holder can self-grant
  `organization_owner` in one statement.** Measured as `medical_director` (staff.manage, no
  settings.manage): self-assign owner, then add `patients.export`, then re-slug the
  organization, then delete the admin role. Four statements, no `settings.manage` at any
  point. I previously declined this as "Task 12's job", which was too generous: Task 12's RPC
  is an ADDITIONAL route, and the direct table write stays reachable from any client holding
  the user's JWT. It is genuinely not fixable in RLS without the role hierarchy the registry
  says it cannot express - a strict subset ceiling would also break the legitimate
  admin-creates-owner flow. **This is the top open risk.**
- **Privilege pre-staging:** an assignment can be written for a `user_id` belonging to no
  organization. Inert until that account gains membership by any route - including the Task 12
  acceptance RPC this fix pass defers to.
- `organization_memberships` can move a membership between organizations, dragging an
  org-wide assignment with it. No privilege carries; the composite FK blocks it when the
  membership has clinics, and MATCH SIMPLE does not block org-wide rows.
- The platform branch on `organizations` UPDATE is unconditional over every column, not just
  `status`. Restoration needs `status`; an operator can also rewrite `slug`/`currency`/`name`.
- TRUNCATE/REFERENCES/TRIGGER are revoked on all 15 tables (measured), but no test asserts it,
  and `00400`'s `alter default privileges` binds only objects created after it - the six Task 6
  tables predate it and rely on `00310`'s explicit revoke.
- `patients.read` versus `patients.export`: RLS is row-level and grants no column or aggregate
  control, so a read-only holder can walk every identifier value.

#### New database trap

`pg_catalog.pg_triggers` **does not exist** on this PostgreSQL 17.11 build - `to_regclass`
returns NULL. The trigger catalogue is `pg_trigger`. A guarded `create trigger` written
against `pg_triggers` fails with 42P01 and the whole migration rolls back. Measured, not
assumed.

### Task 9 third review: I was wrong twice, and both errors were mine to measure

A third independent review, fresh context, asked to verify every finding from the first two
AND to challenge my judgement about the ones I deliberately left open. Ten more findings.
Two CRITICAL and one IMPORTANT are now fixed in `01240`; three of my own rulings were
overturned.

#### I declined the top risk on a premise I never measured, and the premise was false

I twice declined a grant ceiling because "a strict subset ceiling would also break the
legitimate admin-creates-owner flow". I had never tested it.

MEASURED, against a tenant built by the real onboarding RPC: `organization_owner` and
`organization_admin` carry **byte-identical 17-permission sets** (owner-only keys: none).
So an org_admin holding all seventeen passes a subset ceiling completely unchanged. The
flow I claimed the ceiling would break does not exist, and the ceiling is eight lines:

    select not exists (select 1 from public.role_permissions rp
      where rp.role_id = p_role_id and not private.can(p_org_id, rp.permission_key, null))

Verified by execution: a `medical_director` self-assigning `organization_owner` now
raises; an `org_admin` assigning `organization_owner` to a colleague still succeeds, as
does assigning `clinic_admin` and `clinician` (both strict subsets). The only thing it
blocks is granting a role strictly above your own permissions - which is the escalation.

I do not need a role hierarchy. The registry's GRANT-CEILING OBLIGATION is about the
CLIENT model; this is the database half of the same rule, and I conflated the two.

#### A second CRITICAL that was in no ledger at all

A `settings.manage` holder could mint **any** permission key, including one its own role
deliberately withholds. Measured as `clinic_admin`: add `subscription.manage` to its own
role, assign it to itself - OK. Two statements. `clinic_admin` is a clinic-level tenant
role, so the blast radius is wider than the `staff.manage` path, and nobody - including
three review passes - had recorded it.

`role_permissions` has no `organization_id` column, which is the whole reason its
policies reach through `roles`, so the key ceiling is `private.can(r.organization_id,
permission_key)` INSIDE the existing EXISTS rather than a separate helper. One fewer
function to keep correct, and it cannot be called with a mismatched organization.

#### The lockout `01230` exists to prevent was reachable through the wrong table

`01230` guards `roles` DELETE. The same lockout is reachable in ONE statement through
`role_permissions`: clear every grant from your own admin role, and the tenant has zero
grants, zero ways to make any, and no client repair path - through the role editor's
"clear all permissions" button, which is going to ship. The guard was on the wrong table
for the invariant. `role_permissions_delete` now refuses to strip a role the caller
holds; strip one you do not hold and it still works.

#### private.role_in_use was a cross-tenant oracle I introduced

It took a role_id and returned a boolean about ANY role, so a member of one tenant could
probe another's: measured, a member of org B reading true for an org A role, false for an
unused one, true for the platform role. It was the only helper whose answer was not
scoped to `auth.uid()`. PostgreSQL does not check EXECUTE when invoking a trigger
function, so the check moved into a `BEFORE DELETE` trigger and **the grant was revoked
outright**. Measured after: the delete raises "role org_admin is still in use", a direct
call returns permission denied, an unused role still deletes.

#### Two more of my own tests were passing for no reason

Both were the same mistake, and it is the fourth time in this task: **a refusal test that
matches zero rows proves nothing.** One named a role key the fixture never creates, so the
INSERT selected nothing and never evaluated the WITH CHECK. The other relied on
`roles_select` returning rows for a principal the fixture had never made a member of, so
again zero rows. Both now target rows that exist, and both say why in a comment.

Also corrected: `01230`'s claim that "revoke the assignments, then drop the role" is the
intact workflow is false - `role_in_use` counts grants as well as assignments, so BOTH must
go. Third false claim recorded as fact in this task. And `AGENTS.md` said 18 history rows
when there were 20; the same commit that added the `01230` lesson left the count beside it
stale.

#### Confirmed still open, with the reviewer disagreeing on one

- **Self-suspension by a `settings.manage` holder.** Re-confirmed by execution. The
  reviewer disagrees with my "RLS cannot express a column rule" reasoning: a `BEFORE
UPDATE` trigger on `organizations` - the same pattern `guard_role_identity` already uses
  - can refuse a `status` change by anyone who is not a platform administrator, without
    touching grants and without breaking the operator's restore path. I am not persuaded
    that a tenant admin may suspend their own tenant is intended behaviour, but it is
    genuinely a product decision, so it stays open and is now cheap to close.
- Privilege pre-staging, the cross-organization membership move, the platform branch
  breadth on `organizations` UPDATE, the untested TRUNCATE revoke, and
  `patients.read` vs `patients.export` - the reviewer AGREED with deferring all five.
- `roles.is_system` is now **write-only and inert**: nothing reads it (only
  `gen-permissions-sql.ts` writes it, `00400`/`00600` seed it, `guard_role_identity`
  freezes it). Recommendation to accept: change ONE of the three descriptions rather than
  leaving two comments asserting a meaning no code implements.
- `clinic_memberships_select` has no self branch unlike `user_role_assignments_select`.
  Judged not a gap: a user gets their clinic scope from `private.clinic_ids()`, which is
  the intended accessor, so adding a branch would widen the surface for nothing.

#### The pattern all three reviews missed

Review 1 looked at USING looseness. Review 2 looked at neuterability. Both looked at
_policies_. Nobody asked what invariant each table's write path has to preserve - so both
stayed inside the `roles` table while the same lockout and the same escalation both
remained reachable from `role_permissions`. Three of the four escalations in this task
were closed by ONE idea: a definer permission predicate, ~10 lines, no hierarchy.

### RESOLVED: PostgREST does NOT expose the `private` schema

Question open since Task 5. Answered by asking the API rather than the database, because
`pgrst.db_schemas` is unreadable from SQL — and the API turns out to state the answer in
its own error messages.

    GET /rest/v1/  (service_role)  ->  200, info.title = "standard public schema"
    exposed tables  = the 15 public tables, nothing else
    exposed RPCs    = exactly one: rls_auto_enable, a Supabase management helper, not ours
    components.schemas = empty

And the decisive evidence, because PostgREST names the schema it searched:

    POST /rest/v1/rpc/create_organization_with_owner
      -> 404 PGRST202 "Searched for the function public.create_organization_with_owner ..."
    POST /rest/v1/rpc/is_platform_admin
      -> 404 PGRST202 "Searched for the function public.is_platform_admin ..."

So `private` is not exposed, and **the search path is `public` only** - not public-first,
not public-plus-private. Every `private.*` function is unreachable from the client.

#### CONSEQUENCE, and it is a hard Task 12 dependency rather than a contingency

**`private.create_organization_with_owner` - the onboarding RPC - is not callable from
the browser.** So are all eleven other helpers. Most of them do not need to be: RLS
enforces everything, and the client has no business asking "can I read this?" directly.
But onboarding does need to be callable, and today it is not.

Task 12 therefore needs EITHER `public` wrappers that check their arguments and delegate
to the `private` originals, OR the two client-reachable functions moved to `public`. The
wrapper route is the smaller change and keeps the authorization primitives in one place,
which is where they have stayed since Task 5. Recording this as a DECISION FOR TASK 12,
not as something to discover there.

#### The BOM nearly gave me the wrong answer

The first three probes all returned **PGRST102 "Empty or invalid json"** - a body-parse
error, which is indistinguishable at a glance from "the function does not exist". It was
`Set-Content -Encoding utf8` in Windows PowerShell prepending a UTF-8 BOM to the JSON
body. With `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` the same three
calls returned PGRST202 naming `public`.

This is the same BOM trap already recorded in this project, in a new place, and the
failure mode is unusually nasty: **a tooling artifact produces exactly the answer you
were looking for.** Anyone repeating this check with `Set-Content` will conclude the
private functions ARE exposed. It is now in `tests/security/rls-policies.test.ts`'s
sibling documentation and here for that reason.

#### What this does NOT resolve

Still unverified: JWT verification and the HTTP layer in general. What is now proven is
the schema exposure, which was the specific question. Tenant isolation through the real
API remains Task 18's harness.

### RESOLVED: JWT verification and the HTTP layer, tested with real tokens and real HTTP

Every RLS assertion in Task 9 impersonated principals over a direct `pg` connection
running as the table OWNER, which BYPASSES RLS. That is a reasonable proxy and it is not
the product. So: three real auth users created through the Auth admin API, three real
signed JWTs obtained via the password grant, and every check issued over HTTPS to
PostgREST. 14/14 passed.

**Tenant isolation, over HTTP, with real JWTs**

    alice (org 1, holds patients.read)  -> [{"mrn":"P-1"}]     only her own org
    bob   (org 2 member, NO permission) -> []                    membership is not permission
    carol (no membership at all)        -> []                    correct
    alice reads her own profile         -> 1 row
    alice reads bob's profile           -> 0 rows
    alice PATCHes her own org's patient -> 1 row, value changed
    alice PATCHes org 2's patient       -> 0 rows, no error, DB unchanged

The write result matters as much as the refusals: it proves the write path works
end-to-end through the real API and not merely that writes are blocked. And "0 rows, no
error" is the same silent-filter shape the direct-connection tests showed, now
confirmed through PostgREST rather than assumed from it.

**JWT verification is real**

    signature flipped one character                          -> 401
    forged signature                                         -> 401
    payload rewritten to role:service_role, valid signature  -> 401
    garbage token                                            -> 401
    empty token                                              -> 401

The third is the one worth having. Rewriting the payload to claim
`role: service_role` while keeping alice's genuine signature is rejected with PGRST301,
which means PostgREST validates the signature across the whole token - the role claim
cannot be tampered with. This is the HTTP-layer half of the Task 5 ruling that no
database-layer check can identify the service role: the signature is what does it, and
it does it before the request ever reaches a policy.

**Still not covered by this, deliberately**

Point-in-time verification of THIS project's configuration. Not tested: rate limiting,
CORS, error-message leakage, connection pooling behaviour under load, or what a
PostgREST upgrade would do to schema exposure. And a `db_schemas` change would silently
reopen the `private`-exposure question - the measurement is cheap to repeat and now
documented well enough to do so.

**Cleanup ordering, learned the hard way**

`delete from organizations` alone does NOT clean up a probe tenant: `patients` and
`clinics` block it. The first run's cleanup used `.catch(() => {})`, so the failure was
invisible and it left 2 organizations behind - caught only because the script reported
its own residual row counts. Delete children first, and never swallow the error.
Residual after this run: orgs 0, users 0, profiles 0, patients 0, roles 1 (the `00400`
platform seed, expected).

### Task 10: storage buckets and tenant-scoped object policies

Review, then re-review, then a hardening pass. 487 tests green across 19 files.

#### What the storage model is, and why it carries the whole security argument

Every table in this schema carries `organization_id` with a composite foreign key, so
a row physically cannot reference another tenant. `storage.objects` has neither: its
tenancy is the object NAME, a text path, and a text path cannot carry a foreign key.
The project's "composite tenant FKs" constraint is satisfied here BY POLICY rather than
by constraint. Written into the migration header so nobody relaxes a clause without
knowing.

Path shape and permission mapping, both operator-confirmed. Clinical buckets are
`<org>/<clinic>/<file>`, org-assets is `<org>/<file>`. `storage.foldername()` returns
every segment EXCEPT the last, which is what makes that shape unambiguous per bucket
instead of inferred from whether a segment looks like a UUID.

#### CRITICAL, caught by review: a read permission authorised writes

`format()` fills `%s` POSITIONALLY, and 01300 selected between four templates with ONE
shared argument list. The one-placeholder INSERT and DELETE branches consumed the first
argument - the READ predicate. Only UPDATE's three placeholders ever reached
`write_predicate`. Measured against the applied catalogue before fixing:

    patient-documents_insert      demanded 'patients.read'        should be patients.update
    patient-documents_delete      demanded 'patients.read'        should be patients.update
    clinical-attachments_insert   demanded 'encounters.read'      should be encounters.write
    clinical-attachments_delete   demanded 'encounters.read'      should be encounters.write
    investigation-reports_insert  demanded 'investigations.order' should be investigations.verify
    investigation-reports_delete  demanded 'investigations.order' should be investigations.verify

A clinician holding a read-only permission set could create and permanently delete PHI
on three of the five buckets. Sharpest case: a doctor holding investigations.order but
NOT investigations.verify could file a result document for an investigation they may not
verify, indistinguishable in the record from a verified result.

**The fix is structural, not clever: one template per call site**, each carrying exactly
the arguments it consumes, so no shared list exists for a branch to reach into.

**Named format arguments are NOT AVAILABLE.** PostgreSQL declares `format()` as
`format(text, VARIADIC "any" format_args)` - it has no declared parameter names, so
`format($t$ %(bucket)L $t$, bucket => x)` fails with "function format(text, bucket =>
unknown) does not exist". MEASURED. Do not reach for it again in this codebase.

#### The test suite was part of the bug

The original "positive control" used a principal holding only READ permissions, so it
passed BECAUSE of the vulnerability - measured, correcting the policy turned that test
red. The fixture now separates reach, read permission and write permission across three
principals so each assertion can only fail for its own reason, and a read-only principal
exists solely to assert the regression.

The re-review then found the SAME class reintroduced in the fix: a "positive control"
asserting `clinical-attachments` was EMPTY, which is true for every principal because
the fixture seeded no such rows - so its expected value was identical whether the policy
was present or deleted, and the test passed verbatim against a completely deleted
clinical insert policy set. Two more ratchets found and fixed: a refusal-only DELETE
assertion (both an absent policy and a refusing one filter to zero rows), and a missing
positive control on the cross-tenant upload refusal.

**The generalisable lesson, now in AGENTS.md: a control whose expected value is
identical for a permitted and an unpermitted principal proves nothing.** Ask what the
control would return if the policy were DELETED, not merely that it passes.

#### Pinned columns, and what remains deliberately unpinned

Operator-confirmed: `owner_id` must be the caller's (uploader-only), `owner` accepted
NULL-or-self because the Storage API may leave it NULL, `archived_at is null` and
`is_delete_marker is false` on write predicates.

`metadata` is deliberately NOT pinned - the Storage API writes it server-side during
upload as the request's role, so a pin rejecting it would fail every legitimate upload.
The constraint therefore belongs on the BUCKET: `allowed_mime_types` is now
`{application/pdf, image/jpeg, image/png, application/dicom, text/plain}` on all five
(operator-confirmed). Without it, a write-permission holder could set their object's
mimetype to `text/html`.

RECORDED TRADE-OFF, operator-confirmed: pinning `archived_at` means that if the SERVICE
ROLE ever archives a clinical object for retention or legal hold, no authenticated
principal can rename or delete it again. Same lockout shape as Task 9's
`private.role_in_use`, and the price of preventing a client archiving PHI out of sight
while the row and blob remain. service_role SQL is the recovery path.

CONSEQUENCE OF UPLOADER-ONLY, operator-confirmed as acceptable: when a clinician leaves,
no administrator can delete or rename the documents they uploaded. Only service_role SQL
or the user themselves. This needs an operator runbook before it bites.

#### Path guard, and the limits of what the database can prove

`private.storage_path_is_safe` now refuses ANY segment made entirely of dots (`^\.\+$`),
not just the literals `.` and `..`. The first version accepted `...`, `....//`, `.. `,
`. .`, `..;` and `%2e%2e` as real rows.

CORRECTION to how that was first written up here: the new guard closes `...`, `....` and
`....//`, and it does **NOT** close `.. `, `. .` or `..;` — those are still accepted, by
design, because the pattern is "a segment made only of dots" and a segment containing a
space or a semicolon is not that. Only `%2e%2e` is settled rather than merely
unrefuted: S3 keys are not URL-decoded, so it is a six-character literal at the storage
layer, and `foldername()`'s indices are fixed, so extra TRAILING segments can never
shift which segment is read as the organization. Traversal through any of the remaining
forms is not provable from the database and needs the HTTP harness.

#### Other measured facts

- `storage.protect_delete()` refuses a direct DELETE on `storage.objects` for EVERYONE,
  service role included, unless `storage.allow_delete_query` is 'true'. Independent of
  RLS, so every DELETE test SETS the GUC - otherwise it measures the trigger and passes
  whatever the policy said.
- `postgres` has `rolbypassrls = true`, so it bypasses RLS regardless of ownership, and
  `storage.objects` is owned by `supabase_storage_admin` not postgres. The reason to
  avoid `resetRole()` before measuring is STRONGER than AGENTS.md previously recorded.
- `ALTER POLICY ... RENAME TO` requires ownership of the table and fails 42501 here.
- `path_tokens` on `storage.objects` is GENERATED, so it cannot be forged.
- There are ZERO SECURITY DEFINER functions in schema `storage`, so the listing path
  (`storage.list_objects_with_delimiter`, `storage.search_v2`) is RLS-filtered rather
  than definer-filtered.
- `storage.allow_delete_query` is not attacker-settable: the `allow_any_operation`
  helpers only READ `storage.operation()`, and pg_catalog is not in PostgREST's exposed
  schema list.
- Open and unverifiable from the database: whether the Storage API normalises `%2e%2e`
  or a trailing-space segment, and whether a forged mimetype is served inline. Both need
  an HTTP-level probe against the Storage API, which Task 18's harness is the place for.
- Open: `storage-api` deletions write nothing to `audit_logs`, so a PHI document removed
  through the Storage API leaves no trail in the project's audit log.

## Task 10 third review: the schema was right, the proof was missing

The third review's verdict was "the schema is correct on every property measurable from
here, but five operator-confirmed decisions were defended by no test". It ran a full
mutation matrix over all 20 policies and found 17 mutations that passed every test -
including the removal of a clause the migration header calls load-bearing. This pass
closes them, and closes them by MEASUREMENT rather than by assertion.

### The fixture gap that made four of the five invisible

Stripping the owner clauses from the INSERT and DELETE policies left the whole suite
green, and so did re-gating the DELETE on the READ permission. The cause was not the
tests being weak - it was the FIXTURE: the read-only principal owned nothing. So every
refusal he met could be attributed to the owner clause, and removing the permission
clause changed nothing he could observe.

The fix is to give each principal an object of their OWN, so the permission clause is
the only possible reason a write is refused. This is the AGENTS.md rule ("ask what the
control would return if the policy were DROPPED") biting for the fourth time, now in the
fixture rather than in the assertion.

The same shape hid the reach clause. Every reach test used a principal whose role
ASSIGNMENT was clinic-scoped, so `can()` alone already refused him and no test could tell
whether `clinic_ids` was doing any work. The new principal GRACE has an ORG-WIDE
assignment - so `can()` returns true for every clinic - and reach narrowed instead by a
`clinic_memberships` row. Only the reach clause can refuse her, and the test asserts that
premise before relying on it.

### One mutation is caught ONLY by a text assertion, and that is recorded rather than hidden

Removing the `clinic_ids` conjunct from `patient_documents_delete` leaves all 23
behavioural tests green. MEASURED twice, and I could not construct a behavioural
assertion that distinguishes it - the real suite passes the clause's positive control,
so the refusal it does observe is attributable to something else in the predicate.

The conjunct is therefore pinned in the catalogue test instead, alongside the permission
key and the `bucket_id` literal, and asserted ABSENT for org-assets so it cannot be
satisfied by adding the conjunct everywhere. The behavioural test is kept as well. This
is a weaker form of proof and it is labelled as such in the test file rather than left to
look behavioural.

An earlier attempt to seed a literal `..` as the traversal fixture was ALSO wrong and was
caught by the same method: the SUPERSEDED guard caught a literal `..` too, so the
assertion would have passed against the guard it exists to defend. The fixture now uses
THREE dots, which only the current guard refuses.

### Mutation matrix after this pass

Each mutation applied and COMMITTED, the suite run, then every predicate restored and
verified byte-identical (20/20 predicates, path guard identical, no bucket missing its
MIME list, zero residual rows).

    strip owner clauses from patient_documents_delete        -> 1 test fails
    re-gate that DELETE on patients.READ (the CRITICAL)      -> 2 tests fail
    strip clinic_ids from patient_documents_delete           -> 1 test fails
    strip archived_at / is_delete_marker from the same       -> 1 test fails
    revert the path guard to the superseded in('.','..')    -> 1 test fails
    clear allowed_mime_types on all five buckets             -> 1 test fails

### Verification method, because the first four attempts were wrong

Three separate harness errors are worth recording, because each produced a confident
wrong answer rather than an error:

1. Scripts run from a temp directory cannot resolve `pg`, so the mutation NEVER APPLIED
   and the "23 passed" runs were the unmutated suite. Five confident green results from
   a mutation that was never live.
2. `CREATE POLICY` cannot take bind parameters - it is a utility statement - so building
   the mutated predicate with `$1` failed. The permission literal has to be inlined.
3. A probe that seeds its fixture and then deletes from it, in one transaction and under
   two different roles, reports results that disagree with the real suite. At baseline
   it claimed a permitted delete returned zero rows where the real suite proves it
   succeeds. I discarded the probe as evidence rather than reasoning from it.

The reliable instrument is the real suite with the mutation committed, plus a snapshot
restore that is VERIFIED against a pre-recorded snapshot instead of assumed.

### Other corrections

- `allowed_mime_types` had ZERO assertions in the entire repository. It is the only
  control on `metadata`, which is deliberately unpinned, so clearing it left 487 tests
  green. Now asserted per bucket against the operator-confirmed list.
- The uploader-only trade-off, the `archived_at` / `is_delete_marker` pins, the MIME
  allowlist and the path guard on SELECT now each have a test that fails when the
  control is removed. The archived object also asserts the READ side stays visible,
  because SELECT deliberately ignores `archived_at`.
- Corrected this file's own claim that the path guard fixed `.. `, `. .` and `..;`. It
  does not; those are still accepted by design, and only `%2e%2e` is settled rather than
  merely unrefuted.

### Still open, unchanged by this pass

Uploader-only means a departed user's documents are undeletable by EVERY application
role; the third review's point that the severity is understated stands, and it needs an
operator runbook. The HTTP-layer questions remain for Task 18's harness: whether the
Storage API executes user requests as `authenticated`, whether a forged mimetype is
served inline, whether `allowed_mime_types` is enforced by the API at all, and whether
`anon` can reach a private bucket despite RLS denying it.

## Task 11 review: a day-boundary bug that billed the wrong clinic day

Review of `fdb9e21`. The generated types were verified against the live tool and are not
hand-edited; the money and timezone logic was correct on every value the suite exercised.
The defects were all at edges the suite did not reach.

### CRITICAL, and it was a live billing defect

`clinicDayBounds` computed local midnight by taking the local calendar date, guessing UTC
midnight for it, and subtracting the zone offset. That assumes there is exactly ONE instant
at which the local wall clock reads `00:00:00`. It is false wherever a daylight-saving
transition lands ON local midnight - at which point that instant either does not exist
(spring forward) or happens twice (fall back).

MEASURED by the reviewer over 37 zones x 1990-2031: **1 460 wrong day boundaries and 97
instants that fell outside the window returned for them.** The zones are America/Havana,
America/Santiago, America/Asuncion, Asia/Amman, Asia/Gaza, Asia/Jerusalem and
America/St_Johns - and Havana, Santiago and Asuncion do it EVERY SINGLE YEAR, so this is not
historical trivia. The concrete case: `clinicDayBounds(2000-04-02T04:30:00Z,
"America/Havana")` returned a window ending at 04:00Z, so the 04:30Z instant that produced
it was outside its own day. An appointment in the last hour of a clinic's evening would be
billed to the next clinic day, and on the fall-back side an hour of revenue would belong to
no day at all. No throw, no log.

THE FIX IS STRUCTURAL. "The local calendar date at this instant is at or after D" is
MONOTONE in the instant, because a local date only ever moves forward. So the first instant
of local day D is exactly a binary search for that predicate crossing from false to true.
It costs about 28 Intl lookups and is correct whether midnight exists once, twice, or not at
all. It also produces 23, 23.5, 24, 24.5 and 25 hour days for free, because the answer is
measured rather than derived from a 24-hour assumption.

RE-MEASURED AFTER THE FIX: 45 738 (zone, instant) samples across 22 zones and 11 years, and
**zero windows exclude their own instant**. The Havana transition day is now correctly 24
hours - the wall clock skips 00:00-01:00, but the elapsed time between two local midnights is
still 24 hours, and the naive version had reported 23.

This is the "gold-plating" trap inverted: the two-pass offset fix-up looked like sufficient
care and was not. The tests used only Asia/Kolkata, America/New_York and Asia/Kathmandu, and
New York transitions at 02:00 local, so local midnight always exists there. A suite that only
exercises zones without the edge case cannot see it.

### HIGH: parseMinor read two realistic inputs as wrong amounts

**Accounting parentheses parsed as POSITIVE.** `parseMinor("(₹5.00)")` returned 500 rather
than -500. `Intl` emits parentheses the moment `currencyDisplay: "accounting"` is set - one
word away in `numberFormat()` - and parentheses are what Indian accounting packages print. A
credit note read back through this becomes a charge.

**The "no digits means throw" guard did not cover the realistic corruption.** It only
complained when the input had no digits at all, so `parseMinor("2026-10-14")` returned
**-2 026 101 400** - the hyphens vanished, the digits concatenated, and the internal minus
tripped the sign detector. `parseMinor("+91 98765 43210")` returned 91987654321000. The
principle in the header was right; the predicate was aimed at the wrong failure mode.

So parseMinor now VALIDATES instead of sanitising. A character is accepted only if the
formatter itself emits it for that locale and currency, a minus is accepted only as the first
or last character, the fractional part must be at most two digits, and anything else throws.
A loud refusal, because the alternative is a plausible-looking wrong number on an invoice.

**Whitespace had to be handled carefully to get there.** My first attempt kept stripping all
whitespace, which meant `parseMinor("1 234,56 €", "EUR")` still returned 12345600 - the
fr-FR grouping space was blanked and the comma then read as grouping. Interior whitespace is
now left in place and accepted only if THIS locale actually groups with it. That single detail
was the difference between a loud throw and a silent 100x error.

### MEDIUM and LOW, closed

- Cross-locale input is now refused rather than silently misread. `parseMinor("1.234,56 €",
"EUR")` under the default previously returned 123 for 123456 - a silent 10 000x error; it
  now throws. The strict validation is what makes it a throw.
- More than two decimal places threw instead of silently truncating, while the function was
  documented as formatMinor's exact inverse.
- `separators()` was the basis of the header's most prominent claim and was called from one
  place, so hard-coding `{group:",",decimal:"."}` left ALL tests green. Now pinned by de-DE,
  fr-FR and en-IN round-trip tests.
- The non-bigint guard existed but was untested. Now asserted.
- `formatMinor` accepted a bad currency code and rendered it on an invoice. Now a three-letter
  ISO check - though `XYZ` is deliberately still allowed, because it is a real ISO 4217 code
  meaning "no currency", which is what my first version of that test got wrong.
- `Date.UTC` maps years 0-99 onto 1900-1999, so a year-1 input silently became 1901 and the
  window did not contain it. Now `setUTCFullYear`. Asia/Kolkata turns out to have been on
  local mean time (+05:53:28) before 1906, so even a no-DST zone has sub-minute offsets -
  handled correctly by the search.
- `formatInClinicTz` did not always return padded YYYY-MM-DD: year 1 rendered as "1-01-01".
  That breaks a caller that slices the result AND breaks the lexicographic comparison the day
  search depends on, so the two fixes are linked.
- `Intl` formatters are memoised. MEASURED at 27 microseconds to construct one, and a binary
  search per bound would otherwise construct fifty-six per call.
- Dead code removed: an unreachable `undefined` guard and an impossible `group === decimal`
  branch.

### A documentation correction

My precision figures were LOOSE, not wrong, and are corrected in the header. "Exact through
10^15 paise" holds for the decades below 10^15 but the [10^15, 10^16) decade is about 15%
inexact; and at the 10^16 magnitude roughly THREE values in four lose a paisa, not two. The
load-bearing conclusion - display only, at every magnitude - is unchanged.

### Confirmed as correct, so it is not re-litigated

The generated types match the live generator (identical hash after stripping prettier's
formatting; all 26 blocks match), every test value in both files is correct rather than merely
self-consistent, `Number(amount)/100` really is the only float, the New York 23h/25h day
lengths are exact, Lord Howe's 30-minute DST shift is handled, and the deviation from the
brief's `2026-10-15` assertion is right - 18:00 UTC at +05:30 is 23:30 on the 14th.

### Open and unverifiable here

Small-ICU Node/Vercel runtimes: this host has full ICU, and `en-CA` may render differently on
a reduced build. Timezone-data skew: Havana, Chile and Jordan DST rules have changed
repeatedly, so the exact set of affected dates differs under a newer `tzdata`. And
non-ASCII-digit locales (ar-EG, bn-IN, fa-IR and about eight others) still throw - documented
as a limit rather than handled, because a throw is the safe failure, but it needs Unicode
digit folding if `organizations.locale` ever carries one.

## Task 11 re-review: three wrong designs in a row, and my own tests were the only thing that caught the third

The re-review of `283a422` found HIGH-1 still open and two silent-wrong-amount bugs in
my own fix. All three are now closed; the sweep numbers are on the other side of them.

### The binary search was wrong because its premise was wrong

I justified it with "a local date at this instant is at or after D is MONOTONE in the
instant, because a local date only ever moves forward". **That is false.** A fall-back that
crosses local midnight moves the local date BACKWARDS, so the same calendar day occurs
twice with a short interval belonging to the previous day in between, and a binary search
converges on the LAST crossing rather than the first.

MEASURED by the reviewer across all 418 zones and all 14 828 transitions in 1990-2035:
**57 such events** in Goose_Bay, St_Johns, Moncton and Casey, each returning a window that
began an hour after its own local midnight. My own "45 738 samples, zero failures" was
true and not reproducible - I had sampled 22 zones and never the backward-date ones.

### And then the WALK step was wrong too, and only a tiling test caught it

The replacement returns the maximal contiguous run of the local date containing the
instant. It walks away from the instant in 300-second steps. That still failed, and the
failure is the most instructive one in this task: at 2005-10-30 in America/St_Johns local
time passes 00:59 of the 10-30 and then reverts to the 10-29, so the 10-30 run lasts **60
seconds**. A 300-second step steps straight over it and reports a **25-hour** window that
**contains the instant** and spans the gap.

So it passed every containment assertion I had written. The ONLY thing that caught it was
the test asserting adjacent windows meet exactly. A window that spans a gap satisfies
"contains the instant" and fails "tiles with its neighbour", which is why a tiling
invariant is worth a test even when every other assertion is green.

MEASURED shortest run anywhere in tzdata 1990-2035: **60 seconds**. The step is now **30
seconds**, a 2x margin, with a 32-hour bound as the backstop - no real local date occupies
more than about 32 hours, so an implausible window is refused rather than billed against.

A memo on `(zone, day, hour)` was also unsound and is now self-verifying: two instants in
the same clock hour can be in different runs, and containment alone does not prove the
cached window is the right run. The test that reproduced this was order-dependent - it
passed alone and failed after the preceding test warmed the cache - which is a class of bug
worth naming, because it only appears when tests share a module-level cache.

### Two silent wrong amounts, both in the fix I wrote for the previous round

**Currency names containing the locale's decimal separator.** parseMinor kept a SET of
every character the formatter emits and deleted matching characters. When the localised
currency name contains the decimal separator - "د.إ." contributes a "." - the real
separator was deleted along with it, and `parseMinor(formatMinor(1n, "AED", "ar"))`
returned **100** instead of 1. Literals are now removed as whole STRINGS, and what
remains must match the numeric grammar.

**Locales whose positive rendering carries literals the negative one lacks.** The literal
alphabet was sampled only from the negative form. In de-CH the negative rendering carries no
non-breaking space and the positive one does, so the formatter's own output was rejected -
a hard break for de-CH, en-CH, it-CH and lo, on a tenant-controlled column that has no CHECK
constraint. The alphabet is now the union of both renderings.

Also closed: digit grouping was never validated, so "₹1,234,56" parsed as 12345600;
unbalanced parentheses silently negated a charge, so "₹5.00)" became -500; and a
10-million-digit string became a BigInt.

### Verified after

601 920 samples across all 418 zones and 1990-2035: **zero containment failures**. Every
zone tiles exactly across a full day, including the four split zones. All of the reviewer's
specific cases return the right answer now: AED/ar, XCG/he, XCG/km, XCG/fr-CH, EGP/ar-AE and
KWD/ar all round-trip to 1; CHF/en-CH, de-CH, it-CH, lo and lo-LA all round-trip; the three
grouping cases and the three unbalanced-bracket cases all throw; the seven split-day cases
all contain their input.

The lesson worth carrying: **each of my three fixes was justified by an invariant I asserted
rather than measured**, and each was wrong in the same way - at the boundary where the
invariant stops holding. Containment is not enough; a window that bridges a gap satisfies it.

## Task 11 third review: clinicDayBounds survived; one HIGH closed in parseMinor

Third review of `ca50bec`.

### clinicDayBounds: could not be broken

Three independent oracles (a definition-level five-condition predicate, a transition-table
bracket-and-bisect, and pure tiling), over all 418 zones and 1883-2036:

- 3 855 280 probes at every transition, 1990-2036, at T-1/T/T+1 plus every second for
  +/-120 s - **0 problems**
- 2 863 120 probes over 1883-1990 - 1 799 "problems", all of them the `MAX_RUN_MS`
  backstop firing on CORRECT 47 and 48 hour runs from Pacific date-line moves
  (1892-1969). A loud refusal, not a wrong window, and correctly placed: the longest run
  in 1990-2036 is 25 h and the longest dateline run is 48 h, so a 32 h bound sits between.
- 21 367 148 tiling probes, every transition +/-6 h at 30 s steps - **0 breaks, 0 overlaps**
- 15 adversarial zones checked against an independent oracle, including Pacific/Apia's
  skipped day, Lisbon 1992, Troll, Tehran 2022 where DST was abolished, Lord Howe's
  30-minute DST and Chatham's +12:45 - all exact
- 400 adversarially interleaved memo calls across 4 zones x days x hours - **0 problems**

The third review independently re-measured the shortest run as 60 seconds (Goose_Bay
1990-2001 and St_Johns 2005-10-30, both confirmed directly), which validates the 2x margin
on the 30-second step from the other direction.

### HIGH closed: parseMinor rejected the formatter's own NEGATIVE output in 10 locales

The test written to guard the N2 defect tested only the POSITIVE side - the exact mirror
of the ratchet it was written for. Ten locales put the minus in the MIDDLE; de-CH renders a
negative as "₹-1'234.56", so the sign detector saw an "interior" minus and threw. MEASURED:
126 040 negative renderings rejected, 10.75% of all negatives ICU emits.

Literals are now removed BEFORE the sign is read. All 40 sampled negatives across de-CH,
en-CH, it-CH, lo, lo-LA, nl, nl-BE, es-CL, es-PY and es-VE now round-trip exactly, and the
interior-minus guard still rejects "2026-10-14" because that string carries no currency
literal, so its hyphens survive the removal. The test now asserts BOTH signs.

### CORRECTION: the N2 "literal union" fix is inert on this ICU

The third review measured that sampling literals from the negative rendering ALONE produces
identical output across 136 890 renderings - `.trim()` already absorbs the leading
non-breaking space that de-CH's positive rendering adds. So the fix is harmless and may
matter on a future CLDR release, but **the claim in the previous commit and in this file
that "the formatter's own output was rejected" is NOT reproducible here.** Recorded rather
than left standing, because a documented invariant that turns out to be inert is exactly
the kind of thing this file exists to catch.

### Closed in the same pass

- `cents.padEnd(2,"0")` was load-bearing and untested - the only mutation in the whole
  matrix that produced a WRONG amount rather than a throw: "₹5.5" parsed as 505 instead of 550. Now pinned.
- "₹5." was guarded only by the shape grammar and unpinned. Now pinned.
- The module header's performance figures were wrong by ~55x in the direction that
  UNDERSTATES cost: it claimed 167 us uncached and ~370 Intl lookups; the real figures are
  ~11 ms and ~2 900. Corrected, with the number that actually matters for report design.
- The memo key now omits the hour. The containment guard makes that sound, and it is a
  31x improvement: MEASURED, 30 days x 4 clinics x 24 hours went from ~31 s to 999 ms.
  Re-verified after the change: 601 920 samples over 418 zones with zero failures, every
  zone tiling exactly, and 9 216 interleaved calls across the four split zones with zero
  failures - the split days simply recompute on alternation, which is rare and correct.

### Recorded, not changed

- Four `datetime.ts` backstops (`MAX_RUN_MS`, `runEnd`'s MAX_TIME clamp, `runStart`'s
  negative clamp, the self-check's containment clause) are untested ratchets with zero
  measured divergence on realistic inputs. They are the safety net the header advertises,
  so pinning them is worth doing, but none is reachable with a wrong answer today.
- `runCache` and `dateFormatters` are unbounded module-level maps. 76 800 keys measured at
  48 MB. Fine for a short-lived request; a long-lived worker would grow without bound.
- The round trip is not total above about 10^170 paise, where the rendering exceeds the
  256-character input ceiling. Irrelevant at real magnitudes.
- **Brief deviation, now recorded:** the brief's Interfaces line is
  `formatInClinicTz(iso, timezone, locale?)` and the shipped signature is
  `(iso, timezone)`. A locale cannot change which calendar date an instant falls on, and
  the output is padded ISO by construction, so the parameter would be decorative.
- **The residual risk worth naming:** both modules derive their grammar from `Intl` at
  runtime and cache it with no ICU version in the key. Separators are stable CLDR data;
  currency symbols and spacing literals are not. A CLDR change that moves a literal into a
  position the removal loop mishandles would break the round trip with no error anywhere,
  and nothing in this codebase could detect it.

## Task 12: Supabase clients and session handling

Brief scope only — the four client modules, the root proxy, and the session test. The
`public` RPC wrappers that Tasks 5 and 9 flagged are NOT here; see the standing gap below.

### Next.js 16, verified rather than assumed

`middleware.ts`/`middleware` is deprecated in favour of `proxy.ts`/`proxy`, read from
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` for
this exact version: the file must live at the project root, it exports `proxy` or a
default, and `runtime` is **not** an available config option — setting it throws. Edge
runtime is not supported. A leftover `middleware` export is silently ignored, so the
session refresh would simply never run; the test asserts the export shape for that
reason rather than as a formality.

`@supabase/ssr` 0.12.7 requires `createServerClient(url, key, options)` with options
mandatory, so the env vars are passed explicitly rather than discovered. `createBrowserClient`
takes the same shape.

### The refresh invariant, and the half of it that is easy to omit

`setAll` must write to BOTH `request.cookies` and the response, and must rebuild
`NextResponse.next({ request })` each time. MUTATION TESTING showed why the second half
matters and why a naive test misses it:

| mutation                                         | result                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| write to the response only, not the request      | CAUGHT                                                                                                                                           |
| never rebuild `NextResponse.next({ request })`   | **RATCHET** until the forwarded-header assertion was added                                                                                       |
| `getClaims` never awaited, so no refresh happens | CAUGHT                                                                                                                                           |
| root exports `middleware` instead of `proxy`     | CAUGHT                                                                                                                                           |
| matcher drops `_next/static`                     | CAUGHT                                                                                                                                           |
| cleanup silently skipped, leaking probe users    | CAUGHT                                                                                                                                           |
| initial response built without `{ request }`     | RATCHET, and **benign** — setAll replaces it whenever it matters, and in the no-refresh case the request is unmodified so the two are equivalent |

The rebuild ratchet is the instructive one. `setAll` sets `response.cookies` directly, so
a proxy that omits the rebuild passes every cookie assertion — while the request the ROUTE
sees still carries the expired cookie and server components read a stale session. That
divergence is invisible from `response.cookies`; it surfaces only in
`x-middleware-request-cookie`, which is what the test now asserts on.

### Supabase rate-limits public signUp, and it presents as flakiness

MEASURED, and it cost real time before it was diagnosed. At three signups per run the
suite went green, green, then one failure, then three — the signature of a filling rate
limit window, not a logic bug. Two fixes:

1. **One signup per run**, created in `beforeAll` and shared by every test that only reads
   a session.
2. **The sign-out test must be declared last.** `signOut()` defaults to scope `global` and
   revokes EVERY refresh token for the user, including the shared session. Running it
   first made three later tests fail with "Invalid Refresh Token: Refresh Token Not Found"
   — a fixture destroying itself and surfacing as three unrelated failures. Vitest runs a
   file's tests in declaration order, so placing it last is deterministic; if this file is
   ever made concurrent it needs its own user.
3. **A fallback when the public path IS rate-limited**: create the user through the admin
   endpoint, which is not subject to that limit, and sign in through the PUBLIC client so
   the session under test is still obtained the ordinary way. The public path is still
   tried first, because exercising it is the point.

Verified stable afterwards: 6/6 across six consecutive runs, and 6/6 through the fallback
while the window was still full.

### The one destructive thing here, and how it is verified

Real auth users are created in the live project. `afterAll` deletes them with the service
role and then **asserts that no `probe-` user survives**, so cleanup failing is a test
failure rather than a slow leak. Measured residue after every run: 0 users.

### Standing gap, recorded rather than silently deferred

`types/database.types.ts` reports `Functions: { [_ in never]: never }`, and that is
re-confirmed by the MCP rather than inferred: `private.*` is not exposed by PostgREST, so
the browser has **no RPC at all** and cannot call `create_organization_with_owner`. Task 12
was scoped to auth/session by operator decision, so this is NOT closed. Task 12 is also
where the invitation-acceptance RPC will have to land, because `organization_memberships`
INSERT and DELETE are both closed and the membership row must be written by a definer.

### Also worth knowing

`server-only` was already pinned at `0.0.1` in `package.json` but was missing from
`node_modules`; installing it and then reverting the caret npm introduced keeps the
project's exact-pin convention. `tests/unit/design-tokens.test.ts` pins the number of code
files under its scan root and correctly broke at 24 — `lib/supabase/{client,server,proxy}.ts`
are under `lib/`; the ROOT `proxy.ts` is not counted because it is not under a scan root.

## Task 12 review: a HIGH contract violation that zero-coverage shipped, and two ratchets my own mutation run missed

Review of `211bcc1`.

### HIGH - `getUser()` threw where its own signature promised `null`

supabase-js delivers "there is no session" as an `AuthSessionMissingError` WITH
`data.user` null. The shipped code did `if (error) throw error`, so that `data.user ?? null`
on the next line was **unreachable**, and `Promise<User | null>` was a lie on the most common
path in the product: every anonymous page render. A caller writing the obvious
`if (!user) redirect("/login")` got an uncaught throw instead of a redirect.

The stated intent - that "no user" and "could not ask" stay distinguishable - was not
delivered either, because both threw the same thing. Now `instanceof AuthSessionMissingError`
maps to `null` and only a genuine failure propagates.

### WHY IT SHIPPED: `lib/supabase/server.ts` had ZERO coverage

`server-only` THROWS on import outside a React Server Component bundler, which makes the
module unimportable from a test at all. So the file carrying the repo's hardest boundary
obligation, and three of the five interfaces the brief names, was never exercised - and a
live contract violation sat inside it undetected.

Fixed with a `server-only` alias to `tests/helpers/server-only-stub.ts` in
`vitest.config.ts`. The production boundary is untouched; the package still fails a genuine
client-component build, which is what it is for.

### Two ratchets my mutation run did not report

**Dropping the cookie `options`.** `response.cookies.set(name, value)` without the options
argument keeps the suite green while silently losing `SameSite=lax` - a CSRF posture change
on the session cookie of a PHI system. Every other assertion in the file reads
`response.cookies.get(name)?.value`, which is the value and never the attributes.

**The root `proxy()` body was never executed.** A `proxy()` returning `undefined` keeps the
suite green; Next falls back to a plain `NextResponse.next()`, every page renders, and
session refresh silently never runs - the exact failure the file exists to prevent. The
test asserted only the export SHAPE.

### And one I introduced with the fix

Replacing `instanceof AuthSessionMissingError` with a bare `return null` also keeps the
suite green, and that is the failure the JSDoc claims to prevent: an auth-server blip
telling every caller "nobody is signed out", signing out a clinic that was working a
moment ago, with no error anywhere. It cannot be provoked against the live server, so the
branch is pinned in `tests/integration/auth-server-client-errors.test.ts` with the network
replaced by two scripted errors. That file is fully mocked and performs no signup.

### Cookie attributes, measured rather than assumed

`@supabase/ssr` 0.12.7's `DEFAULT_COOKIE_OPTIONS` is
`{ path: "/", sameSite: "lax", httpOnly: false, maxAge: 400d }`. Two consequences:

- **`httpOnly: false` is DELIBERATE and must stay.** The browser client restores its session
  by reading `document.cookie`; an HttpOnly cookie would break sign-in on a full page load.
  My first assertion in this pass asserted HttpOnly was PRESENT, which was simply wrong, and
  is now asserted absent so a library bump that flips it is visible rather than silent.
- **`secure` was absent entirely**, which is a genuine weakness for a PHI session cookie: a
  browser will also send it over plain HTTP. `updateSession` now derives it from the
  request's own protocol. Hard-coding it would stop the cookie working at all over
  `http://localhost`, which presents exactly like a broken session, so both branches are
  pinned.

### A correction to my own reasoning

The sign-out test's ordering comment claimed `signOut()` defaults to scope `global` and
"revokes EVERY refresh token for the user including the shared session". MEASUREMENT
contradicts the consequence: the token IS revoked server-side, but a live client session
survives it anyway, because `getClaims()` verifies the cached access token locally and never
reaches for the refresh token. The ordering is still required - because the refresh test
drives a cookie whose `expires_at` is in the past, which DOES force a network refresh, which
DOES fail once the token is gone - but the next agent was being handed a false mechanism to
reason from, and it is corrected.

### A test bug of my own, worth naming

The cleanup assertion originally asked "does ANY probe user exist?", which is wrong because
vitest runs test FILES in parallel and two files each create one - so every file failed on
its neighbour's user. It now asserts only about the ids that caller created.

### Mutation matrix after the fixes - 10 of 10 caught

Reverting the HIGH, swallowing every `getUser` error, swallowing every `getClaims` error,
dropping cookie options, omitting `secure`, hard-coding `secure`, an empty proxy body, a
response-only write, and omitting the rebuild: **every one turns the suite red.** The two
benign ratchets remain recorded rather than forced: the initial response built without
`{request}` (setAll replaces it whenever it matters), and dropping `await` on the proxy
call (`async` unwraps the promise, so there is no behavioural difference).

### Latent, recorded not fixed

`setAll` called MORE THAN ONCE discards cookies written by the earlier call, because the
rebuild constructs a fresh response. MEASURED unreachable today - `getClaims()` makes
exactly one refresh and emits one batch, across an expired token, an expired token with a
garbage access token, and an invalid refresh token. It is latent because `@supabase/ssr`
chunks large sessions across cookies and a future bump could batch differently. Revisit if
a second `getClaims`/`updateUser` call lands in one request.

## Task 12 re-review: three "closed" findings that were closed in name only

Re-review of `54308a2`. All seven substantive findings from round 1 were confirmed CLOSED -
including the HIGH - and 40 mutations could not reinstate any of them. What it found instead
was that the FIXES I added were themselves ratchets, plus a real flake.

### N1 (HIGH) - the test I added for the root proxy could not see the root proxy

I added "the root proxy actually returns the refresh result" and asserted only
`resolves.toBeInstanceOf(NextResponse)`. MEASURED: this is defeated by

```ts
void updateSession(request);
return NextResponse.next();
```

with eslint 0, tsc 0 and the whole suite green. That proxy still mutates `request.cookies`
in place, so the route sees a live token - but the response carrying `Set-Cookie` is thrown
away, the browser never receives a refreshed token, and the user is signed out mid-session.
Verbatim the failure `lib/supabase/proxy.ts` exists to prevent, and asserting a RETURN TYPE
cannot see it. Every other test in the file calls `updateSession` directly, so nothing
observed the wiring at all.

The test now drives `rootProxy.proxy(request)` with a stale cookie and asserts the refreshed
`Set-Cookie` is on the proxy's OWN response. Both three-line defeats are now caught.

### N2 - the rate-limit fallback covered the call it did not make

The fallback handled a rate-limited `signUp` but then called `signInWithPassword`, which has
its OWN per-IP limit and had no fallback at all. MEASURED: 6 of 8 consecutive runs of the
two auth files failed, on an unmodified tree - a broken promise in the fixture's own
documentation. The round-1 fix had also doubled the per-run signup count from 1 to 2 by
adding a second file.

Both calls now go through one bounded retry, with the final error naming the cause rather
than surfacing as an unrelated infra failure. Verified 6/6 consecutive runs.

### N3 - the primary boundary had no enforcing test

`import "server-only"` as the first line of `lib/supabase/server.ts` is the only
bundle-time defence against a Client Component importing the service-role client. MEASURED:
deleting that line, or moving it below the imports, leaves the ENTIRE suite green - lint,
typecheck, test and build all pass. `check-no-secrets` implements rules 1-4 and none
inspects it, and its header comment claiming the boundary "cannot be bypassed by an alias
this scanner does not model" became actively misleading once `vitest.config.ts` grew an
alias for that exact specifier.

`tests/unit/server-boundary.test.ts` now pins it, along with the alias not leaking into
`next.config.ts`, `tsconfig.json` or `eslint.config.mjs`. The re-review independently
confirmed by BUILD that the boundary fires when the import is present, so the import works;
what was missing was anything checking that it stayed.

### N4 - the Server-Component swallow was never exercised

Removing the `catch {}` in `server.ts`'s `setAll` left the suite green, because the mocked
`cookieStore.set` was a plain Map write that could never throw. In production it DOES throw
inside a Server Component - `cookies()` is writable only from a Server Action or Route
Handler - so the one thing standing between a token refresh and a 500 on every read-only
render was untested. The mock can now be told to throw, and both helpers are asserted to
survive it.

### Prose that claimed enforcement which does not exist

Three comments, corrected rather than left standing: the fixture said its fallback's
narrowness "is asserted" (nothing asserts it - widening the regex to swallow every signup
error stays green, now recorded as a known ratchet); a `__constructedWith` marker that
recorded nothing and was read by nothing; and the cleanup helper's proof of its own work,
which is self-referential by construction - a helper returning `[]` would satisfy every call
site. That last one is inherent to putting the check inside the thing being checked, and is
now said so.

### CORRECTION to a mechanism I had recorded wrongly

The latent `setAll`-called-twice item said it is unreachable today because "@supabase/ssr
chunks large sessions across cookies and a future bump could batch differently". That
mechanism is WRONG: `createChunks` returns an ARRAY consumed by a SINGLE `setAll` call, so
chunking widens one batch and cannot create a second one. The re-review measured all four
shapes against the live server - `getClaims`, `getClaims`+`getUser`, `2 x getClaims`,
`2 x getUser` - and `setAll` fired exactly once every time. Recorded for the correct reason
now: a second `getClaims`/`updateUser`/`onAuthStateChange` in one request, or a library bump
emitting two batches.

"Record it and move on" is still the right call for that item - it is genuinely unreachable

- but for a reason that survived measurement.

### Mutation matrix after the re-review fixes: 10 of 10, zero ratchets

Both three-line defeats of the root proxy, the round-1 HIGH reintroduced, `getUser` swallowing
every error, cookie options dropped, `secure` hard-coded, a response-only write, the rebuild
omitted, `import "server-only"` deleted, and the Server-Component catch removed: **every one
turns the suite red.**

One correction to my own reporting: an earlier entry counted "dropping `await` on the proxy
call" among the caught mutations and then listed it as a benign ratchet in the next sentence.
It is benign - `async` unwraps the promise, so there is no behavioural difference - and the
count was wrong.

### Still open, deliberately

- `setAll` called more than once still discards earlier cookies. Unreachable, now recorded
  for the right reason.
- The fixture's fallback narrowness is unasserted (known ratchet, noted above).
- The cleanup proof is self-referential (inherent, noted above).
- `secure` depends on deployment configuration: a TLS-terminating proxy that omits
  `x-forwarded-proto` issues the production PHI session cookie without `Secure`, silently.
  The tests pin the CODE's mapping, not Next's runtime derivation of `nextUrl.protocol`, so a
  Next upgrade changing `initProtocol` would keep the suite green while production changed.
  Worth a startup check or a runbook line before any self-hosted deployment.

## Task 12 third review: a HIGH that survived two rounds, and a doc comment that overstated

Third review of `df507c5`. Verdict from the reviewer: "Task 12 is complete in construction,
not in verification" - the shipped code is correct on every point the brief names, but a
closure raised _because its predecessor was a ratchet_ was itself still a ratchet.

### F1 HIGH - my N4 fix had a reachable-but-never-taken branch

The third pass made the mocked `cookieStore.set` throwable and added a test asserting the
helpers survive it. That test seeded a FRESH cookie - and a fresh token is valid, so
`@supabase/ssr` never called `setAll` at all. **MEASURED: the mock's `set` was invoked ZERO
times.** Removing the `try`/`catch` left the suite green.

This is the fourth time in this task that a test existed, said the right words, and could
not see the thing it claimed to protect. The pattern is now unmistakable: **a branch that
is reachable but never taken passes every assertion in its own test.** The fix is the one
`auth-session.test.ts` already used - rewind `expires_at` so the token is stale, forcing
the refresh that forces the cookie write - plus a counter, so "the branch was taken" is
asserted rather than assumed. Removing the catch is now caught, with the throw surfacing.

### F2 - the retry could outlive the hook and leak a user while cleanup reported success

vitest's `hookTimeout` DEFAULTS TO 10s and is not covered by the configured `testTimeout`.
One fully exhausted retry is 0 + 2.5s + 7s, and `createProbeSession` makes up to three such
calls - about 28.5s inside a 10s budget, engaging exactly when the auth server is slowest.

The consequence was worse than a timeout: if `beforeAll` throws, `createdIds` was never
populated, so `afterAll` called `deleteProbeUsers([])`, which iterates nothing and returns
`[]` - and `expect(leftovers).toEqual([])` **passed**. The assertion designed to catch the
leak was the thing reporting success.

`hookTimeout: 60_000` is now explicit, and the fixture registers each created id in an
exported list the moment it exists - before anything that can throw - so a failed
acquisition still leaves something to clean up.

### F3 - the throw-versus-retry gate was unasserted, and understated as recorded

`isRateLimit` was module-private and no test referenced it. Mutating it to `() => false`
keeps the entire suite green, which deletes the throw-versus-retry decision the previous
round added: a bad key or a disabled provider then gets retried three times and reported as
"wait for the rate-limit window" - a 28.5s misdiagnosis that then trips F2's timeout and
leaks a user. Now exported and asserted against the messages Supabase actually returns.

### F4/F5 - small, and both were mine to fix

`server-boundary.test.ts` named `playwright.config.ts` in its comment but omitted it from
the array, so an alias smuggled there - Task 15's E2E runs `npm run build && npm run start`,
so it would run a spec against the stub - went unnoticed. Added.

And `scripts/check-no-secrets.ts` still carried the sentence N3 called "actively
misleading" - that the boundary "cannot be bypassed by an alias this scanner does not
model" - two rounds after it was identified. Corrected to say what the scanner actually
enforces and to point at the test that pins the import.

### F6 - a literal `\n` had been committed into a file header

`prettier` does not reflow comment interiors, so a here-string artefact passed every gate
for two commits. Repaired; the repo is now clean of the pattern.

### F7 - `createBrowserClient`, and a doc comment that OVERCLAIMED

The brief's fifth interface had no test, and adding one surfaced a bigger problem. The
module claimed a factory rather than a singleton "because a module-level client would
capture the environment at import time", and that "a factory returns a client the caller
owns".

**MEASURED from the library source: `@supabase/ssr` keeps a module-level
`cachedBrowserClient` and returns it whenever `isBrowser()` is true** - which includes
jsdom. Two calls return the SAME object regardless of what this module does. So the caller
never owned the client, and the environment is captured on the first call either way.

That memoisation is the library's deliberate design and is the desirable one here - one
cookie-managed client per browser rather than a fresh one per component render. The honest
statement of what the factory buys is much narrower, the comment now says so, and the test
pins both facts: that this module reads the environment when called, and that the library
memoises the result.

The first version of that test asserted the env behaviour by breaking the URL, passed in
isolation and FAILED in a full run - `process.env` is shared between files landing in the
same worker, so another suite's `beforeAll` makes the outcome depend on file order. Rewritten
around `vi.resetModules()` and a fresh import per test.

### One of my own patches introduced a bug, caught immediately

Moving the id registration into the fixture left the call sites also pushing it, so the same
id was deleted twice and the suite failed with "User not found" - masking the real result
behind a cleanup error. `deleteProbeUsers` is now idempotent, because "already gone" is the
outcome that was wanted.

### What the reviewer confirmed is genuinely correct

All seven round-1 and all nine round-2 closures hold under mutation. The `setAll` ordering
is pinned from both failure directions; the refresh trigger is pinned; `SameSite`, `Path`,
`HttpOnly` and `Secure` are pinned in both directions; the root proxy is pinned through its
OWN response and defeats all three three-line rewrites; the `server-only` first line is
pinned against deletion AND relocation; `getUser`'s signed-out/throw distinction is pinned by
a fully mocked zero-network file; cleanup is correctly scoped to caller-supplied ids and so
is parallel-safe across three concurrent files.

Independently confirmed by BUILD: `next build` emits `f Proxy (Middleware)`, which is far
stronger evidence than any unit test here.

## Task 13: typed errors, validation, and revalidating active-org resolution

### getActiveOrg never trusts the cookie

The cookie says which organization a user last chose; the database decides whether that is
still true. A user removed from an organization, or an organization that is suspended,
resolves to `null` - never to whatever the cookie still claims. A cookie is user-controlled:
it can be edited, replayed after a removal, or copied from another clinic.

The re-validation is one query that RLS already governs - the signed-in user reads their own
memberships and nothing else - so "is this still true?" is answered by the same policy that
answers everything else here, not by a check of our own.

**A dead cookie never falls back.** With no cookie at all, a user in exactly one organization
resolves to it (operator-confirmed: unambiguous, and a fresh login lands somewhere useful);
with several, the result is null because there is no correct answer. But a cookie that WAS
present and no longer resolves returns null - the user chose, that choice died, and silently
moving them into a different clinic is worse than asking. MEASURED: this is what makes
"remove membership B" resolve to null rather than silently to A.

`setActiveOrg` writes the cookie without checking membership (operator-confirmed): every read
re-validates, so a bogus id resolves to null on the next page, and checking at write time
would duplicate the membership query on a rare user action.

### `userCan` is ADVISORY and the name is deliberate

Not `hasPermission`, because Task 3 already owns a pure `hasPermission(roles, permission)`
over an in-memory role list, and two signatures under one name is a bug waiting to happen at
every call site. It exists so a UI can hide a control the user cannot use; it must never gate
access, because it is answerable client-side and RLS is the boundary.

### Three defects of my own, each caught by mutation rather than by reading

**The positive control was missing.** The first `userCan` test gave the probe user NO roles,
so `userCan` returned false through the `roleIds.length === 0` guard and never reached the
permission lookup - replacing that lookup with a hard-coded `return true` left the suite
green. MEASURED. This is the fifth time in this repository that a control whose expected
value is identical for a permitted and an unpermitted principal has been caught. Fixed by
giving the fixture a real org-scoped role with a real grant and asserting the answer MOVES
when the grant is withdrawn. A tenant role is created by the fixture because the database
seeds only the platform role globally - tenant roles come from onboarding.

**Test ordering.** The signed-out test emptied the auth cookie and never restored it, so
every later test ran signed out. The `userCan` assertions PASSED in isolation and FAILED in a
full-file run - the worst shape a failure can have, because running the file alone appears
to clear it. Now every test starts from the same signed-in session and states its own
preconditions.

**A no-op assignment that was not a no-op.**
`process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
with the variable undefined stores the STRING `"undefined"`, which the auth server rejects as
an invalid key. The symptom was a client that looked configured but authenticated nobody -
and because `getActiveOrg` returns null when there is no user, that presented as "signed
out" rather than as a configuration fault.

### A leaked sweep deleted seeded state, and nothing complained

While clearing leaked rows from repeated runs, the cleanup was widened to every row matching
a sentinel - which removed the seeded `platform_super_admin` role and its four platform
permissions. **Nothing failed loudly**, because every test that mentions that role asserts
it is ABSENT from organization-scoped reads, which trivially passes when the row is missing.
That is worth recording: a seeded row that no test requires to EXIST can disappear silently,
and the tests written to protect it are all negative.

Restored by `20261014001500_reassert_platform_seed.sql`, which re-applies 00400's own
idempotent seed statements verbatim rather than inventing a second definition. The migration
was first applied with `name = 'reassert_platform_seed'`, and `tenancy-schema.test.ts` caught
it: the applier records the FILENAME, and the migration-history test compares against it.
The history row was corrected and the migration re-applied under its filename.

The active-org fixture now tracks every organization it creates and deletes exactly those.
A cleanup that can delete state it did not create will eventually delete state it should not.

### A pre-existing flake in someone else's test, exposed by adding a second writer

`onboarding-rpc.test.ts` asserted GLOBAL absolute counts -
`select count(*) from public.organizations` - and passed only because nothing else wrote an
organization concurrently. Adding a second integration suite that creates organizations made
it fail roughly one full-suite run in two. Every count is now scoped to the organization that
call created, which is the only property an assertion about "the RPC bootstraps one X" can
have. Verified with three consecutive full-suite runs.

### Validation, and one order-of-operations bug

`z.email().trim().toLowerCase()` does NOT normalise: Zod checks the format against the INPUT
string, so `Dr@clinic.test` was rejected as malformed. Transform first, validate second -
`z.string().trim().toLowerCase().pipe(z.email().max(254))`.

Zod STRIPS unknown keys rather than rejecting them, so `resetPasswordSchema` ignores a
supplied `email` rather than erroring. Asserted explicitly, because "the extra field is
ignored" and "the extra field is absent from the parsed output" are different claims and only
the second matters to a caller forwarding the parsed value to Supabase.

### Mutation matrix: 10 of 10, zero ratchets

A stale cookie trusted over the database; a dead cookie falling back; an ambiguous choice
picking the first membership; the unauthenticated short-circuit removed; `userCan` hard-coded
true; `requireActiveOrg` returning null; the cookie made script-readable; memberships not
scoped to the user; `toSafeResponse` forwarding any Error message; `toSafeResponse`
stringifying an unknown error. Every one turns the suite red.

### `toSafeResponse` touches nothing on an unknown value

No `String(e)`, no `e.message`, no `JSON.stringify(e)` - each is a way for a hostile or lazy
getter to throw INSIDE error handling, converting a handled 500 into an unhandled rejection.
Only an `AppError` contributes a message, because an `AppError` message is authored by us. A
thrown object carrying a convincing `status` and `message` is not honoured: it would let a
thrower pick both halves of the response.

## Task 13 review: two ratchets in a new shape, and an overstated matrix

Review of `211b0d8`. Verdict: complete, not blocked - every interface behaves correctly under
every externally-reachable attack. What it found was test-suite blind spots, plus one
measurement of mine that did not survive being checked.

### CORRECTION FIRST, because it is mine

The previous entry reported "Mutation matrix: 10 of 10, zero ratchets." That is overstated.
Two of the ten entries, as literally described, do not turn the suite red:

- "a dead cookie falling back" was only red in its crude form (fall back to the FIRST
  membership). The subtle form - fall back to the SOLE remaining membership when the cookie
  is dead - survived green, because both shipped dead-cookie tests left TWO memberships
  behind, where that branch cannot run (review F1).
- "memberships not scoped to the user" survived green, because RLS already restricts the
  rows and the fixture's orgs contained only the probe user, so the missing filter was
  unobservable (M2).

The reviewer verified 8 of the 10 as genuinely red, and found TWO ratchets the matrix did not
contain at all. The matrix was a real measurement of the wrong things, which is the exact
failure mode this file exists to catch.

### The two new ratchets, both fixture blind spots rather than assertion errors

**F1: the dead-cookie rule was untested in the only state where a fallback can fire.**
Removing the user's membership from the cookie's org while TWO others remained meant the
sole-survivor branch could never run. Adding a test that leaves EXACTLY ONE survivor closes
it: the mutation now fails 8 tests.

**F2: userCan's organization scoping was unobservable.** The fixture granted roles in
exactly one organization, so dropping `.eq("organization_id", org.id)` from the assignment
query could not change any answer. The probe user now holds a DIFFERENT grant in a SECOND
organization, and the test asserts the two never agree: acting in org A, the grant held in
org B must read false, and vice versa.

### F5: userCan now mirrors private.can's platform refusal - and the test can see it

`userCan` diverged from `private.can` on platform keys: a platform role assigned within a
tenant would have made `userCan("platform.tenants.manage")` return true while the database
refuses the request - exactly the divergence the helper exists to prevent. One line mirrors
`can`'s refusal: `permission.startsWith("platform.")` returns false.

And the test for it was ANOTHER instance of the standing failure: it asserted `false` while
the fixture held no platform grants, so the answer was false with or without the refusal -
which is why removing the refusal kept the suite green even after the code was fixed. The
fixture now REALLY grants `platform.tenants.read` to the probe user's tenant role, and the
test proves the grant exists before asserting the refusal suppresses it.

### F4: the flip test consumed the fixture for the tests after it

The `userCan` flip test deleted the assignment and never restored it, so the two tests
following it ran with zero assignments and their `false` expectations were satisfied by the
fixture rather than by the guards they name. The assignment is now restored and re-asserted.

### F8: suspended org and revoked membership - correct, and now pinned

MEASURED by the reviewer against the applied policies: `private.is_member` requires
`m.status = 'active' AND o.status = 'active'`, and the unique `(organization_id, user_id)`
constraint makes a revoked row the user's only row for that org - invisible to them. So a
suspended organization and a revoked membership both resolve to null, and the code has NO
status logic of its own; the invariant is 100% RLS-carried.

That was the risk: the module header claimed behavior nothing tested, and if the SELECT
policy is ever "simplified" to `user_id = auth.uid()`, revoked memberships would resolve
with nothing failing loudly. Both cases are now pinned by fixtures - a suspended
organization and a revoked membership each resolve to null however the cookie points.

### F6: the seeded platform role finally has a positive existence test

Every test mentioning `platform_super_admin` asserted it is ABSENT from something, which is
trivially satisfied when the row is missing - the state this repository was actually in for
a while, silently. `tests/integration/platform-seed.test.ts` now asserts it EXISTS with
exactly its four grants, and that the grant KEYS match the registry rather than merely
counting to four, so a drifted seed is caught by name.

### Verified as genuinely correct, and worth knowing

- `toSafeResponse`'s boundary holds under every externally-reachable shape the reviewer could
  construct: circular structures, throwing getters, `Symbol.hasInstance` objects, cause
  chains, PostgREST bodies. In-process shapes that DO pass - a Proxy around a real AppError,
  `Object.create(AppError.prototype)`, a NaN status - all require access to the class, and
  no library, driver or PostgREST error is an AppError. Forward rules recorded for
  Tasks 15-17: never build an AppError message or code from request- or DB-derived text, and
  never put `code` in a header.
- The active-org invariant is RLS-carried and verified APPLIED, not just written.
- The onboarding-rpc rescope is sound, not a weakening: every count is scoped to the
  organization that call created, a missing row yields NaN rather than a pass, and the
  global form was un-runnable in parallel by construction.
- Migration 01500 is byte-equivalent in effect to 00400's seed, correctly filed, and the live
  database matches its migrations exactly - verified read-only.

### Mutation matrix after the fixes

Dead-cookie sole-survivor fallback (F1); userCan organization scoping dropped (F2); the
platform-key refusal removed (F5); stale cookie trusted; ambiguous choice picks the first;
unauthenticated not short-circuited; userCan hard-coded true; requireActiveOrg returns null;
the cookie made script-readable; toSafeResponse forwarding any Error message. **All ten
caught, with the fixture states that make each observable.**

## Task 13 third review: the code held, and the ledger of open items is now honest

Third review of `53f20ee`. Verdict: **complete, not blocked.** All seven round-2 closures
independently confirmed, the shipped mutation matrix 10/10 with no ratchets under the
reviewer's own 34 mutations, and all six gates green on a clean tree.

### The live database carried residue, and it is now gone

The reviewer found 1 auth user, 9 organizations (one SUSPENDED), 4 memberships, 2 tenant
roles and 2 role assignments left in the live project, timestamped to a run of the
PRE-round-2 code - which had no cleanup. Purged: 0 organizations, 0 memberships, 0
assignments, 0 auth users, 21 permissions, and the seeded `platform_super_admin` role
intact. The database matches its migrations again.

The shape of the residue is worth recording: a **suspended** tenant and a tenant role
holding a `platform.tenants.read` grant. Neither is an escalation - `private.can` refuses
platform keys and `guard_role_org_scope` forbids cross-org roles - but the live database
did not match what its own migrations describe, which is exactly the class of drift F6 was
created to make visible.

### N2, the one unmet BRIEF obligation

The brief says "assert that `requireActiveOrg()` throws `UnauthorizedError`". The class
was never asserted - the test matched the MESSAGE, so a plain `Error` with the same text
satisfied it. MEASURED. Now asserted on the class and on the `code` ("no_active_org"),
because Task 15/17 branch on exactly that to decide between a sign-in prompt and a
generic 500.

### N3, a case-sensitivity divergence from private.can

`private.can` compares `lower(p_permission) not like 'platform.%'` - case-INsensitive - and
`PermissionKey` is an open template type, so `userCan("Platform.tenants.read")` is
type-valid. The helper's check was case-sensitive. Not exploitable today (the write policy
refuses platform keys and `permissions` holds only the 21 lowercase registry keys), but
mirroring a rule is only worth doing if it cannot drift. Now `toLowerCase()`.

And the test for it had to be given a TRAP to be discriminating: with only the lowercase
grant, a case-sensitive check finds nothing to match and returns false for the wrong
reason. The fixture now creates the adversarial capital-P permission row, asserts it
exists, and then asserts the refusal suppresses it.

### N7, a malformed AppError could produce a 200 OK

`Object.create(AppError.prototype)` has no `status`, so `toSafeResponse` returned
`status: undefined` - and `new Response(body, { status: undefined })` answers **200 OK**
with an empty body. A success status for a failure. A NaN status threw a RangeError from
INSIDE error handling, which is the one thing the module exists to prevent.

The field reads are now guarded: an integer status or 500, a non-empty string code and
message or the generic ones, and the whole read inside a try/catch so a throwing getter
cannot escape. The residual - a Proxy wrapping a real AppError passes `instanceof` and
controls the response - is unreachable from outside the process, and is recorded rather
than fixed, because `instanceof` narrowing is what the boundary is built on and a stricter
check breaks the subclasses.

### N5, the rule that a database error must not become an AppError

Unpinned, because a database failure is hard to provoke. So the CONSEQUENCE is pinned
instead: a test states that an `AppError` built from a database message WOULD leak it, and
that a database error thrown as-is does not. If `toSafeResponse` ever starts sanitising
AppError messages too, that test fails and the rule becomes visibly unnecessary.

### N8, N9, N10 - small, closed

The cookie's `secure` flag was never asserted, so hard-coding `secure: false` kept the
suite green; the plan says "secure in production", and it is now asserted by setting
NODE_ENV. "A user with no memberships gets null" was true EMERGENTLY - the empty-array
case fell through two other branches, and removing the guard changed nothing - so it is
now stated by a fixture that leaves the probe user with no memberships at all. The
platform-seed permission count is derived from the registry instead of hard-coded to 21,
because a literal breaks CRYPTICALLY the moment a permission is added.

### N4 and N6, and the single highest-leverage follow-up

`userCan` answers a strictly weaker question than `private.can`: it is org-wide and
CLINIC-BLIND, where `private.can` is not, and it costs FIVE round trips with two JWT
re-validations.

Both disappear the moment a `public.can(p_org_id, p_permission)` wrapper exists over
`private.can`. That wrapper is the Task 12 obligation which was explicitly deferred by
operator decision, and it is now the root cause of N3, N4, N6 and the blocker for Task
17's onboarding - because `types/database.types.ts` still reads
`Functions: { [_ in never]: never }`, so there is no RPC `userCan` could call.

The deeper point: the PERMISSION RULE is implemented twice, in SQL and in TypeScript, and
it has already drifted once (F5, the platform-key clause). It will drift again. A wrapper
is the fix; a `public.can` that Task 17 needs anyway is the cheapest place to put it.

### N14, a divergence from the plan's Review Focus 2 that was recorded nowhere

The plan's global Review Focus 2 says a cookie naming an organization the user has left
should "fall back to a valid membership or the picker". The implementation returns the
PICKER - null - and never falls back. Task 13's Step 2 is explicit that the result must be
null rather than B, and AGENTS.md says the brief is authoritative, so the implementation is
right. But the divergence is now recorded, because the plan's Review Focus is annotated
"-> Task 17" and the Task 17 author will read it.

### N11, N12, N13 - the process findings, also closed

AGENTS.md's "Current state" claimed Task 11 was next and that `lib/supabase/` did not exist,
while a LATER section of the same file described it as landed: the file that tells the next
agent what to do next was wrong about what to do next. Now corrected, with a note to
believe the gates rather than the prose.

The SDD ledger had no Task 11, 12 or 13 entries. Added.

And `lib/errors.ts` overstated the `setPrototypeOf` need - it claimed `instanceof` would
"silently [be] false in a production build", but this project targets ES2022 where
`class extends Error` keeps the prototype chain natively, and removing the line leaves the
suite green. The line stays, as a guard against a future downlevel; the justification is
now accurate.

### One honest non-result

The "no memberships" guard in `getActiveOrg` is REDUNDANT - removing it changes no
behaviour, because the empty case falls through to the same answer. The BEHAVIOUR is now
pinned by a fixture; the guard cannot be, because it is not load-bearing. Recorded rather
than dressed up.

## The public RPC surface: the browser's only door into the authorization primitives

The plan carried a note that was explicitly UNRESOLVED and had to be settled before Task 12:
"`authenticated` holds USAGE on `private` with EXECUTE granted per function ... whether
PostgREST exposes `private` could not be measured. Supabase's default exposed set is
`public, graphql_public`. If that default holds, none of these functions is callable from the
browser and Task 12 needs `public` wrappers."

**IT IS NOW SETTLED, AND THE DEFAULT HOLDS.** MEASURED twice, and `types/database.types.ts`
recorded the consequence exactly: `Functions: { [_ in never]: never }`. A signed-in browser
could not ask the database whether it held a permission, could not create its own
organization, and could not write an audit row. Task 17's onboarding was blocked outright.

### Three wrappers, and the reason there are exactly three

`public.can`, `public.create_organization_with_owner` and `public.write_audit`. Each is a
THIN wrapper: every rule - the platform-key refusal, the membership check, the clinic scope,
the audit metadata caps - stays in `private`, where it already is. A wrapper that
reimplemented the rule would drift from it again, which is exactly what happened on the
client side.

The permission rule existed TWICE - in SQL and in TypeScript - and had already drifted once
(the platform-key clause was case-sensitive in TypeScript, case-insensitive in SQL). Asking
the database removes the second copy, and `userCan` now calls `public.can` instead of
reading `user_role_assignments` and `role_permissions` itself.

### The hardening, which is the part that matters if PostgREST's set ever changes

MEASURED: of the twenty functions in `private`, ten are referenced by RLS POLICIES and must
stay executable by `authenticated`, because a policy's expression is evaluated as the
QUERYING role. Six more are referenced by TRIGGERS, which fire as their table's owner.

That left exactly three: `write_audit`, `next_sequence_value` and
`create_organization_with_owner` - in no policy, in no trigger, and called by nothing. They
were reachable by any signed-in role over SQL, and PostgREST's schema setting was the ONLY
thing containing them. One configuration change away from audit forgery: a member of a
tenant could write fabricated rows into that tenant's audit trail, or burn its identifier
space. `private.write_audit` and `private.next_sequence_value` already check membership
internally, so the blast radius was "your own tenant" - which is still a tampered audit
trail.

Their EXECUTE is now revoked from `authenticated`, and the public wrappers still reach them
because the wrappers are SECURITY DEFINER. `tests/integration/public-rpc-privileges.test.ts`
asserts BOTH sides: the three are withheld, and the ten policy-referenced ones are still
executable - because revoking one of those would make every row invisible rather than
every row denied, which is a silent, total failure rather than a loud one.

### The proof that matters is over real HTTPS

`tests/integration/public-rpc.test.ts` calls the wrappers through PostgREST with the
publishable key and a real signed-in user's JWT, because that is the only path a browser
has. A `pg` connection is not the product, and a function that exists but is unreachable
from a browser is exactly the bug that was being fixed - for seven tasks. The RED state
before the migration was PGRST202 "Could not find the function public.can in the schema
cache", which is the bug stated in the server's own words.

### Two things the work turned up

**PostgREST matches a function on the exact set of supplied parameter names.** A four-key
body could not match a five-parameter function even when the missing parameter had a
default - PGRST202 again, with a hint naming the other signature. So `public.write_audit`
gained a default on `p_resource_id` (migration 01610), and the app omits the key rather
than passing a null, because the generated type says `p_clinic_id?: string` and sending a
key the caller has no value for is how the first PGRST202 happened.

**AN ORGANIZATION THAT HAS ROLES CANNOT BE DELETED.** The cleanup in the new test failed
with "role rpc_probe_role is still in use": `private.guard_role_delete` refuses to delete a
role that still has grants or assignments, and it fires on a CASCADE delete of the
organization just the same. MEASURED, and it is a real defect rather than a test artefact -
`private.create_organization_with_owner` creates fourteen roles, so every org the product
creates is undeletable, which matters for tenant offboarding and for a PHI system that may
have to erase a tenant outright. **OPEN, and not fixed here**: the guard needs to
distinguish a cascade from a deliberate role deletion, and that is a change to a security
trigger, which is a separate piece of work. The test works around it by removing the roles
first, which is what the guard is asking for.

### Still open, recorded

`private.next_sequence_value` deliberately has NO public wrapper: a raw counter BUMPER is
an abuse vector, and a client that could increment a tenant's identifier space could
exhaust it. The right public shape, if a later task needs one, returns the next value for
the caller's own tenant rather than incrementing on demand. It matters because
`patient_identifiers` INSERT is granted to `authenticated` and the column has no default
that calls the counter - so whoever builds patient registration must settle how the number
is obtained. It is not a Task 12 obligation.

### A wrapper must mirror the signature it wraps, DEFAULTS INCLUDED

Two corrections, both found by running the existing suites against the new surface rather
than by reading the code.

**`public.write_audit` could not be called with four arguments.** PostgREST matches a
function on the exact set of supplied parameter NAMES, so a four-key body could not match a
five-parameter function even where the missing parameter had a default - PGRST202 again,
with a hint naming the other signature. `p_resource_id` gained a default
(20261014001610_public_rpc_wrapper_signature.sql), and the app OMITS the key rather than
passing a null, because sending a key the caller has no value for is what caused the first
PGRST202.

**`public.create_organization_with_owner` was a DIFFERENT, stricter API than the function it
wraps.** It declared `p_timezone text` with no default while
`private.create_organization_with_owner` declares
`p_timezone text DEFAULT 'Asia/Kolkata'`. Every caller that relied on the default broke
with "function public.create_organization_with_owner(unknown, unknown, unknown) does not
exist". Fixed by 20261014001620_public_rpc_wrapper_defaults.sql, and pinned by a
GENERAL assertion in `public-rpc-privileges.test.ts` that compares the defaulted argument
strings of every wrapper against its private original - so the next wrapper cannot drift the
same way.

The general rule, and it is the one worth carrying: a DEFAULT is part of a function's
contract, not an optional extra. A wrapper that drops one is not a thin wrapper.

### The revocation broke two suites, and that was the correct outcome

`onboarding-rpc.test.ts` and `audit-log.test.ts` called `private.create_organization_with_owner`
and `private.write_audit` DIRECTLY, as `authenticated`, and both failed with "permission
denied for function ..." the moment the EXECUTE was revoked. That is the revocation doing
its job: those calls were exactly the capability being withdrawn. Both suites now call the
PUBLIC surface - the path the product uses - and the private functions are reachable only
through it.

## The public RPC surface, reviewed: the write path was unvalidated, and the private surface is now unreachable by accident

Review of `f4484fc`. Verdict: "not blocked - safe to ship, with two medium findings to close
before Task 17 puts this in front of users." The security change itself was confirmed sound
and, unusually, backed by measurement rather than assertion.

### The hardening was MEASURED, not asserted

The review called the three hardened functions and got "permission denied for function
write_audit", "permission denied for function next_sequence_value" and "permission denied for
function create_organization_with_owner" - by calling them as `authenticated`, which is
exactly the scenario the hardening exists for. And the reverse: every one of the TEN
policy-referenced private functions was exercised by a live RLS read that returned the
expected rows, because a revoked function makes rows INVISIBLE rather than denied, so a
mistake there would look like an empty table rather than an error.

A full privilege table of all twenty `private` functions now exists in
`tests/integration/public-rpc-privileges.test.ts`, asserted on both sides: the three that
are withheld, the ten that must stay executable, and the six trigger-referenced ones -
two of which are deliberately NOT executable, so the assertion is per function rather than
a blanket value.

### MEDIUM, and it was the most important finding: the new write path had NO validation

The review measured, over real HTTPS as `authenticated`:

    p_slug = 'a/b/../1792483964879'   -> 200, stored VERBATIM
    p_timezone = 'Not/AZone'            -> 200, stored
    p_name of 2 000 000 characters      -> 200, stored

And in the catalogue: `organizations.slug` had NO CHECK constraint - only UNIQUE - and
`timezone` was bare text. So the DATABASE enforced nothing, and the zod schema was the only
validation in the system, on the client, which is exactly where validation does not belong.

The application's own comment says the slug "is the tenant key used in URLs, so it is
constrained to lowercase kebab-case rather than left free - a slug containing a slash or an
uppercase letter breaks routing later, far from here." That was true only while the CLIENT
was the only way in. The public RPC made it false, and Task 17 is the task that builds the
routes.

Fixed in 20261014001630_public_rpc_input_validation.sql, at BOTH levels:

- **CHECK constraints on the tables**, so the rule holds for every write path - a migration,
  service_role, anything - not just the one the browser uses. The slug format, the slug
  length, and the name lengths.
- **A timezone check in the public wrapper**, because a CHECK constraint may not call a
  function that reads a table and the zone list lives in `pg_catalog.pg_timezone_names`. An
  unknown zone is not cosmetic either: `Intl.DateTimeFormat` THROWS on an unknown zone, so
  such a tenant would break `clinicDayBounds` inside billing-window code.

The validation lives in the WRAPPER rather than in the private function for a practical
reason: the private body is long, and replacing it wholesale to add four guards is a large
hard-to-review diff. The private function is no longer reachable by `authenticated`, so
validating at the public door is sufficient - and the constraints cover the table anyway.

### MEDIUM: the clinic dimension is the ASSIGNMENT's scope, and the name said otherwise

`private.can` matches `a.clinic_id is null or a.clinic_id = p_clinic_id`: it asks whether a
GRANT of a permission exists for a clinic. It does NOT consult `private.clinic_ids`, which
is the separate conjunct RLS adds to every clinic-scoped policy.

MEASURED: a user whose MEMBERSHIP is restricted to clinic CA1, holding an ORG-WIDE grant,
answers `true` for CA2 - a clinic they cannot read. The database still refuses them the
rows, so it is safe; but a helper answering "may I access this clinic's data" is answering
a different question, and one careless `if (await userCan("patients.read",
patient.clinic_id))` would disclose another clinic's data to the UI.

So the parameter is now named `assignmentClinicId`, the doc says plainly that it asks about
a grant's scope and that `private.clinic_ids` - which RLS enforces and the helper does not
model - is the access half, and there is a test that a clinic-scoped grant answers true for
its clinic, false org-wide and false for a clinic it was never granted for. Previously the
parameter had NO test at all, so it was indistinguishable from a no-op.

### The other findings, all closed or recorded

**A vacuous control, found and armed.** The platform-key assertion in `public-rpc.test.ts`
was exactly the standing failure in this repository: the probe role held only
`patients.read`, so "false" was the answer with or without the platform clause. The fixture
now creates a REAL `platform.tenants.read` grant, asserts the user holds it, and only then
asserts the refusal. (The permission row already exists - it is one of the twenty-one
seeded keys - so it is reused rather than created, and it is not deleted on cleanup.)

**The SOURCE no longer documented a posture that no longer held.**
`tests/unit/tenant-data-sql.test.ts` still asserted that the migrations GRANT
`authenticated` EXECUTE on the three hardened functions - which 01600 revoked. The test
passed, because the historical grant lines legitimately remain in their own files, and that
is exactly the problem: a source-level test can document a posture the database no longer
has. It now asserts the REVOKE, and - because migrations are append-only and the old
grant must stay in 00600/00700/00800 - it asserts that the LAST privilege statement about
each function is the revoke.

**"Exactly three functions in public" was imprecise.** PostgREST's OpenAPI lists a fourth:
`public.rls_auto_enable`, which is Supabase's own, SECURITY DEFINER, and carries a PUBLIC
grant, so it is anon-callable - it errors harmlessly. The test excludes it explicitly and
the wording now says "the three wrappers, and nothing else of OURS".

**Recorded, not fixed:** a signed-in user can create an unbounded number of tenants, and
each call re-upserts the twenty-one global `permissions` rows, taking row locks on them
(the values are constants, so nothing is corrupted - it is write amplification and a global
serialisation point). `public.write_audit` accepts an arbitrary `p_resource_id`, so a
tenant can file rows in its own trail referencing another tenant's row ids - low impact,
and pre-existing in `private.write_audit`.

### The deferral's cost changed, and the note says so

The finding that an organization with roles CANNOT be deleted is pre-existing - the review
confirmed it independently, over HTTP, with "role accountant is still in use" - but the
PUBLIC RPC changes its cost: before, only a server-side call could create a tenant; now
any signed-in browser can, so undeletable tenants went from a rare administrative act to
something a user can do at will. The deferral note says so, and the fix - making the guard
distinguish a cascade from a deliberate role deletion - remains a change to a security
trigger, and therefore its own piece of work with its own review.

## The public RPC surface, final review: the write path was validated at ONE door, and the rules were pinned nowhere

Final review of `2ecf501`. Verdict: "safe to ship, but NOT COMPLETE, and F1 must not be
recorded as closed." The security posture was confirmed sound and measured rather than
asserted - no cross-tenant disclosure, no privilege escalation, no bypass of the
constraints - but the validation covered one of the two doors through which a tenant's
fields are written.

### F1 was only half closed: the SETTINGS path accepted anything

01630 validated the time zone in the public wrapper - the CREATE door. MEASURED over real
HTTPS, as the tenant owner:

    PATCH /rest/v1/organizations?id=eq.<org>  {"timezone":"Not/AZone"}  ->  200, stored
    PATCH /rest/v1/clinics?id=eq.<clinic>     {"timezone":"Not/AZone"}  ->  200, stored

Neither `organizations.timezone` nor `clinics.timezone` had a CHECK, and
`organizations_update` / `clinics_update` let any `settings.manage` holder write it. The
consequence was the same one 01630 was written to prevent: `clinicDayBounds` and
`formatInClinicTz` throw `RangeError` inside billing-window code for that tenant.

A CHECK CONSTRAINT CANNOT DO THIS - a check may not call a function that reads a table,
and the zone list is a view. So 20261014001640_timezone_guard.sql adds a TRIGGER, which
fires on every INSERT and every UPDATE regardless of the door.

### The rule is stricter than "the name exists", and deliberately so

MEASURED over the whole list: `pg_timezone_names` has 598 entries, 553 of them canonical
IANA names containing a slash, and 45 that do not. ICU accepts 44 of those 45 and rejects
exactly ONE: `Factory`, PostgreSQL's own placeholder for a machine with no configured
zone. So "the database knows the name" is NOT the same as "the application can use it", and
a check against `pg_timezone_names` alone would have admitted it.

The rule applied is therefore STRICTER, and stricter on purpose: the zone must be a
CANONICAL IANA name - it contains a slash - or be exactly `UTC` or `GMT`. That rejects
`Factory` because it is rejected, and it also rejects the 42 other zone-less names, which
are legacy aliases and abbreviations. For a clinic whose BILLING DAY is computed in that
zone, an abbreviation is not merely inelegant: `CST` is ambiguous between Central and
China Standard, and `IST` between India and Israel. A canonical name is the only form
that cannot be misread. It also means the rule does not depend on which ICU build is
deployed, because every canonical name is accepted by every ICU.

### F3: NONE of the new rules was pinned in source, and the table constraints had no test at all

MEASURED: with the four CHECK constraints removed from 01630, or the time zone guard
removed from 01640, or the wrapper's own validation removed, THE ENTIRE SUITE STAYED
GREEN. There is no applied-versus-source checksum anywhere in the repository -
`npm run migrations:check` validates filenames and emptiness only.

`tests/unit/public-rpc-sql.test.ts` now pins all of it in the SOURCE: the four constraints,
the trigger on both tables, the wrapper's own validation, the wrapper's default matching
the private original, the revocations (and that the LAST privilege statement about each
function is the revoke), and that every public wrapper is SECURITY DEFINER with an empty
search path. Plus one behavioural assertion: a `service_role` insert with a hostile slug
is refused with 23514, because the constraint is on the TABLE and not on the door.

### F4: the arming of the platform-key control was not itself protected

The control was arming the trap by creating a real `platform.tenants.read` grant, and
asserting the user held it - inside the same test. MEASURED: removing that test left the
suite green, because the test both CREATED the grant and ASSERTED it, so deleting the test
deleted the check along with the setup. The arming now lives in a `beforeAll`, which no
test can remove, and a separate test asserts it. MEASURED: with the grant insert removed,
the suite goes red.

### F5: a cross-file race in the suite, which produced FALSE verdicts

`audit-log.test.ts` asserted a GLOBAL `count(*) from public.audit_logs` while
`public-rpc.test.ts` COMMITS two rows into the same table in parallel. The review
reproduced it four times, and it produced three false "mutation caught" verdicts in its
first matrix pass. Both counts are now scoped to the organization under test.

This is the same shape as everything else in this task: a count that depended on state the
test did not own.

### F8, recorded: the public surface has a create and no way back

There is no public counterpart for deleting or deactivating a tenant, and a created tenant
is undeletable anyway - MEASURED, over HTTP: `DELETE /rest/v1/organizations?id=eq.<org>`
as `service_role` returns 400 "role accountant is still in use". So a user who creates a
tenant by mistake has no product-level remedy, and the platform remedy is a fourteen-role
delete per tenant. The deferral note now says so, and the deferred defect is pre-existing
rather than caused by this work - but the public RPC makes it cheap to trigger.

### The guard I wrote was wrong, and the tests were right

The first version of the guard (01640) refused a NULL time zone on BOTH tables. MEASURED
against the catalogue:

    organizations.timezone   NOT NULL, DEFAULT 'Asia/Kolkata'
    clinics.timezone         NULLABLE, no default

`clinics.timezone` is NULLABLE BY DESIGN - migration 00300 created it that way - so refusing
a NULL there refused a state the schema permits, and 50 tests in
`tests/security/rls-policies.test.ts` and `tests/security/storage-policies.test.ts` failed
with "a time zone is required". They insert clinics without a zone.

So the guard was wrong, not the tests. A validation rule that refuses a state the database
is designed to hold is not a stricter rule; it is a broken one, and it shows up as fifty
unrelated failures. 20261014001650_timezone_guard_nullable_clinics.sql corrects it: NULL is
refused for organizations, whose column is NOT NULL, and permitted for clinics, whose column
is nullable. A zone that is PRESENT and invalid is still refused on both tables, on every
write path - which is the defect 01640 was written to close, and it stays closed.

### Still open, and pre-existing: a clinic with NO zone is a landmine

`clinics.timezone` is nullable, and `clinicDayBounds` and `formatInClinicTz` take a zone
string. MEASURED: `new Intl.DateTimeFormat("en-CA", { timeZone: null })` does NOT throw -
it silently uses the RUNTIME's zone. So a clinic with no zone would bill in the server's
day rather than its own, which is worse than a loud failure.

The correct fix is to make `clinics.timezone` NOT NULL with a default, the way
`organizations.timezone` already is. That is a nullability change and therefore a product
decision about what a clinic is, not a validation detail - so it is recorded here rather
than smuggled into a guard migration.

### The arming of the platform-key control, protected properly

The control armed its trap by creating a real `platform.tenants.read` grant and asserting
the user held it - inside the same test. MEASURED: removing that test left the suite green,
because the test both CREATED the grant and ASSERTED it, so deleting the test deleted the
check along with the setup.

The arming now lives in a `beforeAll`, which no test can remove, and a separate test
asserts it is present. MEASURED: with the grant insert removed, the suite goes red.

## Closing the B and C groups: the public surface completed, and the limits put on it

Every item in the B and C groups was RE-MEASURED before being touched, and two of the
records turned out to be stale - A1 and A4 were already closed, and the stale record was
the more dangerous kind, because a "known open risk" that is actually closed stops anyone
checking, and a "closed" finding that is actually open gets trusted.

### B4 - `patients.export` HAD NO ENFORCEMENT POINT ANYWHERE

The registry carried it, the seed carried it, the role matrix carried it, and nothing
required it. The plan's own note is the right diagnosis: "RLS is row-level and grants no
column or aggregate control." A policy cannot distinguish a clinician reading one patient
from an export of every patient, so the enforcement point for an EXPORT is a definer
function, and there was none. `public.export_patients` is it, and because it is a definer
the permission check inside it is the only gate.

Reading one patient's identifiers is unchanged - a clinician who may read a patient may
read that patient's identifiers, which is the clinical need. What is now bounded is the
BULK read, and it is bounded by a permission that previously did nothing.

### B5 - `roles.is_system` HAD THREE DESCRIPTIONS AND NO TWO AGREED

The plan said "marks seeded roles". The generator's header said the same thing. The
generator's CODE wrote `role.isPlatform` - so the column marks a PLATFORM role, and every
tenant role is seeded too. The column is also write-only and INERT: nothing reads it,
`01230` replaced its use with the real invariant (`not private.role_in_use(id)`), and
`guard_role_identity` freezes it.

The code and its comment now agree, and the meaning is stated ONCE, on the column itself,
where anyone reading the schema finds it. The plan's sentence is a historical document and
is not rewritten.

### B6 - THE AUDIT FREE-TEXT SCREEN WAS A BLOCKLIST, AND THE BLOCKLIST HAD HOLES

`summary` and `narrative` passed it. A MISSPELLED key passed it. A key with SURROUNDING
WHITESPACE passed it, because the comparison was on the raw key. So the screen was not
"clinical free text is refused" but "these three spellings are refused". Keys are now
normalised - trimmed and lower-cased - before the check, and the blocklist is widened to
the words that carry clinical prose. Still a blocklist, and still evadable by a word
nobody thought of: the real closure is an ALLOWLIST of the keys the application emits,
which cannot be written until the application defines that shape.

### B7 - `setAll` CALLED MORE THAN ONCE DISCARDED EARLIER COOKIES

The rebuild constructs a FRESH response, so a second batch's write would have thrown the
first batch's cookies away - the browser keeping an expired token while the server
believed it had refreshed. MEASURED unreachable today (`getClaims()` makes exactly one
refresh and emits one batch, across an expired token, an expired token with a garbage
access token, and an invalid refresh token), so this is defence against a change we do not
control. The proxy now ACCUMULATES the cookies across calls and writes all of them on
every rebuild.

### C1 - ORGANIZATION CREATION WAS UNCAPED

A signed-in user could create unbounded tenants, and each call re-upserted the
twenty-one global `permissions` rows, taking row locks on them, so concurrent onboardings
SERIALIZED. The cap is per USER over a rolling 24-hour window - a cap per organization
would be no cap at all, because the user creates the organizations. The count is taken and
the event recorded in the same transaction as the creation, so a creation that fails does not
consume the allowance. `tenant_creation_events` is RLS deny-all and unwritable by any
client, so a user cannot lift their own cap by deleting the evidence.

### C2 - AN AUDIT EVENT COULD POINT AT ANOTHER TENANT'S ROW

A tenant could file a row in its OWN trail referencing another tenant's row id. No
disclosure - the trail is the caller's own and the actor is attributed correctly - but a
trail that can be made to lie about what happened to whom is worth fixing. If the id
matches a row in an organization-scoped table, that row must belong to the organization the
event is filed under. Ids that match nothing are allowed: an event may refer to something
that has since been deleted.

### C3 - A DEPARTED USER'S DOCUMENTS WERE UNDELETABLE BY ANYONE

A consequence of the uploader-only decision rather than a bug in it: every storage delete
policy required `owner_id = auth.uid()::text`, so when a clinician LEFT, the documents they
uploaded became undeletable by any role - the uploader had gone and no one else could
satisfy the ownership clause. For a PHI system that may have to erase a patient's
documents on request, "nobody can delete this" is the worst available answer.

The fix keeps uploader-only ownership for the ordinary case and adds the one role that
should be able to clean up after a departure: a holder of `settings.manage` in the
organization the object belongs to - strictly NARROWER than the write permission each
bucket's own policy already demands. The path is still checked and the organization is
still derived from the PATH, so the relaxation cannot reach another tenant's objects.

### C4 - A DOCUMENT REMOVED THROUGH THE STORAGE API LEFT NO TRAIL

A PHI document removed through the Storage API - which is how the browser removes one -
left no record in the project's own audit log, and the table carries no foreign keys, so
nothing else would have recorded it either. An AFTER DELETE trigger on `storage.objects`
now writes the row, with the organization derived from the object PATH and the actor from
`auth.uid()`.

A service-role deletion is recorded too, with a NULL actor: it says the platform did this
and names nobody, which is honest. The first version SKIPPED those, on the reasoning that
a platform erasure is recorded on the tenant's own row - and that skip was wrong, because
the row it would have written has a NULL actor and is invisible to every tenant-scoped
reader anyway. The skip bought nothing and cost the one case that mattered.

### FOUR MISTAKES OF MINE, ALL CAUGHT BEFORE THEY SHIPPED

**A migration applied with no file.** `20261014001696` was applied through the MCP and the
file was never written, so the database had a row in its migration history that no source
file described. `tenancy-schema.test.ts` caught it - the history had 42 rows and the
directory 41 - and that is the test doing exactly its job. The file now exists.

**`owner = auth.uid()::text` in a storage policy.** `storage.objects.owner` is a `uuid`
and the deployed policies compare it to `auth.uid()` with no cast; my hand-typed version
added `::text` and the database refused the migration with "operator does not exist: uuid =
text". The policies in the file were then produced by taking the DEPLOYED expression
verbatim and replacing only the ownership clause, so nothing else could drift - which is how
the file first went wrong a second time, passing the raw object NAME to `clinic_ids` where
the deployed policy passes the ORGANIZATION id.

**A trigger that could not call the helper it needed.** My replacements of the three
trigger functions dropped `security definer`, and a trigger that runs as its caller cannot
call `role_in_use` or `is_platform_admin` - both of which were revoked from `authenticated`
when the private surface was tightened. MEASURED: "permission denied for function
role_in_use".

**An exemption that could not fire.** The first attempt at exempting `service_role` from the
status guard compared `current_user` - and inside a SECURITY DEFINER function `current_user`
is the OWNER, not the caller, so the comparison was always true and the exemption never
happened. The guard is now an INVOKER, like `guard_platform_admin`, with a precise privilege
check: `service_role`, or a superuser, which is the platform's own administrative path and
the owner that migrations run as.

### A TEST OF MINE FAILED FOR THE WRONG REASON AND SAID NOTHING

The suspended-organization test's SETUP stopped working - the guard refused the suspension -
so the organization stayed active and the assertion below failed with "expected { ...(6) }
to be null". It now asserts the suspension HAPPENED, which is the shape of control this
repository has been insisting on for six tasks. The same pass found a test of mine whose
`set local role service_role` leaked into the next statement and made it pass for the wrong
reason.

### AND MY OWN MEASUREMENT WAS WRONG TWICE

The probe gave two principals the same role assignment and the same membership, so the
"staff.manage" principal actually held `settings.manage` too and the "settings.manage"
principal held nothing - and the results looked like findings. They were fixture bugs,
caught by printing the PREDICATE each principal sees rather than trusting whether a command
was accepted. A refused UPDATE raises; a filtered UPDATE succeeds with zero rows, so "the
command ran" is not "the row changed".

## The audit free-text screen, closed properly: screen the VALUE, not only the key name

The open finding was exact: "The free-text screen remains a key-name blocklist: summary,
narrative, a misspelling, or a key with surrounding whitespace all pass it. Recorded as a
speed bump, not a guarantee." And it was right: a blocklist screens KEYS, but the harm is in
the VALUE.

### WHY A KEY-NAME SCREEN CANNOT BE THE WHOLE FIX

MEASURED, each of these really did pass the old screen:

    {"summary": "..."}     - the key is not on the list
    {"summry": "..."}      - a MISSPELLING is not on the list
    {" note ": "..."}      - surrounding whitespace made it a different key
    {"narrative": "..."}    - likewise

A misspelled key does not leak anything BY BEING MISSPELLED. It leaks because it carries a
sentence, and a key-name screen cannot see that. So the same hole that lets a misspelling
through also lets ANY key through, however innocent it looks.

### THE RULE: A STRING VALUE MUST BE IDENTIFIER-SHAPED

No whitespace anywhere, and at most 64 characters. Audit metadata describes what HAPPENED -
a count, an id, a code, a status, a boolean - and every one of those is a token. Prose is
not, because prose has spaces in it.

That single rule closes the whole family of key-name holes at once: a misspelled key
carrying prose is refused, a padded key carrying prose is refused, and "summary" and
"narrative" are refused because what they carry is prose rather than because their names
were guessed at. The key blocklist STAYS, normalised and widened, and is now the SECONDARY
screen: it catches the case a value rule cannot - a key NAMED for free text carrying a short
value, such as `{"note": "x"}` - and the refusal names the key it objected to.

MEASURED, each of these is now refused, with the reason:

    {"code":"patient complains of chest pain since Monday"}
      -> the value of "code" contains whitespace, which no identifier-shaped value does
    {"summary":"ok"}    -> the key "summary" names clinical free text
    {"narrative":"ok"}  -> the key "narrative" names clinical free text
    {"summry":"short but prose"}
      -> the value of "summry" contains whitespace, which no identifier-shaped value does
    {" note ":"short but prose"}
      -> the key "note" names clinical free text

And the positive control, without which a screen that refuses everything would also "pass":
`{"code":"ok"}` and `{"whatever":"42"}` are both ACCEPTED - a key nobody listed, carrying a
token, is fine.

### WHAT A LEGITIMATE CALLER DOES, AND WHY

It records identifiers and codes, not phrases. A human phrase in an audit trail is a clinical
free text by another name, and refusing it is the point: `audit_logs` has no foreign keys
precisely so a trail cannot be erased along with the record it describes, which also means a
note that lands there OUTLIVES the patient row it came from. And because a tenant's trail is
invisible to a platform operator, a stray note is not even visible to the people who would
spot it. Where a phrase is genuinely wanted, the caller records a code and resolves it.

### THE RESIDUAL, STATED PLAINLY

A single-word value that is not on the key list is indistinguishable from a code, and
passes. `{"kind":"summary"}` is accepted, because "summary" has no whitespace and "kind" is
not a free-text key name. No shape-based rule can separate "ok" from "summary" - that
needs a vocabulary, and the vocabulary is the application''s own. It is a ONE-WORD residue
rather than a paragraph, and it is recorded rather than papered over.

### A BOUND, NOT A SCREEN, WAS PREEMPTED

The 8 KiB metadata cap is a distinct bound with its own message, and the new value rule was
refusing a 9 000-character value FIRST - so the test that was proving the 8 KiB cap was
proving the wrong thing. The size check now runs before the value rule, and both bounds are
asserted.

The refusal is LOUD, which is the other half of why a value rule beats a key blocklist here:
a blocklist fails silently, and this fails with a message naming the key and the reason.

## Task 14: the payment provider seam, and what a seam that lies would cost

### WHAT THIS INCREMENT IS, AND IS NOT

The design spec splits two things that are easily confused. The SEAM is the interface, the
unconfigured stub, and the one factory that chooses between them. The WIRING is Razorpay
against its sandbox, which arrives in Phase 8 with test keys, with HMAC webhook
verification, idempotency-key storage against replayed deliveries, and test cards driving
the flow. This increment builds the seam ONLY.

Nothing about billing is functional, and the seam must not pretend otherwise. The design
spec's own wording is the reason: a "test mode" that returns a successful fake payment
would misrepresent payment capability, because a caller would then believe a clinic had
been charged.

### THE SEVEN RULINGS

1. **EVERY METHOD REJECTS, AND THE STUB HAS NO SUCCESS PATH AT ALL.** Not a branch, not a
   configuration flag, no environment variable. The only way to obtain a working provider
   is to write one.
2. **THE METHODS ARE `async`, SO THE CONTRACT IS A REJECTION.** A method that threw
   synchronously would be a different contract, and a caller attaching a rejection
   handler would never see it. MEASURED in the test: the outcome is asserted to be a
   Promise before it is asserted to reject, so a synchronous throw fails the test
   rather than being mistaken for a rejection.
3. **`configured` IS A PROPERTY, NOT A METHOD.** The contract is that every METHOD of a
   provider refuses, so a method answering "am I configured?" would have to either break
   the contract by answering, or answer nothing by refusing. The boolean answer lives
   BESIDE the contract rather than inside it.
4. **`isPaymentConfigured()` ASKS THE PROVIDER IT WOULD HAND OUT.** A second source of
   truth about whether payments work is a second thing to get out of step with the first.
5. **THE SEAM IS SERVER-ONLY, ON EVERY FILE IN IT.** `import "server-only"` at the top of
   both files. The guard on the entry point is only meaningful if the file it reaches is
   guarded too, and `lib/billing/unconfigured.ts` is importable on its own.
6. **MONEY IS THE HOUSE `Minor` TYPE** (`lib/utils/money.ts`), so the seam cannot describe
   an amount in anything but paise, and `reasonCode` is a code rather than a sentence.
7. **THE TYPES CARRY DOMAIN FACTS, NOT PROVIDER FACTS** - with one deliberate exception:
   `WebhookEvent.eventType` stays the provider's own vocabulary, because a seam that
   translated every provider's event names would be a second, lossy translation layer,
   and the interpretation belongs to the subscription state machine that Phase 8 adds.

### WHAT THE FIRST REVIEW FOUND, AND WHAT CHANGED BECAUSE OF IT

The first review found no blocker and nine gaps. Two of them were the same failure class
this project has been bitten by repeatedly - a guarantee that existed in the DOCUMENT but
not in the TEST.

- **THE "NO FAKE PROVIDER" PIN COVERED ONE MODULE.** It pinned the runtime exports of
  `lib/billing/provider.ts`, so a fake provider exported from `lib/billing/unconfigured.ts`
  - or from a NEW file in the seam - would have been reachable from application code with
    NO test failing. The pin now covers the seam's FILE LIST, each module's runtime
    exports, and every provider-like export: it must be unconfigured, and it must refuse.
- **AN ENV-GATED "TEST MODE" WAS INVISIBLE.** Nothing forbade the seam from reading
  `process.env` and branching to a fake, and the AGENTS.md claim that there was "no
  environment variable anywhere in `lib/`" was FALSE - `lib/supabase/{client,server,
 proxy}.ts` read `NEXT_PUBLIC_SUPABASE_*` and `lib/auth/session.ts` read `NODE_ENV`.
  The scan now exists and the claim is scoped to `lib/billing/`.
- **`isPaymentConfigured()` WAS UNPINNED.** A hardcoded `return false` passes every other
  test in the suite, because the provider and the answer would both be false. The
  DERIVATION is now pinned by a source-text check, not just the answer.
- **`PaymentNotConfiguredError.status` WAS UNPINNED.** A mutation to 503 leaves the rest
  of the repository green. Both the status and the code are now asserted in
  `errors.test.ts`, alongside the five classes that were already there.
- **THE METHOD FINDER READ OWN PROPERTIES ONLY.** A provider written as a class puts its
  methods on the prototype, so the finder would have seen NO methods - which reads as
  "the provider has no methods" and invites weakening the pin rather than fixing the
  finder. The prototype chain is walked now, and `constructor` is excluded: it is a
  function like any other, and calling it without `new` throws something that is not a
  rejection. MEASURED by applying a class-based provider: the suite failed until both
  fixes were in, and passes now.
- **THE TEST CARRIED SEVERAL GUARANTEES IN ONE CASE**, so a later phase that changed one
  of them would have taken the others with it. It is split by guarantee now, and each
  test says what Phase 8 must do to it.
- **`verifyWebhook` TOOK A `string`, WHICH INVITES A WRONG SIGNATURE.** An HMAC is
  computed over bytes, so a payload that has been parsed and re-serialised is a different
  byte sequence and fails the check looking like a forgery. It now takes
  `string | Uint8Array`, documented as the raw body.
- **NO IDEMPOTENCY KEY.** A retried `createCheckout` or `refund` could create a second
  order or a second refund. Both inputs carry one now.
- **`CheckoutSession.url` WAS UNDOCUMENTED**, and an implementer using an in-page
  checkout would have had to either leak provider vocabulary into the browser or extend
  the seam. It is documented as a HOSTED page on the provider's domain.

### THE MUTATIONS, AND WHY THEY ARE THE EVIDENCE

A suite that cannot fail is worse than no suite, so the suite was mutated and re-run.
Twelve mutations, each caught: a provider method returning a fake session; a provider
method removed; an HTTP client imported; a global `fetch` called; a fake provider
exported; a fake provider exported from `unconfigured.ts`; a new file appearing in
`lib/billing/`; the seam reading `process.env`; the seam importing `node:http`;
`isPaymentConfigured` hardcoded to `false`; the error status changed to 503; and a
provider rewritten as a class (the last of which is a POSITIVE control - the suite must
still pass, and it did not until the prototype-chain and `constructor` fixes were in).

### THE RESIDUALS, STATED PLAINLY

- **THE SEAM'S IMPORT WHITELIST IS A DENY-BY-DEFAULT LIST** of the specifiers the seam
  may import, not a deny-list of known-bad packages. A name list of HTTP clients can only
  catch the clients somebody thought of. The cost is that Phase 8 must admit the
  provider's SDK to the list.
- **THE SCANS ARE TEXTUAL.** A module-scope `const f = globalThis.fetch` is matched by
  the `globalThis.fetch` pattern, but a computed specifier would not be. The structural
  guarantee is `import "server-only"` plus the fact that the seam holds no key yet.
- **`reasonCode` IS A CONVENTION, NOT AN ENFORCED RULE.** Nothing in the seam screens it,
  and the audit-metadata screen applies to `audit_logs`, not here.

## Task 14, second review round: the controls had holes in them, and the holes were all evasions

The first round closed nine gaps. The second round found no blocker and seven gaps, and
every one of them was an EVASION of a control the first round had added. That is the
shape of the finding: a deny-list of known-bad packages only catches the packages
somebody thought of, and a scan for one spelling of an access only catches that spelling.

### THE SEVEN, AND WHAT EACH WAS

1. **THE IMPORT WHITELIST DID NOT MATCH RE-EXPORTS, AND A RELATIVE IMPORT COULD LEAVE
   THE SEAM.** `importSpecifiers` matched `import` and `require` but not `export ... from`,
   so a re-export of a network client into the seam was invisible; and every relative
   specifier was allowed unconditionally, so `import { c } from "../supabase/server"`
   passed - a module that reads the environment and imports `@supabase/ssr`. Now a
   re-export counts as a dependency, and a relative import must RESOLVE INSIDE
   `lib/billing/`.
2. **THE PROVIDER-LIKE SCAN WAS BLIND TO A CLASS.** `isProviderLike` required
   `typeof value === "object"`, and a class is a FUNCTION. So a class-shaped fake - the
   exact shape the implementer's own positive control used - would have been judged
   harmless. The scan now inspects a function's prototype as well as an object's own
   methods.
3. **THE ENVIRONMENT SCAN CAUGHT ONE SPELLING.** `process.env` yes; `process["env"]` and
   `const { env } = process` no. MEASURED, all three were missed. Three access patterns
   now, and prose about "the process environment" deliberately does not trip them,
   because a rule that fires on English is a rule that gets switched off.
4. **AGENTS.md CONTRADICTED THE TEST FILE** about what Phase 8 replaces. It said the
   file-list pin and the import whitelist are NOT replaced; the test file said PHASE 8
   REVISES THIS, and adding a provider module does make the file-list pin fail. The
   wording is now REPLACES one test, EXTENDS three lists - and the point of extending a
   list is that a fake cannot be added without a list changing.
5. **THE REVIEW PACKAGE WAS STALE** and there was no task report, so the SDD record
   contradicted the code. Both written.
6. **METHOD SYNTAX MADE THE INPUT TYPES ADVISORY.** `strictFunctionTypes` does not check
   the parameters of a METHOD declaration, so a Phase 8 implementation could narrow
   `verifyWebhook(payload: string | Uint8Array, ...)` to `string` and still typecheck -
   which is exactly the mistake the raw-body contract exists to prevent. The interface
   members are now properties of function type, so the parameter is checked
   contravariantly and the narrowing is a compile error.
7. **FOUR PHASE 8 TRAPS.** A refund had no payment to name - a provider refunds a
   PAYMENT, and the seam had no `providerPaymentId` anywhere, so `RefundInput` named a
   checkout session. A forged signature had no failure contract. `import { type X }` under
   `verbatimModuleSyntax` still emits a runtime import, so a client component must use a
   top-level `import type`. And the design spec wants subscription state unit-tested
   against a fake, which the seam's pins forbid inside `lib/billing/` - so the fake
   belongs in `tests/fixtures/`.

### THE HTTP-CLIENT RULE IS NOW A WHITELIST, AND THAT IS THE GENERAL LESSON

The rule used to be "no import matches a list of known-bad HTTP clients". That list is
now the OTHER way round: `lib/` may import NOTHING that is not on a short, explicit list
of eight packages, two of which (`@supabase/ssr` and `@supabase/supabase-js`) are HTTP
clients and are there on purpose - they are the sanctioned way for this application to
talk to Supabase, and the rule is that there is no OTHER way. A new HTTP client in
`lib/` is now a test failure rather than a review comment.

### EIGHTEEN MUTATIONS, EACH CAUGHT, AND ONE THAT WAS A POSITIVE CONTROL

The first round's twelve, plus six aimed at the second round's holes: a re-export of a
payment SDK in the seam; the seam importing a module outside itself; the seam reading
`process["env"]`; the seam destructuring `env` off `process`; a class-shaped fake
provider exported; and an unsanctioned package imported outside the seam. Each is caught
by the specific assertion, not by a collateral failure.

The positive control is still the informative one: a provider rewritten as a CLASS must
make the suite PASS, and it did not until the prototype-chain walk and the `constructor`
exclusion were both in. That is a bug in the FINDER rather than in the code, and it was
found only because a control was required to move in the positive direction.

### WHAT IS STILL OPEN, AND IS NOT

- The scans are TEXTUAL. They catch the three environment spellings and the four import
  shapes; a computed specifier would evade them. The structural guarantee is
  `import "server-only"` plus the fact that the seam holds no key yet.
- The sanctioned package list is a whitelist, so adding a legitimate library to `lib/` is
  a deliberate act and a test failure until it is sanctioned. That is the intended
  behaviour, and it is worth saying so before someone reads it as an obstacle.
- `reasonCode` is a CONVENTION, not an enforced rule. Nothing in the seam screens it,
  and the audit-metadata screen applies to `audit_logs`, not here.

## Task 14, third review round: the claims were pinned in the DOCUMENT and not in the TEST

The first two rounds closed nine gaps and then seven evasions of the controls the first
round had added. The third round found no blocker either, and one thing the first two
rounds had missed entirely: **the seam's TYPE SURFACE was pinned by nothing at all.**

### THE BLOCKER: MONEY WAS NOT PINNED, AND THE DOCUMENT OVER-STATED IT AS ENFORCED

The docs said the seam "cannot describe an amount in anything but paise". MEASURED: a
mutation that turned `RefundInput.amountMinor` from `bigint` into `number` left
**every test in the repository green**. A runtime test cannot hold a type still, because
`Object.keys` cannot see one - the five input/output types are invisible to every
assertion in the suite.

So the pins are now COMPILE-TIME, in `tests/unit/payment-provider.test.ts`, and
`npm run typecheck` is the gate that enforces them. The key sets of all five types are
pinned too, in both directions, because a field that silently disappears is as much a
hole as a field that changes type.

### AND THE FIRST COMPILE-TIME PIN WAS ITSELF A CONTROL THAT COULD NOT SEE

Three failures in a row, and each is the same shape as the bug it was meant to catch.

1. **THE CANONICAL `Equal<X, Y>` WAS BROKEN BY PRETTIER.** Written correctly as
   `(<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)`, it comes
   back from `npm run format` with the right-hand parentheses REMOVED - and the stripped
   form evaluates to `true` for EVERY pair. MEASURED, and it is the worst kind of bug: a
   control that reads like a working one. The pins now use `Extends`, `Same` and
   `KeysAre`, which contain no function types and which Prettier cannot alter.
2. **AN INTERSECTION OF BOOLEAN CHECKS IS NOT "EVERY ONE OF THEM".** `true & false` is
   still ASSIGNABLE to `true`, so a constraint of `extends true` is satisfied by an
   intersection containing a `false`. The first version of the amount pins intersected
   five `Equal`s and caught NOTHING. A tuple of booleans fails the constraint properly
   and names WHICH position failed - the error reads
   `[true, true, false, true, true] does not satisfy the constraint 'readonly true[]'`.
3. **A KEY-SET CHECK IN ONE DIRECTION IS HALF A CHECK.** "Every expected key is present"
   is satisfied by a type that LOST a key, and "no unexpected key is present" is
   satisfied by one that GAINED a key. MEASURED: a mutation that removed `refundId`
   from `RefundResult` passed a one-directional pin.

### THE OTHER FINDINGS, AND WHAT CHANGED

- **THE PROVIDER-LIKE SCAN DID NOT COVER THE MODULE PHASE 8 ADDS.** The scan listed
  the two modules by hand, so a new module would have been scanned by nobody - and the
  AGENTS.md hand-off list did not mention it. ONE map now drives the file list, the
  export pins and the provider scan, so a module added to the seam cannot escape any
  of them.
- **THE EXPORTED PROVIDER WAS MUTABLE.** The stub is exported and the factory hands out
  that very object, so `Object.assign(unconfiguredProvider, { createCheckout: fake })`
  would have installed a fake into the singleton every caller receives, with no test
  seeing it. `Object.freeze` closes it, and a test asserts the freeze.
- **THE `lib/`-WIDE PACKAGE RULE SKIPPED RELATIVE AND ALIAS SPECIFIERS**, so a vendored
  copy of a client could be reached with `../vendor/axios`. A relative import in `lib/`
  must now resolve inside `lib/` or `types/` - the latter holds the generated database
  types, which four modules import. MEASURED: the first attempt at this rule flagged
  those four legitimate imports, which is how the `types/` exception was found.
- **A REFUND NAMED NO TENANT.** `createCheckout` carries `organizationId` and `refund`
  did not, so the seam could not say whose money was being refunded. `RefundInput`
  carries it now.
- **AN EVENT COULD NAME NEITHER AN ORDER NOR A REFUND.** `WebhookEvent` carries
  `providerOrderId` and `refundId` now - and `refundId` is how a caller learns that an
  ASYNCHRONOUS refund finally succeeded or failed, which no return value can tell it.
- **THE IMPORT SCAN FIRED ON PROSE.** A block comment containing a line that looked
  like an import was reported as a dependency. The scan now strips comments first, using
  the `stripComments` helper `scripts/check-no-secrets.ts` already exports.
- **THE SCANNER SKIPPED SYMLINKED DIRECTORIES**, and `.mts`/`.cts` were not in the
  extension list. Both fixed, because a scanner that silently skips a file is the
  failure this project has been bitten by repeatedly.
- **THE DOCS OVER-STATED "SWAPPING PROVIDERS IS A ONE-FILE CHANGE".** The
  IMPLEMENTATION is one file; the INTERFACE has to grow for a provider whose flow this
  seam cannot describe, and that is expected rather than a failure. The seam describes a
  HOSTED checkout, and Razorpay's Orders + `checkout.js` flow - which needs a publishable
  key and provider parameters in the browser - is not describable by it as it stands.
  Phase 8 must either use a hosted flow (a Razorpay Payment Link) or extend the
  interface. A publishable key is NOT a secret, so the server-only boundary is about the
  SECRET key and does not itself forbid one.

### THE MUTATIONS ARE NOW TWENTY-SIX, AND THE LAST EIGHT ARE COMPILE-TIME

The first eighteen were runtime mutations. The last eight are TYPE mutations, and they
are caught by `npm run typecheck` rather than by `npm test`: an amount becoming a
`number` in each of the four amount fields; a field disappearing from `RefundInput`,
`WebhookEvent` and `RefundResult`; a field appearing in `CheckoutSession`; and a method
appearing in `PaymentProvider`. All eight are caught, and the tuple in the error message
says which position failed.

## Task 15: the auth pages, and the two things the plan says in prose that its file tree contradicts

### THE E2E SUITE HAD NEVER RUN, AND IT FAILED

MEASURED: `npx playwright test --project=chromium` answered "4 failed, 2 passed". The
Playwright browsers were installed for an OLDER version than `@playwright/test@1.64.0`
wants (the installed set was 1208/1234/1243 and the version needs 1248), so every spec
had been failing to LAUNCH with "Executable doesn't exist" - which reads as a broken
test rather than a missing browser. The brief's Step 4 was not met, and nothing in the
gates said so: `npm test` does not run the E2E suite, and the e2e scripts still carried
`--pass-with-no-tests`.

### AND THE ONE PASSING SPEC PASSED FOR THE WRONG REASON

It asserted only a URL, and Next's 404 page satisfies a URL assertion. The build's
route manifest held no `/app/onboarding` and no `/app/dashboard` route, so the sign-up
landed on a 404 and the spec called it a success. The spec now asserts the SESSION
COOKIE, which is the thing that says the user was actually signed in - and the cookie
is what the 404 could not fake.

### THE REDIRECT TARGETS, AND A CONTRADICTION INSIDE THE PLAN

The plan states the url contract three times - Task 15's brief ("assert `/app/dashboard`
reachable"), Task 16's "Produces" line, and Task 16's Step 1 ("assert `/app` renders an
onboarding screen") - and its FILE TREE spells the same directory `(app)`. The same
tree lists the auth group as `(auth)` while the brief lists those routes as `/login`,
so the tree's group names are not url segments and the PROSE is the contract. The
routes are `/app/dashboard` and `/app/onboarding`, and Task 16 creates them; until then
a sign-up lands on a 404, which the spec records rather than papers over.

### THE PASSWORD RESET WAS ENUMERABLE, AND COULD NOT WORK

A success answered 200 and a failure answered 500 with "Something went wrong", so the
two answers differed and the difference was an account-existence oracle. Every outcome
is now the same 200 and the same body, and the error is logged on the server.

The flow could not work either: the page checked that a `?code=` parameter EXISTED and
nothing ever exchanged it for a session, and `updateUser` needs a session. The exchange
now happens in a ROUTE HANDLER - the only place that can set a cookie - with the
destination matched against an ALLOW-LIST, because a `next` from the query string that
was not checked is an open redirect. The page then checks for a SESSION, which is a real
check.

MEASURED, and recorded as BLOCKED rather than as working: the recovery mail redirects
to `${NEXT_PUBLIC_APP_URL}/api/auth/verify?next=/reset-password`, and GoTrue refuses to
send to a redirect the HOSTED project has not allow-listed. `supabase/config.toml` only
configures a local `supabase start` stack, so editing it cannot change the live project.
**The hosted project's redirect allow-list must include the app URL**, and that is an
operator's step.

### THE OTHER ROUND-1 AND ROUND-2 FINDINGS

- **A SIGN-UP COULD NOT BE COMPLETED WITHOUT A NAME**, though the field says
  "(optional)". MEASURED with the repo's zod: `""` fails `min(1)` and `undefined`
  passes, and the form seeded `""` - so the resolver never reached the server action.
- **A WRONG PASSWORD WAS A GENERIC 500.** `toSafeResponse` only lets an `AppError`
  contribute a message, and a Supabase `AuthError` is not one, so a typo was reported as
  "Something went wrong. Please try again." MEASURED: the provider answers
  "invalid login credentials" with the code `invalid_credentials` for BOTH a wrong
  password and an unknown address, so "Invalid email or password." is
  enumeration-safe - and the mapping is by CODE, because a code survives a wording change
  that a message would not.
- **THE PASSWORD REACHED THE URL WITHOUT JAVASCRIPT.** The forms had no action, so a
  native submit GET the form and put every field - including the password - in the
  query string: history, access log, Referer. The forms carry a real action and the
  actions accept FormData as well as an object.
- **THE VERIFY PAGE GUESSED INSTEAD OF DETECTING**, as the brief names: it was a client
  component, its own comment said it could not see a session, and then it showed
  "Already signed in" to EVERYONE. It is a Server Component now and asks. Its exchange
  branch was keyed on a `type=email` parameter Supabase's links do not carry, and its
  redirect was `redirect()` inside a client `setTimeout`, which throws `NEXT_REDIRECT`
  outside a render and never redirects at all.
- **THE PAGES ARE SERVER COMPONENTS WITH CLIENT FORMS**, which is the brief's structure,
  and it puts each route's metadata and the session check where they belong - one
  metadata title served all six routes before.
- **A CARD TITLE IS NOT A HEADING.** shadcn's `CardTitle` renders a `div`, so the pages
  had no heading at all - invisible to a screen reader navigating by heading, and to any
  test looking for one. The auth pages wrap their titles in an `<h1>`.
- **`useActionState`'s DISPATCH RETURNS NOTHING**, so a loading state built on awaiting
  it is dead. `isPending` is the real signal.
- **THE SPEC POLLUTED THE LIVE PROJECT.** It created five real accounts per run against
  a rate-limited public endpoint and deleted none. It now creates ONE account with the
  admin API, goes through the public endpoint exactly once, and removes both - the live
  database reads 0 auth users after a run. It also RETRIES a refused call, because the
  provider's limit is shared by every address, every run and every browser project.
- **THE DEPENDENCIES.** zod is pinned again at 4.6.7, the new packages are pinned
  exactly as every other dependency is, and `@radix-ui/react-label` is gone - the
  unified `radix-ui` package every other component imports from already provides it.
- **`--pass-with-no-tests` IS GONE** from the e2e scripts, as AGENTS.md requires of the
  task that adds the first real spec.

### THE RESIDUALS, STATED PLAINLY

- **A SIGN-UP LANDS ON A 404 UNTIL TASK 16.** The routes are Task 16's, and the spec
  asserts the route and the session rather than a page that does not exist yet.
- **NO RESET MAIL IS SENT IN THIS ENVIRONMENT.** MEASURED: a request for an unknown
  address returns 200, and a request for a real account at `example.com` - where the
  E2E accounts live - is refused with the provider's code `email_address_invalid`. The
  CAUSE was not established, so it is not asserted: "no MX record" is the likely one and
  a guess. What is measured is the difference - the provider only attempts a send for
  an account it knows. That a mail ARRIVES is not verifiable here without a mailbox; what
  is verifiable - the generic response - is asserted.
- **THERE IS NO SIGN-OUT CONTROL.** The button belongs to the signed-in shell, which is
  Task 16's, so the spec's "sign out" step clears the session cookie - the state a
  sign-out leaves - and says so.

## Task 16 - the signed-in application shell, organization onboarding and invitations

### WHAT WAS BUILT

- `app/app/` - the signed-in application: `layout.tsx` (the shell), `page.tsx` (the
  `/app` index, which redirects to the dashboard), `dashboard/page.tsx`,
  `onboarding/{page,panel,form,actions}.ts(x)` and `settings/members/{page,invite-form,
actions}.ts(x)`. `app/invite/[token]/{page,actions}.ts` and `accept-button.tsx` are the
  invitation link.
- `components/app/{sidebar-nav,org-switcher,clinic-switcher}.tsx` - the shell's three
  client components.
- `lib/auth/active-org.ts` gained `listMemberOrgs`; `lib/auth/session.ts` gained the
  `cc_active_clinic` cookie; `lib/errors.ts` gained `ActionResult` and
  `toActionResult`; `lib/validation/invitations.ts` is new.
- Three migrations: `20261014001720_invitations.sql`,
  `20261014001730_invitation_digest_correction.sql` and
  `20261014001740_migration_history_name_fix.sql`.
- Two E2E specs: `tests/e2e/onboarding.spec.ts` and `tests/e2e/invitations.spec.ts`,
  plus the shared `tests/helpers/e2e-sign-in.ts` and `tests/helpers/e2e-cleanup.ts`.

### THE RULINGS, AND WHY

- **THE URL CONTRACT IS `/app/...`, SO THE DIRECTORY IS `app/app/` AND NOT
  `app/(app)/`.** The plan's file tree spells the group `(app)`, but the plan's own
  "Produces" line, Task 16's Step 1 and Task 15's brief all say `/app/...`, and the
  same tree lists the auth group as `(auth)` while the brief lists those routes as
  `/login` - so the tree's group names are not url segments. A pathless route group
  would have added a directory level with no behaviour.
- **THE LAYOUT CALLS `getActiveOrg()`, NOT `requireActiveOrg()`.** The plan's Step 3
  says "the `(app)` layout calls `requireActiveOrg()`. If it returns null ..." -
  and `requireActiveOrg()` THROWS when there is no active organization, so it cannot be
  the thing whose null result is checked. `getActiveOrg()` is the null-returning
  sibling.
- **ZERO MEMBERSHIPS IS NOT THE SAME AS NO ACTIVE ORGANIZATION, AND THE SHELL
  DISTINGUISHES THEM.** `getActiveOrg()` answers null in four situations: signed out,
  no memberships, a cookie naming an organization the user has left, and several
  organizations with no cookie chosen. Only the second is "create your organization";
  the third and fourth render the PICKER, because the house rule in
  `lib/auth/active-org.ts` is that a stale cookie never falls back to another tenant.
  Rendering onboarding for a user who already belongs to a tenant would offer to
  create a second organization to somebody who needs to choose a first one.
- **THE GRANT CEILING WAS ENFORCED IN SQL, NOT IN TYPESCRIPT.** `private.can_grant`
  already refused an assignment whose role holds a permission the grantor does not,
  and the `user_role_assignments` INSERT policy uses it. The INVITATION path did not:
  the acceptance function is a definer, so it created the assignment with no policy in
  the way. `private.can_assign_role` is `can_grant` plus the rule the registry cannot
  express - only an existing `organization_owner` may grant `organization_owner`,
  because `organization_owner` and `organization_admin` carry byte-identical
  permission sets (MEASURED by migration 01240). The `invitations` INSERT policy calls
  it and `public.grantable_roles` is the thin wrapper the UI asks, so the rule is in
  ONE place and the browser cannot widen it.
- **THE PUBLIC RPC SURFACE IS THE ONLY DOOR.** PostgREST exposes the `public` schema
  only (MEASURED in migration 01600), so `private.accept_invitation` is unreachable
  from a browser and `public.accept_invitation` wraps it - the same pattern as the
  three wrappers of 01600. `private.accept_invitation` keeps EXECUTE for
  `authenticated` because the plan asks for it; the capability it adds beyond the
  wrapper is nil, because the wrapper adds no restriction of its own.
- **THE DASHBOARD SHOWS NO NUMBERS.** There is no clinical data yet, so a KPI would
  be a fabrication. The page shows the organization, the caller's own role assignments
  and an explicit empty state.

### THE MEASUREMENTS

- **`public.digest` DOES NOT EXIST ON THIS PROJECT.** The first acceptance function
  hashed with it, and the query `select encode(public.digest('probe-token','sha256'),
'hex')` fails with `42883: function public.digest(unknown, unknown) does not exist`.
  pgcrypto is installed in the `extensions` schema - migration 00100's `create
extension pgcrypto with schema public` was SKIPPED because the extension was already
  there - so `pg_proc` holds `digest(bytea,text)` and `digest(text,text)` in
  `extensions`. The correction uses the PostgreSQL built-in
  `pg_catalog.sha256(pg_catalog.convert_to(...))`. A plpgsql body is not validated at
  creation time, so the broken function was CREATED successfully and would have failed
  at the first acceptance - which is why the correction is a new file.
- **THE TWO SIDES OF THE TOKEN DIGEST AGREE, AND THE E2E PROVES IT A THIRD TIME.**
  postgres `sha256(convert_to('probe-token','UTF8'))`,
  postgres `extensions.digest('probe-token','sha256')` and node
  `createHash('sha256').update('probe-token')` all produce
  `92e2a3caaa3bec34d48004c7da4036f21c00828f51788c7650b9ee4ba5ef63d5`.
- **THE APPLIER RECORDS THE `name` IT IS GIVEN, AND A BARE STEM BREAKS THE HISTORY
  ASSERTION.** The first two applies named their migrations `20261014001720_invitations`
  and `20261014001730_invitation_digest_correction`, without the `.sql`, and
  `tests/integration/tenancy-schema.test.ts` failed: the history must name every
  migration file exactly once. Re-applying would have left FOUR rows for two files -
  the applier does not dedupe by idempotency key, it re-executes - so
  `20261014001740_migration_history_name_fix.sql` renames the two rows and nothing
  else.
- **A GENERIC `button[type="submit"]` SELECTOR IS AMBIGUOUS IN THE SHELL.** The first
  invitation E2E clicked the SIGN-OUT control - the shell header's form comes first in
  the DOM - and failed on the sign-in page. The specs click by accessible name.
- **THE LIVE PROJECT AFTER THE E2E RUNS:** 0 organizations, 0 audit logs, 0 auth users,
  0 invitations, 0 memberships, 0 user_role_assignments, 0 clinics, 1 role (the
  platform role). The `tenant_creation_events` ledger holds 29 rows, all created
  before this task; the two rows this task's runs left behind were removed by hand.
- **A PRE-EXISTING LEAK IN `tests/integration/public-rpc.test.ts` WAS FOUND AND
  CLOSED.** The `tenant_creation_events` ledger has no foreign key, so the row
  `public.create_organization_with_owner` writes for each organization created
  survives the account and the organization that made it - and that file creates
  tenants over real HTTPS. MEASURED: the ledger count went 29 -> 31 across one
  `npm run test`, and the new rows' `user_id` pointed at accounts that no longer
  existed. The cleanup now deletes the ledger rows for the accounts it deletes, and
  the count is stable across a run. The ledger is the rate-limit EVIDENCE for tenant
  creation, so a probe's rows in it are not a neutral thing to leave behind.

### THE RESIDUALS, STATED PLAINLY

- **TASK 15'S "THERE IS NO SIGN-OUT CONTROL" IS NOW OUT OF DATE.** Task 16 added the
  control to the signed-in shell - a form whose action is the `signOut` server action -
  and `tests/e2e/onboarding.spec.ts` covers it: the control ends the session and lands
  on the sign-in page. The auth spec still clears the cookies by hand, because that
  spec exercises the AUTH pages and the control lives in the shell. The Task 15
  section above is left as it was written: this file is append-only, and a correction
  belongs at the end rather than in the record of an earlier task.
- **INVITATION DELIVERY IS NOT IMPLEMENTED, AND THAT IS BLOCKED.** There is no mail
  provider, no send, and no queue. The owner-facing form on `/app/settings/members`
  DISPLAYS the link for manual sharing and says in the UI that ClinicCore does not
  send invitation emails yet. Nothing about a notification is claimed.
- **THE INVITATION PAGE DOES NOT NAME THE ORGANIZATION.** The `invitations` table is
  readable only by a holder of `staff.manage` in the owning organization, and the
  invitee is not a member yet. A preview RPC is a later task.
- **THE ROSTER SHOWS USER IDS.** `profiles` is readable only by its owner and
  `auth.users` is not readable by a client, so a member's name is not available to
  another member under the current privacy model.
- **THE CLINIC SWITCHER IS A NEW PIECE OF STATE** - a `cc_active_clinic` cookie - that
  no clinical screen consumes yet. It exists because the plan requires the component,
  and a switcher that cannot switch is dead UI. It is re-validated on every read, and
  the dashboard shows the active clinic.
- **AN INVITATION'S `clinic_ids` IS NOT USED.** The schema carries it, the acceptance
  function ignores it, and the invite form does not offer a clinic choice: the
  invitation grants an organization-wide role.
- **THE MEMBERSHIP RATE CAP IS FIVE ORGANIZATIONS PER USER PER 24 HOURS**, measured in
  Task 13's `public.create_organization_with_owner`. The E2E creates one organization
  per account, so it does not approach the cap.

## Task 16 - the review fixes: the invitation ceiling, the parameterised rules, and the gaps

### WHAT THE REVIEW FOUND, AND WHAT CLOSED IT

**BLOCKER 1 - a privilege escalation through the invitations UPDATE policy.** The grant
ceiling was in the invitations INSERT policy only. `invitations_update` had no ceiling,
and the UPDATE policy is what changes the role an invitation will grant. MEASURED
against the real policy set: a `medical_director` holds `staff.manage` and the
doctor's permissions but not `settings.manage`, `billing.manage` or
`subscription.manage`, so it could

1. INSERT an invitation naming the `doctor` role - the ceiling passes, because every
   permission of `doctor` is one it holds;
2. UPDATE that invitation's `role_id` to the tenant's `organization_owner` - the old
   UPDATE policy checked only `staff.manage` and membership, so the update SUCCEEDED;
3. redeem the token it already held - `private.accept_invitation` is a definer, so no
   policy was in the way, and it created the `user_role_assignments` row for
   `organization_owner`.

The result was a medical_director holding the tenant's owner role, with
`settings.manage` (which rewrites the slug, the currency and the timezone),
`patients.export` and `subscription.manage`.

Fixed in BOTH halves, because either alone leaves a way in:

- `20261014001760` recreates `invitations_update` with
  `private.can_assign_role(organization_id, role_id)` in its `WITH CHECK`.
- `20261014001760` also rewrites `private.accept_invitation` to evaluate the ceiling
  FOR `invited_by` - the definer cannot trust the stored `role_id`, because the
  policies that guarded the creation do not guard the redemption. The ceiling is
  evaluated at redemption time, so an invitation whose inviter has since lost the
  relevant permissions is refused.

**The rules had to be answerable for a given user.** `private.can_assign_role`
answers for `auth.uid()`, which is the ACCEPTOR - but the acceptance has to judge the
INVITER, who chose the role. So `20261014001750` parameterises the rules by user and
turns the existing entry points into delegations:

    private.is_member_for(user, org)          <- private.is_member(org)
    private.can_for(user, org, perm, clinic) <- private.can(org, perm, clinic)
    private.can_grant_for(user, org, role)    <- private.can_grant(org, role)
    private.can_assign_role_for(user, org, role)
                                                <- private.can_assign_role(org, role)

There is still ONE copy of each rule. The alternative - re-deriving "does this user
hold this permission" inside a new function - would be a second copy of the most
important rule in the database, and this repository has already been bitten by exactly
that twice. The `*_for` functions are not granted to `authenticated`: they answer
questions about OTHER users, and only definer functions call them.

**BLOCKER 2 - the ceiling had no content assertion, and a mutation was invisible.**
`tests/security/rls-policies.test.ts` asserted only that the invitations policies had
a non-null `with_check`. It now has a block - "the invitation grant ceiling" - with
six tests, each refusal beside a positive control:

- FRANK (who holds `staff.manage` and nothing else) cannot INSERT an invitation
  naming a role whose permissions he does not hold, and CAN insert one naming the role
  whose only permission is `staff.manage`.
- FRANK cannot UPDATE an invitation's `role_id` to such a role, and CAN update the
  invitation's other columns.
- The acceptance refuses an invitation for a SUSPENDED organization.
- The acceptance refuses an invitation naming a role of ANOTHER tenant. (The state is
  reachable: `private.guard_role_identity` guards a role's key and its system flag, not
  its organization, so a role can be moved between tenants under an invitation that
  already names it.)
- The acceptance refuses an invitation addressed to somebody else.
- The acceptance refuses an invitation whose inviter was not allowed to grant the role.
- And a POSITIVE CONTROL: a well-formed invitation, addressed to the acceptor, is
  accepted, and the acceptor gains the membership and the named role.

**MEASURED, THE MUTATION IS VISIBLE.** Replacing `private.can_assign_role` with
`select true` in the live database and running the security suite fails EXACTLY TWO
tests - "refuses an invitation naming a role the inviter may not grant" and "refuses
to move an invitation to a role the writer may not grant" - both with "expected a
failure matching /row-level security/i but the statement succeeded", which IS the
escalation succeeding. The function was restored byte-for-byte afterwards:
`md5(prosrc)` is back to `cb34fa61a9f9391554b600c3e005c78d`. The whitespace matters:
a one-line redefinition of the same function leaves a different md5, and the restore
had to be repeated with the migration's exact text.

### THE GAPS

**GAP 3 - `switchClinic` was not scoped to the active organization.** The `clinics`
SELECT policy spans every organization the user belongs to, so a lookup by id alone
accepted the other tenant's clinic, and a cookie naming it is a cross-tenant filter
the moment a clinical screen reads it. The action now resolves the active
organization and requires the clinic to be in it; the dashboard's active-clinic
lookup is scoped the same way. MEASURED by the E2E spec, which puts the other
tenant's clinic into the control by hand - through the NATIVE value setter, because
React tracks the value on the node and an assignment through the tracked property
makes React believe nothing changed - and watches the refusal.

**GAP 4 - the currency and the locale were collected, validated and discarded.** The
creation RPC took neither, so the column defaults won: a clinic that typed USD got
INR, with no error. That is not cosmetic - money is stored in the TENANT's currency,
so the currency a tenant is born with decides the unit of every amount it will ever
hold. `20261014001770` gives `public.create_organization_with_owner` the two
parameters (defaulted, validated, and applied to the new tenant in the same
transaction as the creation), and the types were regenerated.

The PRIVATE creator is deliberately unchanged. Its body holds the generated
organization role seed, whose canonical home is
`20261014000600_onboarding_rpc.sql` - and the drift guard
(`tests/unit/onboarding-seed.test.ts`) reads THAT file. Re-inlining a 250-line
generated block into a second migration would leave the guard watching a historical
definition rather than the effective one, which is the exact failure the guard exists
to catch. The four-argument public function was dropped, because `create or replace`
does not replace a function whose signature has changed - it creates an overload, and
two public functions with the same name would leave the generated types choosing
between them.

**GAP 5 - the invitation's address was never enforced.** The capability-URL model is
defensible, but the stored address then presents the row as naming a person it does
not name: the owner's roster showed "Pending" for ever, and any bearer of the link
took the role. **The choice made: the acceptance is bound to the ACCEPTOR's
address** - the stored `citext` address against `auth.jwt() ->> 'email'`, the
acceptor's verified claim, failing CLOSED when the claim is absent. The address is
therefore the invitation's credential in the owner's roster, and the link alone is
not enough. The invite form is given the invitee's own address, and the E2E spec
uses the invitee's address for the invitation.

### THE NITS

- **AN INVITATION THAT NAMES CLINICS IS REFUSED RATHER THAN OVER-GRANTED.**
  `invitations.clinic_ids` used to be ignored and the acceptance created an
  ORGANIZATION-WIDE assignment, which is an over-grant for a clinic-scoped
  invitation. The foundation's invite form offers no clinic choice, so the honest
  behaviour is to refuse such an invitation. Honouring `clinic_ids` properly is a
  later task, and it needs `clinic_memberships` rows as well: without them
  `private.clinic_ids` falls back to ALL of the organization's clinics.
- **THE CREATION CAP NOW HAS A MESSAGE.** The onboarding action maps `23514` - the
  five-organizations-per-user-per-24-hours cap - to a sentence instead of a generic 500.
- **THE TOKEN IS STILL IN THE URL, AND THAT IS A RESIDUAL.** The invite page sends
  `Referrer-Policy: no-referrer`, so the token does not leak to anything the page
  links to, but the URL is the plan's contract (`/invite/<token>`) and the token is
  therefore in the browser's history and in any access log. A one-time code or a
  fragment would fix it, and is a later task.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test` (838), `npm run build` and
`npm run format:check` all exit 0. The E2E suite passes on chromium: 4 onboarding
tests (including the clinic-scope refusal) and 2 invitation tests. The live project
after the runs: 0 organizations, 0 audit logs, 0 auth users, 0 invitations, 0
memberships, 0 assignments, 0 clinics, 1 role, and the `tenant_creation_events`
ledger back at its 29 pre-existing rows.

## Task 16 - the second review: ONE ceiling on every path, and a PROVEN address

### THE BLOCKER: THERE WERE TWO CEILINGS, AND THEY CONTRADICTED EACH OTHER

The ceiling was in the invitations INSERT and UPDATE policies. The DIRECT assignment
path - `user_role_assignments_write` and `user_role_assignments_update` - still called
`private.can_grant`, which is the SUBSET rule alone: every permission of the target
role must already be held by the granter.

The subset rule cannot tell an `organization_admin` from an `organization_owner`,
because they carry BYTE-IDENTICAL permission sets - MEASURED by migration 01240 itself,
in the live database. So the direct path was an escalation in one statement:

    insert into public.user_role_assignments (organization_id, user_id, role_id)
    select <org>, <self>, <the organization_owner role>

and the granter became the tenant's owner - with `settings.manage` (which rewrites the
slug, the currency and the timezone), `patients.export` and `subscription.manage` - and
could then mint owners through the invitation path that the first review closed.

`20261014001780` replaces both `with_check` clauses with
`private.can_assign_role(organization_id, role_id)`, which is the subset rule AND the
owner-only clause. The SUBSET rule is unchanged - it is the first half of
`can_assign_role` - and the two paths now answer to ONE ceiling.

The test that pinned the wrong behaviour is gone. It used to assert that "the
admin-creates-owner flow keeps working, which is why the ceiling is a subset"; that was
the hole, stated as a requirement. It is now "refuses an administrator the owner role,
and allows a real owner", with a real owner staged for the positive control.

### THE GAP: THE OWNER CLAUSE HAD NO ISOLATING TEST

Every refusal in the invitation block was explained by the SUBSET rule, so deleting
the owner clause from `can_assign_role_for` left the suite green. The new tests make
the clause observable on its own: a granter who holds the owner's whole permission set
but is not the owner - DAVE in the security fixture - is refused `organization_owner`
on BOTH paths, each beside a positive control that a real owner is allowed.

**MEASURED, THE MUTATION IS VISIBLE.** Replacing `private.can_assign_role_for` with
`select private.can_grant_for(p_user_id, p_org_id, p_role_id)` - which deletes the
owner clause and leaves the subset rule - fails EXACTLY TWO tests: "refuses an
administrator the owner role, and allows a real owner" and "refuses an invitation for
the owner role whose inviter is not an owner", both with "expected a failure matching
... but the statement succeeded", which IS the escalation succeeding. The function was
restored byte-for-byte: `md5(prosrc)` is back to
`4a1f397ab625e129670c2de99a77eaf0`.

### THE GAPS

- **A CLAIM IS NOT A PROVEN ADDRESS.** The acceptance compared the invitation's
  address with `auth.jwt() ->> 'email'`, which is AUTHENTIC but not CONFIRMED - and
  `app/(auth)/signup/actions.ts` signs a user in immediately when "Confirm email" is
  off, which it is here. So anybody could register the invited address and redeem.
  The acceptance now also asks the ACCOUNT's own row - `auth.users.email_confirmed_at
is not null` and `auth.users.email = the invitation's address` - and FAILS CLOSED.
  The claim check stays, because it binds the SESSION to the invitation; the account
  check binds the ACCOUNT. The E2E probe account is now confirmed EXPLICITLY through
  the admin API, and the invitation spec passing is the proof that it is confirmed.
- **CURRENCY AND LOCALE ARE ASSERTED NOW.** The creation function applies them after
  the tenant exists, and nothing read them back, so dropping the UPDATE left the
  suite green. `tests/integration/onboarding-rpc.test.ts` calls the public RPC with
  `p_currency`/`p_locale` and reads `organizations.currency` and
  `organizations.locale` back.
- **A SUSPENDED MEMBER'S REDEMPTION NO LONGER BURNS THE TOKEN.** The acceptance
  reused any membership row and did not reactivate it, so a suspended member's
  redemption created an inert assignment, set `accepted_at`, and left the membership
  suspended: the invitation was spent and the member still locked out. The acceptance
  now refuses a membership that is not `active`, and it refuses BEFORE the acceptance
  stamp - so the invitation is still redeemable once the membership is active again.
  It does not quietly reactivate a suspended member either.

### THE NITS

- **THE CREATION CAP HAS ITS OWN SQLSTATE.** The onboarding action mapped `23514` -
  `check_violation`, a CLASS shared with every other check violation - to "you have
  created five clinics in the last day". The cap now raises `53400`,
  `configuration_limit_exceeded`, and its rule lives in
  `private.creation_cap_reached()`, so the rule and the code that reports it are in
  one place. `23514` still has a mapping, and it is honest about being a class.
- **A CONCURRENT ACCEPTANCE LOSES CLEANLY.** The membership insert's unique
  violation is caught inside the function and turned into the same refusal as a used
  invitation; the action maps `23505` as a backstop.
- **`invitations.accepted_at` IS NO LONGER WRITABLE.** It was, so a staff manager
  could clear it and re-issue a redeemed invitation - and the raw token is the
  credential. The UPDATE policy now refuses any change to an accepted invitation. The
  decision: one invitation means one membership, and a redeemed invitation is spent.
- **`private.current_org_ids` IS NO LONGER A THIRD COPY OF THE MEMBERSHIP RULE.** It
  asks `private.is_member_for` for each organization, so the set version and the
  boolean version cannot disagree.

### A REGRESSION THE SUITE CAUGHT, AND THE LESSON

`01780` wrote the assignment policies out from the version in `01240`, which is NOT
the version that was effective: `01660` had recreated them with
`private.assignment_target_is_member(organization_id, user_id)` - the closure of gap
A3, which stops an assignment being pre-staged for an account that belongs to no
organization. `01780` dropped it, and the suite caught it immediately: "A3: an
assignment cannot be pre-staged for a user in no organization" failed with "expected a
failure matching /row-level security|violates/ but the statement succeeded" - the
policy had become PERMISSIVE, which is the direction that matters. The correction is
`20261014001810`.

The lesson, and it is general: **before recreating a policy, read the LAST definition
of it, not an earlier one.** A policy recreated from an old file is not the policy
that was running, and the difference is silent.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test` (842), `npm run build` and
`npm run format:check` all exit 0. The E2E suite passes on chromium (12). The live
project after the runs: 0 organizations, 0 audit logs, 0 auth users, 0 unconfirmed
users, 0 invitations, 0 memberships, 0 assignments, 0 clinics, 1 role, and the
`tenant_creation_events` ledger back at its 29 pre-existing rows.

## Task 17 — Marketing shell and platform-admin gate

Branch: `feature/foundation`

### WHAT WAS BUILT

- `app/(marketing)/layout.tsx`, `app/(marketing)/page.tsx` and
  `components/marketing/{site-header,hero,feature-highlights,site-footer}.tsx` — the
  public shell. The root `app/page.tsx` was DELETED, because a route group is pathless
  and `app/(marketing)/page.tsx` serves `/`: two pages serving one url is a build
  conflict, not two routes. The root layout stays where it is — a route group cannot
  have a root layout.
- `app/platform/layout.tsx` and `app/platform/page.tsx` — the operator console, at a
  REAL segment `/platform`, not `app/(platform)/`. A pathless group would serve `/`
  and collide with the marketing root.
- `lib/auth/platform.ts` — the console's data access. It asks the DATABASE for the
  predicate and refuses to read the directory for an unauthorised caller.
- `supabase/migrations/20261014001850_platform_console.sql` —
  `public.is_platform_admin()` and `public.tenant_directory()`. Applied through the
  Composio MCP; the history now has 58 rows.
- `tests/e2e/platform-gate.spec.ts` (the plan names one spec file, so it covers both
  routes) and `tests/integration/platform-console.test.ts`.

### THE RULINGS, AND WHY

- **THE GATE IS ASKED OF THE DATABASE, NOT OF THE APPLICATION.**
  `private.is_platform_admin()` owns the rule, and PostgREST serves the `public` schema
  only — MEASURED: a POST to `/rest/v1/rpc/<fn>` naming a `private.*` function answers
  PGRST202 naming `public` as the schema it searched. The console's gate could not be
  evaluated at all until `20261014001850` added the wrapper. The alternative — reading
  `profiles.is_platform_admin` in TypeScript — would put the rule in two places, which
  is how the platform-key clause and the grant ceiling each drifted once.
- **THE GATE IS CHECKED TWICE, AND THE DATA-LAYER CHECK IS THE ONE THAT MATTERS.** The
  layout's `notFound()` produces the 404 response; the page's data access refuses to
  read the directory. Next.js's authentication guide is the reason: a layout does not
  control whether the rest of the route renders, and it does not re-render on
  client-side navigation.
- **THE DIRECTORY IS THREE COLUMNS, AND THE COUNT IS TAKEN BY A DEFINER.** The brief
  names organization names, statuses and member counts, and the function returns exactly
  those — so "no patient data is reachable from this route" is a property of the
  function's SIGNATURE. MEASURED: a platform administrator reads ZERO membership rows
  for a tenant with one member, because `organization_memberships_select` filters on
  `private.is_member(organization_id)` and the operator belongs to no tenant — while
  `public.tenant_directory()` reports that member as 1. A count taken from an ordinary
  read would be zero for every tenant.
- **THE CONSOLE ANSWERS 404, NOT A REDIRECT**, so the existence of the console is not
  disclosed to a clinic owner. `notFound()` also makes Next emit a `noindex` tag, and
  the layout's metadata says `robots: { index: false }`.
- **THE MARKETING PAGE READS NOTHING.** No session read anywhere in the group: a
  header that changed for a signed-in visitor would disclose that somebody is signed
  in. The E2E asserts it.
- **THE COPY MAKES NO CLAIM THAT HAS NOT BEEN VERIFIED.** No testimonials, no customer
  counts, no uptime, no certification — and no mention of patient records, appointments
  or payments, because none of those exist in this release. Full copy and the page set
  are Phase 4; the footer says the release is the foundation.

### THE MEASUREMENTS

- The two new public functions: `prosecdef = true`, `proconfig = {search_path=""}"`,
  `has_function_privilege('authenticated') = true`, and `anon` and `public` both
  false. Read back from `pg_proc` after the apply — the apply response body was not
  trusted.
- A platform administrator reads 0 membership rows and 1 organization, and
  `public.tenant_directory()` returns the tenant with `member_count = 1`. The same
  principal, not promoted, gets 0 rows from the directory and `is_platform_admin() =
false`.
- `types/database.types.ts` was regenerated with `SUPABASE_GENERATE_TYPESCRIPT_TYPES`,
  prettier-formatted, and compared with the generator's raw output after stripping
  whitespace, semicolons and union pipes: the normalised lengths and hashes now agree
  (13815 characters, hash 1113706187). They did NOT agree before the regeneration - the
  committed file was **307** characters shorter after normalisation (MEASURED: 13508
  before, 13815 after, of which 129 are the two new RPC entries and 178 the generator's
  changed helper shape), because the generator's `Tables<>` helper
  has an extra fallback branch, its `Enums<>` is keyed on `Enums` alone rather than on
  `Enums & CompositeTypes`, and `clinics.Insert.timezone` is now REQUIRED (migration
  `01670` made the column NOT NULL and the committed file predated it). The earlier
  "the two files hash to the same value" record was true when it was measured and is
  false now; the file has been regenerated so that it is true again. The app uses none
  of the changed helpers, so nothing broke - but the diff is real and is not
  formatting.
- The E2E spec: a clinic owner receives 404 from `/platform` with no table and no
  tenant name on the page, and a platform administrator sees the tenant, its status
  and the member count of 1 — for a tenant the operator does not belong to.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` and
`npm run format:check` all exit 0. The E2E suite passes on chromium and firefox — 32
tests, 0 failures. The live project after the runs: 0 organizations, 0 audit logs, 0
auth users, 0 invitations, 0 memberships, 0 assignments, 0 clinics, 1 role (the platform
role), and the `tenant_creation_events` ledger at **0** — see the correction below.

### THE CORRECTIONS, AND THE STATE I CHANGED

- **THE `tenant_creation_events` LEDGER IS NOW EMPTY, AND THAT IS A CHANGE THIS TASK
  MADE.** The ledger holds one row per tenant creation, it has NO foreign key, and
  every row in it belonged to an account that no longer exists - MEASURED: all 30 rows
  were orphans. Removing the two organizations a FAILED E2E run had left behind meant
  removing the ledger rows for their accounts - and **the 30-orphan purge was a MANUAL
  one-off, not the test helper's doing**: `tests/helpers/e2e-cleanup.ts` deletes ledger
  rows BY `user_id`, for the accounts the probe created, so it cannot remove an orphan
  of any other account. The manual purge removed every orphan row rather than only the
  two that were this task's, so the 29 rows that predate this task are gone too.
  Nothing live was lost (an orphan row cannot count against any living account's
  creation cap), but the earlier "the ledger holds 29 rows" record is no longer true
  and is corrected here.
- **THE ONBOARDING SPEC HAD A LATENT CROSS-TEST NAME COLLISION, AND THIS TASK'S SPEC
  FILE EXPOSED IT.** Both tests in `tests/e2e/onboarding.spec.ts` created an
  organization called "Probe Onboarding Clinic", and the suite runs its files in
  parallel — so the test that asserts "no organization with that name was created"
  could see its NEIGHBOUR's. The collision was invisible while the file was the only
  one of its kind; adding a third spec file changed the worker schedule and made it
  fire. Fixed by giving the second test its own name. A spec whose assertion depends
  on a GLOBAL name is a spec that depends on the schedule.
- **A FAILED E2E RUN CAN LEAVE AN ORGANIZATION BEHIND, AND THE CLEANUP THEN REFUSES
  TO DELETE IT.** MEASURED: when the create action was still in flight when the
  assertion timed out, the cleanup deleted the assignments and the action's own
  assignment landed afterwards — so the cascade delete of the organization hit
  `private.guard_role_delete` (the role was in use again) and the organization
  survived. The cleanup's own verification caught it ("cleanup left 1 organization(s)
  with the slug ..."), which is that helper working as designed. The two leftovers
  were removed by hand.

## Task 17 review round 1 — the data-layer refusal, the other tenant, and three false records

The review found no blocker and left two gaps and three false records. All are closed.

### GAP 1 — THE DATA-LAYER REFUSAL WAS UNASSERTED, AND IT IS NOW

`readTenantDirectory` is the check AGENTS.md calls "the data-layer one — the one that
matters", and nothing imported it. With its refusal line deleted, it would have
returned the directory to anybody, and EVERY test would still have passed: the
integration suite proves the SQL refuses, and the E2E proves the route 404s — but the
route never reaches the page for an unauthorised caller, so the page's own refusal was
never exercised.

`tests/unit/platform-console.test.ts` closes it. It imports `lib/auth/platform.ts`
through the `server-only` alias `vitest.config.ts` already provides, stubs
`lib/supabase/server`, and asserts:

- the predicate false → `readTenantDirectory()` resolves to null;
- the predicate false → the `tenant_directory` RPC is **never called**, and the only
  call made was `is_platform_admin`. The refusal is BEFORE the read, and a directory
  that was fetched and then discarded has still left the server;
- the predicate true → the rows, with `member_count` mapped to `memberCount`;
- the RPC errors → null. **A FAILED READ NOW FAILS CLOSED**: `lib/auth/platform.ts`
  returned `null` instead of throwing, because half a directory is worse than none —
  the caller cannot tell a truncated answer from a whole one;
- the predicate cannot be asked → null, and the directory is not read.

**MEASURED, THE MUTATION.** Deleting the single line
`if (!(await isPlatformAdmin())) return null;` fails **THREE of the five tests**, with
`expected [ { name: 'A tenant', …(2) } ] to be null` and
`expected [ 'tenant_directory' ] to not include 'tenant_directory'`. The file was
restored byte-for-byte: md5 `0CDA749F5DC889D5C6913BF704A485B1` before and after.

### GAP 2 — THE OTHER TENANT, AND THE RPC SURFACE

- `tests/e2e/platform-gate.spec.ts` now seeds a SECOND tenant the owner has no
  membership in ("Probe Foreign Tenant") and asserts that its name is absent from the
  refused page as well as the owner's own. Asserting only the caller's own tenant
  would have passed for a console that leaked every OTHER tenant and none of the
  caller's.
- `tests/integration/platform-console.test.ts` now calls `tenant_directory` over REAL
  HTTPS with a REAL signed-in user's JWT and asserts an empty directory. That is the
  path the E2E cannot reach: the interface never issues the call for an unauthorised
  caller, because the route has already 404'd. The impersonated transaction in the
  same file proves the FUNCTION refuses; the HTTP call proves the SURFACE does.

### THE THREE FALSE RECORDS, CORRECTED

- **"179 characters longer" WAS WRONG. IT IS 307.** MEASURED: the normalised length of
  `types/database.types.ts` went **13508 → 13815**, which is **307** characters — 129
  of them the two new RPC entries and 178 the generator's changed helper shape.
  Corrected in AGENTS.md and here.
- **"the cleanup removed every orphan row" WAS WRONG.** `tests/helpers/e2e-cleanup.ts`
  deletes ledger rows BY `user_id`, for the accounts the probe created, so it cannot
  remove an orphan of any other account. The 30-orphan purge was a MANUAL one-off.
  Corrected in AGENTS.md and here.
- **"the foreign keys between them are composite" WAS OVERSTATED.** MEASURED: of the
  21 public foreign keys, **5 are composite** — `clinic_memberships` → `clinics`,
  `clinic_memberships` → `organization_memberships`, `patient_identifiers` → `patients`,
  `patients` → `clinics` and `user_role_assignments` → `clinics`. The three ROLE
  references are single-column, and a role's organization scope is closed by
  `private.guard_role_org_scope()` — a TRIGGER — and by the policies, not by the
  schema. The marketing copy now says "the foreign keys that tie a row to another
  tenant's clinic or patient are composite", which is what the schema does.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` and
`npm run format:check` all exit 0. The E2E suite passes on chromium and firefox.

## Task 17 review round 2 — a positive control, three narrowed claims, two corrected records

The second review found no blocker and left three gaps and two nits. All are closed.

### GAP 1 — THE HTTPS ASSERTION HAD NO POSITIVE CONTROL

`tests/integration/platform-console.test.ts` asserted that `tenant_directory` answers
`[]` to a non-administrator over real HTTPS — and the live database held **0
organizations**, so an UNGUARDED function would have answered `[]` too. The assertion
proved the transport and not the refusal.

Three things fix it, and all three are needed:

1. **the predicate is asserted over the SAME token** — `public.is_platform_admin()` is
   `false` — a precondition that does not depend on the directory's contents;
2. **one organization is SEEDED through the service role and KEPT** for the assertion,
   so an empty directory means REFUSED rather than "there was nothing there";
3. **an ADMINISTRATOR'S TOKEN** — a second real account, promoted through the service
   role, because the flag is read from the PROFILE and not from the JWT, so the token
   issued before the promotion is the token used after it — **receives that row**, so
   the pair can only pass if the guard is what separates them.

**MEASURED, THE MUTATION.** The applied migration is never edited, so the mutation was
applied as a correction: `20261014001860_tenant_directory_unguarded_probe.sql` removes
the `where (select private.is_platform_admin())` clause, and
`20261014001870_tenant_directory_restore.sql` puts it back. With the probe applied,
**BOTH** assertions fail — the impersonated one and the HTTPS one:

```
AssertionError: expected [ { …(3) } ] to deeply equal []
+ Received
+ [ { "member_count": 0, "name": "Console HTTP Tenant", "status": "active" } ]
```

and the administrator's positive control still passes, which is what makes the pair a
pair. The function body was restored **byte-for-byte**: `md5(prosrc)` is
`5365ccdf74d4d73685c9afbd763d1bdf` before the probe (`7f711424161804d1115614ffebf8340f`
with it) and after the restore. Both files are in the migration history on purpose —
that history is the record of the measurement — and the window in which the function
was unguarded was the measurement itself, which is recorded here rather than glossed
over.

### GAP 2 — "EVERY TENANT-OWNED TABLE CARRIES ITS ORGANIZATION" IS NOT LITERALLY TRUE

MEASURED from `pg_attribute`: of the 16 public tables, **10 carry an `organization_id`
and 6 do not** — `organizations` is the tenant root, `permissions`,
`platform_settings` and `tenant_creation_events` are global, `profiles` is per-user,
and `role_permissions` hangs off a ROLE, which carries the organization. Two of the ten
that have the column have it NULLABLE: `audit_logs` (a platform event has no tenant)
and `roles` (a platform role belongs to no organization).

The copy now says **"every row of your clinic's own data is tied to the organization it
belongs to"** — a claim about ROWS, which is true, and not about columns, which is
not. It does not overstate in the other direction either: the composite-key claim is
still the narrow one (5 of 21 public foreign keys are composite; the three role
references are single-column and a role's organization scope is closed by
`private.guard_role_org_scope()`, a trigger, and by the policies).

### GAP 3 — TWO OLDER RECORDS IN `AGENTS.md` WERE FALSE

Both are corrected **in place**, in the Task 13+ section that carried them, and each
names the correction and its date:

- **"An organization that has roles cannot be deleted … every org the product creates is
  undeletable"** was true before `20261014001670` and is false now. That migration
  (applied **2026-10-20**) made `private.guard_role_delete` return early when the
  role's organization no longer exists — the cascade of an organization's deletion
  rather than a deliberate attempt to delete a role that is still in use. A DELIBERATE
  role delete that still holds grants or assignments is still refused. And
  `public.delete_organization(p_org_id)` — added by `20261014001692` on the same day,
  requiring `settings.manage` in that organization — is the product-level remedy the
  old record said did not exist.
- **"`clinics.timezone` is still nullable"** is false: the column is `NOT NULL` since
  `20261014001670`, and a BEFORE INSERT trigger (`private.default_clinic_timezone()`)
  fills it from the organization's own zone, because a column default cannot express
  that zone.

### THE TWO NITS

- **THE HERO NO LONGER CONTRADICTS ITSELF.** It said "Inside it are your clinics, your
  staff and the roles they hold" — and the product creates exactly ONE clinic per
  organization, and the roster shows a member's identifier and nothing else
  (`profiles` is readable only by its owner). It now says "the people you have given
  access to, and the roles they hold", which is what a membership is.
- **THE CONSOLE'S MEMBER COLUMN IS LABELLED, NOT NARROWED.** The count is of
  membership ROWS in any state, so a suspended member is counted. The column header
  now reads "Members (any status)" and the table caption says what the number counts.
  The alternative — counting only active memberships — would have made the console
  report a smaller number than the tenant has, which is a product decision about
  somebody else's staff, and this console is a directory rather than a tenant's
  roster.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` and
`npm run format:check` all exit 0. The E2E suite passes on chromium and firefox. The
live project after the runs: 0 organizations, 0 audit logs, 0 auth users, 0 invitations,
0 memberships, 0 assignments, 0 clinics, 1 role, and 60 migration history rows.

### THE LIMITATIONS

- The console shows a DIRECTORY and nothing else: no tenant can be suspended,
  restored or deleted from it, and `public.delete_organization` is the only destructive
  path in the schema (and it refuses an organization that still has roles). The
  platform's write actions are later work.
- The marketing page set is one page. Features, pricing, security, legal and SEO are
  Phase 4, and the footer says so rather than linking to pages that would answer 404.
- The member count is of membership ROWS in any state, so a suspended membership is
  counted. Splitting it would mean deciding what a platform operator should see about a
  tenant's internal staff state, which is a product decision, not a bug.

## Task 16 - the third review: the inviter is the caller, the helpers' privileges, and the shell's fourth state

The third Task 16 review found NO BLOCKER - Task 16 is judged done - and left five gaps
and some false records.

### THE GAPS, AND WHAT EACH ONE WAS

**1. THE CEILING'S SUBJECT WAS A COLUMN THE CALLER SUPPLIED.**
`private.accept_invitation` judges the grant ceiling for `invited_by`, and nothing
constrained that column, so the SUBJECT of the ceiling was attacker-chosen. No
escalation was found - the `role_id` is still bounded by the CALLER's own ceiling at
write time, and widening a role's permissions needs `settings.manage` - but two
ceilings that can diverge is not a thing to leave in place: if a role's permissions
change between the write and the redemption, the ceiling judged for the wrong subject
is the ceiling that decides. `20261014001820` adds
`and invited_by = (select auth.uid())` to both invitations policies.

**2. `private.assignment_target_is_member` WAS EXECUTE-able BY PUBLIC AND ANON.**
MEASURED live before the fix: `anon_exec=true, pub_exec=true`. It answers "is user X an
active member of organization Y" - the exact shape that was ruled unreachable when the
`*_for` helpers were revoked - and it is a SECURITY DEFINER, so it reads the
memberships table as postgres. What contained it was `db_schemas = public`, which is
a CONFIGURATION SETTING and not a boundary. `20261014001830` revokes it from PUBLIC and
ANON and grants it to `authenticated` explicitly: it is called by two policies, and a
policy's expression is evaluated as the QUERYING role, so revoking it from
`authenticated` would make every assignment write INVISIBLE rather than denied.

**3. THE `POLICY_REFERENCED` INVENTORY WAS STALE IN BOTH DIRECTIONS.** It still
listed `can_grant` after `20261014001780` stopped calling it, and it omitted
`assignment_target_is_member` although two policies have called it since
`20261014001810`. So the EXECUTE of either could have been revoked and every
assignment or invitation write would have become invisible with no test failing. The
catalogue test now DERIVES the set from `pg_policies` and compares it with the list in
both directions, and a new test pins the private helpers' EXECUTE to exactly the roles
that need it.

**4. THE MEMBERSHIP RULE STILL HAD A SECOND COPY.** `private.clinic_ids` re-derived
"an active membership in an active organization" in its `mine` CTE while
`private.is_member_for` owns exactly that rule - and the unit assertion PINNED the
duplicate, so the test enforced the duplication. `20261014001840` makes `clinic_ids`
ask `is_member_for`, and the unit assertion now pins the delegation and asserts that
none of `is_member`, `current_org_ids` and `clinic_ids` re-derives the rule.

**5. THE SHELL'S STATES WERE NOT WHAT THE RECORD SAID.**
`organization_memberships_select`'s USING is `private.is_member(organization_id)`,
which requires an ACTIVE membership in an ACTIVE organization. So a member of a
suspended tenant - and a member whose own membership is suspended - see NO membership
rows at all, and `listMemberOrgs` returned an empty list for them. The shell read the
empty list as "you belong to nothing" and rendered the ONBOARDING screen, so a member
of a suspended tenant was being OFFERED THE CREATION OF A SECOND TENANT.

`public.has_any_membership()` now answers the question RLS cannot - does the CALLER
have any membership row at all, in any state - and it answers about the caller only,
so it is not an oracle about anybody else. The shell has four states it can now tell
apart: no membership (onboarding), memberships but all hidden ("your access is not
active"), several active memberships with no choice (the picker), and an active
organization (the shell).

### THE NITS, AND THE FALSE RECORDS

- **`private.can_grant` HAS NO CALLERS, AND ITS EXECUTE IS REVOKED.** Since
  `20261014001780` every policy that grants a role calls `can_assign_role`, which is
  the subset rule AND the owner-only clause. `can_grant` is the SUBSET rule alone - the
  looser half - and it was executable by every signed-in role: a trap, because the next
  policy to call it would enforce half the ceiling, which is exactly the hole the
  first review found. `20261014001830` revokes it from `authenticated` too, and the
  catalogue test pins that.
- **THE CAP'S SQLSTATE CORRECTION.** The round-1 record said the cap is `23514`. It is
  `53400` (`configuration_limit_exceeded`) since `20261014001800`; `23514` is
  `check_violation`, a CLASS shared with every other check violation, and mapping it
  would have reported all of them as the cap.
- **THE MEMBERSHIP RULE'S HOME, CORRECTED.** The round-2 record said the membership
  rule lives in `is_member_for`. It did not - `clinic_ids` still re-derived it - and it
  does now.
- **THE SHELL'S STATES, CORRECTED.** The "Task 16+" record said a member with a
  membership but no active organization sees the PICKER. They saw the ONBOARDING
  screen, because their membership row was hidden by RLS; they now see "your access is
  not active".
- **LOGIN CARRIES NO `next`, AND THAT IS A KNOWN LIMITATION.** The sign-in action
  always redirects to `/app/dashboard`, so an invited user with no organization lands
  on the onboarding screen and has NO ROUTE BACK to the pending invitation. The
  invitation link still works - it is a capability and the invitee opens it directly -
  but the product does not carry the user from the sign-in page to it.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` and
`npm run format:check` all exit 0. The E2E suite passes on chromium, including the new
"suspended member is not offered a new organization" case. The live project after the
runs: 0 organizations, 0 audit logs, 0 auth users, 0 invitations, 0 memberships, 0
assignments, 0 clinics, 1 role, and the `tenant_creation_events` ledger back at its 29
pre-existing rows.

## Task 18 - the mutation-verified two-organization tenant isolation suite

`tests/security/tenant-isolation.test.ts` (18 tests), `tests/security/fixtures.ts` and
`tests/security/mutation-harness.ts`. Two tenants are created through the product's own
signup and `create_organization_with_owner` paths, each measured through its own signed-in
client; the mutation half impersonates the same principals on a direct connection inside
transactions that always roll back.

### WHAT THE FIRST FULL GATE RUN FOUND - A GENUINE DATABASE DEFECT

The first complete `npm run test` of this task failed SEVEN tests in THREE OTHER suites
(`tests/security/rls-policies.test.ts` x2, `tests/integration/authorization-gaps.test.ts`
x2, `tests/integration/public-rpc.test.ts` x3). All seven traced to ONE cause, and it was
not the suite: **the live database had lost the `organizations_update` policy.**

- MEASURED: `20261014001220_privilege_gates.sql` IS in the applied history and creates
  the policy; no later migration drops it; the catalogue test asserts it - yet
  `pg_policies` carried only `organizations_select` on the table, 38 public policies
  against the asserted 39.
- With an UPDATE policy ABSENT, RLS default-denies the command for EVERYONE: zero rows,
  no error. That is why the tenant-settings PATCH returned 204 instead of the timezone
  guard's 400 (the trigger never fired - no row was reached), why "a platform
  administrator CAN suspend and restore a tenant" read 0 rows, and why the
  permitted-settings-write positive control read empty.
- Nothing in this task's work commits policy DDL - every mutation runs inside a
  rolled-back transaction, and the first catalogue probe of the session (before any
  suite ran) already showed the policy missing. When it disappeared is not determinable;
  there is no DDL audit trail.
- The correction is `20261014001880_organizations_update_restoration.sql` - 01220's
  definition verbatim - applied through the Composio applier (one apply per call) and
  verified against the catalogue (`organizations_update [UPDATE]`, 39 public policies)
  and the history (61 rows, the file named exactly once, no duplicates). All seven
  failures cleared, and the lesson is recorded in `AGENTS.md`: an applied migration is
  not proof the object exists - the catalogue is.

### THE RULINGS THAT SHAPED THE SUITE

- UPDATE and DELETE under RLS pass the SELECT policy's qual too - MEASURED with
  `EXPLAIN`: the UPDATE's row scan carried `patients_select`'s filter, and the
  cross-tenant update touched rows only once the SELECT policy was loosened as well.
  The write mutations therefore loosen the SELECT and the command policy together, and
  the honest claim is that the cross-tenant write is refused as long as EITHER holds.
- Refusals are mutated by LOOSENING (a superset cannot regress the tenant's own write,
  and the assertion's own-row control proves the path still works); the SELECT policies
  are mutated by DROPPING, per the plan's literal instruction, and break through the
  positive control that A still sees its own rows.
- The cross-tenant role grant is refused by TWO layers - the RLS with-check and the
  `guard_role_org_scope` BEFORE trigger, which fires first (the shipped refusal carries
  the trigger's message). Its mutation loosens the policy AND disables the trigger in
  one `withMutation`; the break is the assignment being written for real.
- `roles_delete` is excluded from delete-mutation verification as a RECORDED LIMIT:
  `private.role_in_use` counts permission grants, so every seeded role is "in use" and
  the trigger refuses it for its own tenant as much as for a stranger.
- `role_permissions` has no `organization_id` column; the suite asks whether each
  visible row's ROLE is one of A's own - the join the policies themselves use.
- The membership SELECT policy shows the organization's whole directory to any member,
  so the uniqueness test counts the newcomer's own rows, not the table.
- `tenant_directory()` returns the organization's NAME, not its slug (MEASURED from
  `pg_get_functiondef`); the platform-console control asserts names.
- `fileParallelism: false` in `vitest.config.ts`: the suite's policy DDL takes
  AccessExclusiveLocks that a concurrent catalogue reader can block on, and the DB-backed
  suites' cost is round trips, so serial files cost little and remove the interference.
- The mutation ledger is pinned in-suite (38 rows after review round 3; 33 at
  implementation) and written to the OS temp dir as
  `tenant-isolation-mutation-report.txt`, because vitest 5 swallows afterAll console
  output on green runs.

### THE MUTATION-VERIFICATION REPORT

Every entry is one mutation: applied, PROVED applied from `pg_policies`/`pg_constraint`/
`pg_proc`/`pg_trigger`, run against the isolation assertion, observed to FAIL it, restored,
and observed to PASS again. Recorded verbatim from the IMPLEMENTATION run - 33 mutations,
before review round 1 changed several assertion messages and round 3 added five INSERT
mutations. The in-suite pin now reads 38; the five additions are named in the
review-round-3 section, and each one was measured breaking with its pinned matcher.

dropping patients_select breaks the "patients" isolation assertion
catalogue: dropped policy patients_select on public.patients
broke with: patients: A must see its own rows: expected 0 to be greater than 0
dropping patient_identifiers_select breaks the "patient_identifiers" isolation assertion
catalogue: dropped policy patient_identifiers_select on public.patient_identifiers
broke with: patient_identifiers: A must see its own rows: expected 0 to be greater than 0
dropping clinics_select breaks the "clinics" isolation assertion
catalogue: dropped policy clinics_select on public.clinics
broke with: clinics: A must see its own rows: expected 0 to be greater than 0
dropping clinic_memberships_select breaks the "clinic_memberships" isolation assertion
catalogue: dropped policy clinic_memberships_select on public.clinic_memberships
broke with: clinic_memberships: A must see its own rows: expected 0 to be greater than 0
dropping organization_memberships_select breaks the "organization_memberships" isolation assertion
catalogue: dropped policy organization_memberships_select on public.organization_memberships
broke with: organization_memberships: A must see its own rows: expected 0 to be greater than 0
dropping roles_select breaks the "roles" isolation assertion
catalogue: dropped policy roles_select on public.roles
broke with: roles: A must see its own rows: expected 0 to be greater than 0
dropping role_permissions_select breaks the "role_permissions" isolation assertion
catalogue: dropped policy role_permissions_select on public.role_permissions
broke with: role_permissions: A must see its own rows: expected 0 to be greater than 0
dropping user_role_assignments_select breaks the "user_role_assignments" isolation assertion
catalogue: dropped policy user_role_assignments_select on public.user_role_assignments
broke with: user_role_assignments: A must see its own rows: expected 0 to be greater than 0
dropping invitations_select breaks the "invitations" isolation assertion
catalogue: dropped policy invitations_select on public.invitations
broke with: invitations: A must see its own rows: expected 0 to be greater than 0
dropping audit_logs_select breaks the "audit_logs" isolation assertion
catalogue: dropped policy audit_logs_select on public.audit_logs
broke with: audit_logs: A must see its own rows: expected 0 to be greater than 0
dropping organizations_select breaks the "organizations" isolation assertion
catalogue: dropped policy organizations_select on public.organizations
broke with: organizations: A must see its own rows: expected 0 to be greater than 0
loosening patients_select to `using (true)` leaks tenant B's patients
catalogue: loosened policy patients_select on public.patients to using (true)
broke with: tenant B's patient must not be visible: expected [ 'CROSS-TENANT-CONTROL', â€¦(2) ] to not include 'ISO-B-1'
loosening patients_select and patients_update lets a cross-tenant update through
catalogue: loosened policy patients_select on public.patients to using (true); loosened policy patients_update on public.patients to using (true)
broke with: patients: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening patient_identifiers_select and patient_identifiers_update lets a cross-tenant update through
catalogue: loosened policy patient_identifiers_select on public.patient_identifiers to using (true); loosened policy patient_identifiers_update on public.patient_identifiers to using (true)
broke with: patient_identifiers: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening clinics_select and clinics_update lets a cross-tenant update through
catalogue: loosened policy clinics_select on public.clinics to using (true); loosened policy clinics_update on public.clinics to using (true)
broke with: clinics: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening clinic_memberships_select and clinic_memberships_update lets a cross-tenant update through
catalogue: loosened policy clinic_memberships_select on public.clinic_memberships to using (true); loosened policy clinic_memberships_update on public.clinic_memberships to using (true)
broke with: clinic_memberships: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening organization_memberships_select and organization_memberships_update lets a cross-tenant update through
catalogue: loosened policy organization_memberships_select on public.organization_memberships to using (true); loosened policy organization_memberships_update on public.organization_memberships to using (true)
broke with: organization_memberships: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening roles_select and roles_update lets a cross-tenant update through
catalogue: loosened policy roles_select on public.roles to using (true); loosened policy roles_update on public.roles to using (true)
broke with: roles: a cross-tenant update must touch nothing: expected [ { touched: 1 }, â€¦(13) ] to deeply equal []
loosening user_role_assignments_select and user_role_assignments_update lets a cross-tenant update through
catalogue: loosened policy user_role_assignments_select on public.user_role_assignments to using (true); loosened policy user_role_assignments_update on public.user_role_assignments to using (true)
broke with: user_role_assignments: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening invitations_select and invitations_update lets a cross-tenant update through
catalogue: loosened policy invitations_select on public.invitations to using (true); loosened policy invitations_update on public.invitations to using (true)
broke with: invitations: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening role_permissions_select and role_permissions_update lets a cross-tenant update through
catalogue: loosened policy role_permissions_select on public.role_permissions to using (true); loosened policy role_permissions_update on public.role_permissions to using (true)
broke with: role_permissions: a cross-tenant update must touch nothing: expected [ { touched: 1 }, â€¦(16) ] to deeply equal []
loosening organizations_select and organizations_update lets a cross-tenant update through
catalogue: loosened policy organizations_select on public.organizations to using (true); loosened policy organizations_update on public.organizations to using (true)
broke with: organizations: a cross-tenant update must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening patients_select and patients_delete lets a cross-tenant delete reach tenant B's patients row
catalogue: loosened policy patients_select on public.patients to using (true); loosened policy patients_delete on public.patients to using (true)
broke with: update or delete on table "patients" violates foreign key constraint "patient_identifiers_patient_fkey" on table "patient_identifiers"
loosening patient_identifiers_select and patient_identifiers_delete lets a cross-tenant delete reach tenant B's patient_identifiers row
catalogue: loosened policy patient_identifiers_select on public.patient_identifiers to using (true); loosened policy patient_identifiers_delete on public.patient_identifiers to using (true)
broke with: patient_identifiers: a cross-tenant delete must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening clinic_memberships_select and clinic_memberships_delete lets a cross-tenant delete reach tenant B's clinic_memberships row
catalogue: loosened policy clinic_memberships_select on public.clinic_memberships to using (true); loosened policy clinic_memberships_delete on public.clinic_memberships to using (true)
broke with: clinic_memberships: a cross-tenant delete must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening user_role_assignments_select and user_role_assignments_delete lets a cross-tenant delete reach tenant B's user_role_assignments row
catalogue: loosened policy user_role_assignments_select on public.user_role_assignments to using (true); loosened policy user_role_assignments_delete on public.user_role_assignments to using (true)
broke with: user_role_assignments: a cross-tenant delete must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening invitations_select and invitations_delete lets a cross-tenant delete reach tenant B's invitations row
catalogue: loosened policy invitations_select on public.invitations to using (true); loosened policy invitations_delete on public.invitations to using (true)
broke with: invitations: a cross-tenant delete must touch nothing: expected [ { touched: 1 } ] to deeply equal []
loosening role_permissions_select and role_permissions_delete lets a cross-tenant delete reach tenant B's role_permissions row
catalogue: loosened policy role_permissions_select on public.role_permissions to using (true); loosened policy role_permissions_delete on public.role_permissions to using (true)
broke with: role_permissions: a cross-tenant delete must touch nothing: expected [ { touched: 1 }, â€¦(16) ] to deeply equal []
loosening patients_write exposes the composite foreign key as the second layer
catalogue: loosened policy patients_write on public.patients to with check (true)
broke with: expected a failure matching /row-level security/i, got: insert or update on table "patients" violates foreign key constraint "patients_clinic_fkey"
loosening the write policy AND disabling the guard lets a cross-tenant role be granted
catalogue: loosened policy user_role_assignments_write on public.user_role_assignments to with check (true); disabled trigger guard_role_org_scope on public.user_role_assignments
broke with: expected a failure matching /row-level security|belongs to another organization/i but the statement succeeded
removing the platform guard from tenant_directory hands tenant A the console
catalogue: replaced public.tenant_directory
broke with: tenant A must not reach the platform directory: expected [ { â€¦(3) }, { â€¦(3) } ] to deeply equal []
dropping patient_documents_select takes A's own objects away too
catalogue: dropped policy patient_documents_select on storage.objects
broke with: A must still see its own object: expected [] to have a length of 1 but got +0
narrowing organization_memberships_organization_id_user_id_key to user_id alone makes two organizations impossible
catalogue: narrowed organization_memberships_organization_id_user_id_key to (user_id)
broke with: duplicate key value violates unique constraint "organization_memberships_organization_id_user_id_key"

### THE RESIDUE

The interrupted runs and this task's first two failed runs left six isolation tenants,
six accounts, six storage objects and their audit and ledger rows behind, because the
fixture's cleanup died at its FIRST statement (a multi-command string through `pg`'s
prepared-statement path). All of it was removed and re-counted to zero. After the final
green full run the live project reads: 0 organizations, 0 patients, 0 clinics, 0
memberships, 0 invitations, 0 assignments, 0 audit logs, 0 creation-ledger rows, 0 auth
users, 0 storage objects, 1 role (the platform role) - the pristine state.

### THE GATES

`npm run typecheck` exit 0. `npm run lint` exit 0 (eslint 0 errors - one pre-existing
warning in `.opencode/plugins/graphify.js`; `check:secrets OK`; `format:check` clean;
`migrations:check` OK, 61 files). `npm run test` exit 0 - 39 files, 896 tests, including
the new suite's 18. `npm run build` exit 0 after one retry past Next.js's
security-advisory nudge (the nudge halts the first build after a successful compile; the
recommendation to upgrade Next.js is reported and NOT acted on - the toolchain pins are
deliberate, see the Task 5 entry). `npm run format:check` exit 0.

### THE LIMITATIONS

- The mutation half does not cover a cross-tenant DELETE on `roles` (the trigger refuses
  every seeded role for everyone) and there is no `organizations` delete policy to
  mutate; both refusals are still asserted in the client half.
- The invitation and storage paths keep their previously recorded residuals (the token
  in the URL; no delivery mechanism) - unchanged by this task.
- The suite takes ~115s alone and roughly doubles `npm run test`'s DB-backed half; the
  cost is round trips to the live pooler, and the serialisation ruling is recorded above.

## Task 18, review round 1 - the authorised twins, the half-finished seed, and the pinned breaks

The first review found no blocker; it left three gaps and two nits. All five are closed.

### THE GAPS

- GAP 1, the delete twins. The shipped-state own-row delete control covered patients
  only, and the mutation-half delete bodies carried only the refusal half - so a deleted
  `invitations_delete` or `user_role_assignments_delete` was INVISIBLE: a missing policy
  and a refusing policy both yield zero rows with no error. Every cross-tenant delete
  refusal is now paired with a create-and-delete of the tenant's OWN row, per table,
  in BOTH halves - through PostgREST in the client half and, restated impersonated,
  inside each delete mutation's post-restore assertion. Two shapes are forced by
  MEASURED constraints: `clinic_memberships` has `UNIQUE (membership_id, clinic_id)`, so
  its control deletes the fixture's own row and re-creates it, and the assignment and
  permission controls create a FRESH role, because a permission row of a role the
  caller holds is refused by design (`NOT assigned_to_self`) and a duplicate org-wide
  assignment is refused by the `NULLS NOT DISTINCT` unique key.
- GAP 2, the half-finished seed. If `seedTwoOrganizations` throws after tenant A exists,
  `seeded` stays undefined and the `afterAll` cleans nothing - the exact leak Task 16
  recorded. `beforeAll` now catches, destroys the partial seed through the new
  `destroyPartialSeed()` (tenants rediscovered from the accounts the auth fixture
  registers in `createdProbeUserIds`, destroyed through the same shared path as a
  finished run), and rethrows with the cleanup's own outcome reported beside the cause.
- GAP 3, the four untested command/table pairs. `audit_logs` UPDATE, `audit_logs` DELETE,
  `organizations` DELETE and `organization_memberships` DELETE were stated in a comment
  ("the rest filter every delete") but never exercised. They are asserted now, one
  statement each plus an untouched re-read. MEASURED, they take two refusal shapes:
  `audit_logs` UPDATE and DELETE privileges are revoked from `authenticated` outright
  (`has_table_privilege` is false - permission denied, before any policy is consulted),
  while the two DELETEs without a policy are RLS default-deny: zero rows, no error.
  These commands are refused for EVERY tenant, so they have no authorised twin - the
  refusal itself is the design.

### THE NITS

- NIT 1, the pinned break. `brokeWith` accepted any throw, so a network blip or a
  statement timeout would have been ledgered as a verified break of a policy.
  `mutationBreaks` now REQUIRES a break-message matcher, recorded beside the break in
  the ledger (`must break: /.../`), and rejects an UNEXPECTED break - one that does not
  name the policy, constraint or control the mutation touched - after the restore.
  MEASURED: corrupting one matcher to an unmatchable regex fails exactly one test with
  "broke for an UNEXPECTED reason"; the guard is not decoration.
- NIT 2, the overstatement. The record said the mutation report is written "on every
  run"; it is written by the mutation describe's `afterAll`, and a run that dies before
  that point writes nothing. The record now says when it is written, and the in-suite
  ledger pin is named as the coverage for that case.

### THE LEDGER

Unchanged at 33 mutations - the review added controls and assertions, not mutations -
but every row now carries its required break beside the one it produced.

### THE GATES

`npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` and
`npm run format:check` all exit 0. The suite alone: 19 tests (18 before the review, plus
the four-command no-policy test), all passing in ~133s. The live project after the runs:
0 organizations, 0 audit logs, 0 auth users, 0 creation-ledger rows, 0 storage objects.

## Task 18, review round 2 - the fifth no-policy command, and the shapes pinned

The second review found no blocker. It found ONE gap and two nits, all closed in `e6b9d6e`.

- GAP: `clinics` DELETE is a FIFTH command/table pair that no policy covers, and the
  record said there were four. MEASURED: `clinics` carries only SELECT and UPDATE
  policies, and `has_table_privilege('authenticated','public.clinics','DELETE')` is true,
  so the cross-tenant delete is RLS default-deny - the statement succeeds and matches zero
  rows, no error. The suite never issued one, so "every table, every command" was 10/11.
- NIT: the refusal SHAPES were documented, not asserted - `refused` accepted either a
  raise or zero rows for all the pairs. They are now SPLIT: `audit_logs` UPDATE and DELETE
  must RAISE (permission denied), and `organizations`, `organization_memberships` and
  `clinics` DELETE must return ZERO ROWS.
- NIT: the grant-ceiling matcher stays loose, because its break IS the cross-tenant grant
  succeeding; the `AGENTS.md` claim that every matcher names the policy is softened to
  what is true - a matcher is REQUIRED for every mutation, but the message must be the
  thing that actually broke.
- The ledger stayed at 33: the round added assertions, not mutations.
- PROCESS GAP: `e6b9d6e` changed the suite and `AGENTS.md` but not this file or the SDD
  ledger, so the round-2 record is written here, in review round 3.

## Task 18, review round 3 - the INSERT half, the catalogue, and the teardown that could orphan a tenant

The third review found no blocker and closed seven gaps. The suite is 21 tests.

- GAP 1, the INSERT half of the no-policy rule. MEASURED live: `organizations`, `clinics`
  and `organization_memberships` have INSERT granted to `authenticated` and NO INSERT
  policy, and `audit_logs` has neither an INSERT policy nor the privilege. The no-policy
  test now asserts NINE command/table pairs in THREE shapes: permission denied for the
  three `audit_logs` writes; an RLS RAISE for the three policy-less INSERTs (an INSERT has
  no row to filter); RLS default-deny ZERO ROWS for the three policy-less DELETEs. The
  INSERT attempts use a FRESH organization id (B's id would break on the primary key under
  a permissive policy instead of landing), B's clinic, and a membership for `userA` in B;
  the service role re-reads that nothing landed. The `organizations` case is the strong
  one: a permissive policy would let a tenant create a tenant through the table door.
- GAP 2, the client INSERT refusals were missing entirely. Five tables carry a write
  policy (`patient_identifiers`, `clinic_memberships`, `roles`, `role_permissions`,
  `invitations`) and each now has a cross-tenant refusal with an authorised twin. The
  `clinic_memberships` twin is the fixture's own row - `UNIQUE (membership_id, clinic_id)`
  leaves no second pair to insert - and the `role_permissions` twin grants a FRESH role,
  because a permission row of a role the caller holds is refused by design.
- GAP 3, five INSERT policies were never mutation-verified. `patient_identifiers_write`,
  `clinic_memberships_write`, `roles_write`, `role_permissions_write` and
  `invitations_write` are now loosened one at a time; `patients_write` and
  `user_role_assignments_write` are covered by the composite-key and ceiling mutations.
  The ledger is 38 (33 + 5). `clinic_memberships`' required break names the UNIQUE key,
  because with the with-check gone the insert REACHES the table - reaching it is the leak.
- GAP 4, the whole catalogue. The ledger test now reads `pg_policies` on the OUTER session
  after every mutation transaction has rolled back: 59 policies (39 public + 20 storage),
  `permissions_select` the ONE shipped-permissive, every other qual/with_check not `true`.
  The per-mutation restore proof covers only the policy that mutation touched; this covers
  the set.
- GAP 5, the teardown could orphan a tenant. The new last-net drained
  `createdProbeUserIds`, including `userA`/`userB`; if `destroyTwoOrganizations` failed,
  deleting those accounts would cascade their memberships but leave the ORGANIZATION (no
  owner column), and no later run could find it. The net now runs in `finally` and EXCLUDES
  the two seeded accounts; the destroy's own throw is the residue report.
- GAP 6, the cleanup's verification was one page deep. `deleteProbeUsers` checked
  `listUsers` ONCE (200 accounts), so a survivor beyond page 1 was reported deleted. It
  now walks at most 20 pages, stops on the first short page, and throws on a list error.
- GAP 7, two source-level overstatements. `UPDATABLE` and `UPDATE_MUTATIONS` were the same
  ten tables listed twice, so the refusal test and its mutation could drift; they are one
  list. The insert-mutation test claimed "every table with a write path" while covering
  five; it is renamed. The whole-catalogue comment claimed an outer-session re-read per
  mutation that does not exist; it now says what the read actually adds.
- MEASURED, the suite alone: 21 tests pass in 167s; the report holds 38 mutations, every
  one breaking with its pinned matcher. Residue after the run: 0 organizations, 0 auth
  users, 0 memberships, 0 clinics, 0 patients, 0 invitations, 0 assignments, 0 audit logs,
  0 creation-ledger rows, 0 storage objects, 1 role (the platform role).
- RECORDED LIMITS: the mutation half still cannot cover a `roles` DELETE (the trigger
  refuses every seeded role for its own tenant too) or a policy-less INSERT (there is no
  policy to loosen - those refusals are asserted in the client half only).

### THE GATES

`npm run typecheck`, `npm run lint` (eslint 0 errors - one pre-existing warning in
`.opencode/plugins/graphify.js`; `check:secrets OK`; `format:check` clean;
`migrations:check` 61 files), `npm run test` (39 files, 899 tests), `npm run build` and
`npm run format:check` all exit 0. The suite alone is 21 of those tests. The live project
after the runs reads 0 organizations, 0 auth users, 0 audit logs, 0 creation-ledger rows,
0 storage objects and 1 role (the platform role).

---

## Next.js security upgrade 16.4.0 → 16.4.3 (the deferred product decision, taken)

Run via `next upgrade --agent=security` on 2026-10-24 on `feature/foundation`. The
upgrade had been deliberately deferred twice as a product decision while next@16.4.0
carried a published advisory that made the build gate non-deterministic; that record
above stands as history. This entry is the decision, and its measurements.

### What changed and why

- `next` 16.4.0 → **16.4.3** (exact target from the upgrade handoff - the installed
  version was listed against a published security advisory) and `eslint-config-next`
  16.4.0 → 16.4.3 in lockstep. Same-major patch release: NO codemods, NO React bump
  (stays 19.3.0), and the TypeScript pin stays 6.0.3 - 16.4.3 raised no compatibility
  requirement against typescript-eslint's `>=4.8.4 <6.1.0` support window, so the
  toolchain risk that justified the deferral did not materialise.
- `experimental.agentUpgrade: "security"` added to `next.config.ts` as the handoff
  required. MEASURED: the key is in 16.4.3's own `config-schema.js` (accepted values
  `'security' | 'latest' | 'experimental-future'`), and two builds loaded the config
  without an unknown-key complaint.
- No other dependency was touched. The upgrade handoff's mandate is the Next advisory,
  not a general audit fix.

### MEASURED after the upgrade

| Gate      | Result                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| version   | `npx next --version` → `Next.js v16.4.3`                                                                                                              |
| typecheck | exit 0                                                                                                                                                |
| lint      | exit 0 (eslint 0 errors; 1 PRE-EXISTING warning in `.opencode/plugins/graphify.js`; check:secrets OK; format:check OK; migrations check OK, 61 files) |
| test      | 39 files, 897 tests, all passing (~470s)                                                                                                              |
| build     | TWO CONSECUTIVE runs on the unchanged tree, BOTH exit 0, no `SecurityFatalError`                                                                      |
| npm audit | `next` NO LONGER LISTED - the advisory that broke the build gate is resolved                                                                          |

The two consecutive clean builds are the measurement the stale build-gate record asked
for. The build gate is deterministic again on this tree.

### What was NOT fixed, and the residual risk recorded honestly

`npm audit` still reports 6 findings (1 moderate, 5 high) after the upgrade. MEASURED
dependency chains: body-parser 2.3.0 (high, DoS) sits inside
`shadcn → @modelcontextprotocol/sdk → express`; undici 7.30.0/8.12.1 (high) sits inside
`jsdom` and `shadcn`/`@dotenvx`; zod <4.6.6 (high, memory exhaustion on oversized
constrained collections) sits inside `shadcn`/`@shadcn/registry` - the only fix
`npm audit fix --force` offers would move shadcn to 4.22.1, OUTSIDE its stated
dependency range, which is exactly the kind of unreviewed bump the deferrals refuse.
These four are dev-toolchain only; no runtime path in the app reaches them.

The one runtime-adjacent chain: `@hookform/resolvers → ajv → fast-uri@3.1.8` (moderate,
URI scheme spoofing among four fast-uri findings). `@hookform/resolvers` IS a production
dependency, but this app's validation layer is zod; no ajv-backed resolution path is
exercised. Recorded as a residual risk and a later product decision, NOT as fixed.

## Task 19 - the documentation set describes the actual foundation

Task 19 added the documentation set required by spec §9. No application code, SQL, test or
configuration changed. Outside the new files, false claims in `AGENTS.md` and `.env.example`
were corrected; everything else in both files is unchanged.

### Created

- `README.md` - what the foundation is, prerequisites, environment variable names, scripts,
  the four gates inside `lint`, the migration rule, test suites, documentation index and the
  honest status.
- `docs/PRD.md`, `docs/SRS.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`,
  `docs/RLS_POLICIES.md`, `docs/SECURITY.md`, `docs/DESIGN_SYSTEM.md`,
  `docs/ROUTES_AND_PERMISSIONS.md`, `docs/TESTING.md`, `docs/DEPLOYMENT.md`,
  `docs/OPERATIONS.md`.
- This entry.

### Measured, not copied

| Measure                    | Value                                                 | Source                                                           |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Migration files            | 61, `00100`-`01880`                                   | `supabase/migrations/`; `migrations:check`                       |
| Applied history            | 61 rows, every file named once                        | `supabase_migrations.schema_migrations` over `TEST_DATABASE_URL` |
| Public tables              | 16, all `relrowsecurity = true`, none forced          | `pg_class`                                                       |
| Columns                    | 100                                                   | `information_schema.columns`                                     |
| Public foreign keys        | 21, of which 5 composite                              | `pg_constraint`                                                  |
| Unique / check constraints | 12 / 6                                                | `pg_constraint`                                                  |
| Indexes / triggers         | 36 / 18 trigger rows                                  | `pg_indexes`, `pg_trigger`                                       |
| Public policies            | 39 across 14 of the 16 tables                         | `pg_policies`                                                    |
| Storage policies / buckets | 20 / 5, all private                                   | `pg_policies`, `storage.buckets`                                 |
| Public application RPCs    | 10                                                    | `types/database.types.ts` `Functions`                            |
| `private` helpers          | 35                                                    | `pg_proc`                                                        |
| Permissions / roles        | 21 / 15 (14 tenant roles plus `platform_super_admin`) | `public.permissions`, `lib/permissions/registry.ts`              |

The brief says "15 catalogue tables"; the live catalogue holds **16 public tables**, and
**14** of them carry policies. `tenant_sequences` and `tenant_creation_events` carry none.
The artefacts and `AGENTS.md` use the measured value.

### Gates, 2026-10-26

| Gate                | Measured result                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`    | exit 0                                                                                                                                                                                                      |
| `npm run typecheck` | exit 0                                                                                                                                                                                                      |
| `npm run lint`      | exit 0. `eslint` 0 errors and 1 pre-existing warning in `.opencode/plugins/graphify.js`; `check:secrets OK`; `format:check` "All matched files use Prettier code style!"; `migrations:check` 61 files valid |
| `npm test`          | exit 0: **39 files, 899 tests passed**, 464.42 s                                                                                                                                                            |

### Banned claims

`rg` is not on `PATH`; the command failed with "The term 'rg' is not recognized as the name of
a cmdlet, function, script file, or operable program." The harness grep tool was run over
`README.md`, `AGENTS.md` and the top-level `docs/*.md` (excluding `docs/superpowers/**`) with
the same pattern. Every hit is benign: `isolation` / `isolating`, `ISO 4217` in the currency
discussion, and `advisory` in the build-gate record. No certification, compliance, uptime,
customer-count, integration or availability-percentage claim exists, and no hit is marked as
implemented when it is not.

### Corrected false claims

- `AGENTS.md` said Tasks 1-18 were complete and Task 19 was next. It now says 1-19 complete,
  Task 20 next.
- It said the migration range ended at `01850`. It ends at `01880`, which is in the history.
- It said "39 policies across 14 of the 15 tables". The catalogue has 16 public tables, 14
  with policies, and `tenant_creation_events` also has none.
- It called the signed-in routes "the `(app)` routes". They are `app/app/`, a real segment.
- It said `tests/e2e/` and `tests/integration/` "hold only tracked placeholders", and that the
  `e2e` scripts carried `--pass-with-no-tests`. Four E2E specs and fourteen integration
  suites are real; `e2e` is a plain `playwright test`, and only `test:integration` keeps the
  flag.
- It said the marketing shell "replaces the ROOT `app/page.tsx` (which still serves `/`)".
  The root page was deleted; `app/(marketing)/page.tsx` serves `/`.
- `.env.example` described `NEXT_PUBLIC_SUPABASE_ANON_KEY` without saying nothing reads it.
  It now says no client in this repository reads it, measured by grep.

### Conclusion

The documentation describes the **actual foundation**, not a product. Phases 4-10 remain
unbuilt, and the product is **not production-ready**. The records a reader must not miss:
invitation email delivery is BLOCKED; password-reset delivery is unverified and the hosted
redirect allow-list is not configured; email confirmation is disabled and re-enabling it is a
mandatory pre-launch step; billing is a refusing seam with no provider; there are no clinical
modules; and rate-limit, CORS, error-leakage, load, backup and monitoring coverage do not
exist.

### Task 19 fix round 1

A review of the Task 19 documentation found four factual errors and several smaller ones. The
documentation set was corrected; **no application code, SQL, test or runtime configuration
changed**. The paragraph above that says "no ... configuration changed" is corrected to "no runtime
configuration": `.env.example` - the only tracked environment template - was edited to say that no
client reads `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and that edit is not a runtime setting.

- **Storage policy roles.** `pg_policies` reports 15 policies `to authenticated` and the five
  DELETE policies `to public`, not 20 `to authenticated`. `AGENTS.md`, the Task 19 report and the
  rest of the set now say so. The report's table had presented the wrong value as measured.
- **Email confirmation does expose the invitation path.** With "Confirm email" off, Supabase
  implicitly sets `email_confirmed_at` at signup, so an attacker who registers the invited address
  passes the acceptance check. The check binds the account to the stored address; it does not prove
  mailbox control. `SECURITY.md`, `AGENTS.md`, `OPERATIONS.md` and `SRS.md` now say so, and
  re-enabling confirmation remains a production blocker.
- **`invitations.clinic_ids` is `uuid[]`**, not `text[]` (`information_schema.columns`).
- **`delete_organization` does not cascade to storage.** It deletes `public.organizations` only;
  object tenancy is the object name, so `storage.objects` and its bytes survive and need manual
  removal. `OPERATIONS.md` now says so, and the backup caveat no longer claims a storage cascade.
- **Cookie `secure` follows `NODE_ENV`, not the request scheme** (`lib/auth/session.ts`):
  `secure: process.env.NODE_ENV === "production"`. On plain HTTP in production the browser discards
  the cookie; outside production it is not marked `secure`.
- **`supabase/config.toml` is committed** and configures a local `supabase start` stack only.
  `README.md` and `DEPLOYMENT.md` no longer say no CLI configuration is committed.
- Smaller corrections: the storage section says five buckets; the trigger table is headed 14 rules
  over 18 `pg_trigger` rows; removing a member needs the service role or SQL editor because
  `organization_memberships` has no DELETE policy; `org-assets` UPDATE and DELETE omit the
  archived/delete-marker clauses; the auth E2E spec uses the public signup endpoint exactly once;
  and the anon key is documented as an unread placeholder whose plan-required fallback is not
  implemented.

## Task 19 fix round 2 - documentation corrections (2026-10-26)

Documentation only. No application code, SQL, test or configuration changed. Each claim below was
re-verified on the live catalogue or in the migrations before the edit was made.

- **Triggers are 14 definitions, 18 trigger events, 8 trigger functions.** Measured again from
  `pg_trigger` (schema `public`, non-internal rows only, insert/delete/update/truncate bits summed
  to 18). By function: `set_updated_at` 5 UPDATE, `guard_organization_status` 1 UPDATE,
  `guard_platform_admin` 1 UPDATE, `guard_role_delete` 1 DELETE, `guard_role_identity` 1 UPDATE,
  `guard_role_org_scope` 2 definitions (INSERT + UPDATE), `guard_timezone` 2 definitions
  (INSERT + UPDATE), `default_clinic_timezone` 1 INSERT. `DATABASE_SCHEMA.md` had said
  "18 (9 trigger functions)"; that both undercounted the events' meaning and miscounted the
  functions. Fix round 1 had restyled the same row as "14 rules; 18 `pg_trigger` event rows",
  which is now "14 definitions, 18 trigger events, 8 trigger functions" in the table and the
  heading.
- **`private.write_storage_audit` is a second security-definer writer to `audit_logs`.** Created by
  `20261014001694`, made unconditional by `20261014001696`: `AFTER DELETE ON storage.objects`,
  deriving the organization from the object path (`private.storage_org_id(old.name)`) and the
  actor from `auth.uid()`, which is NULL for a `service_role` deletion, and performing no
  membership check of its own. `SECURITY.md` and `SRS.md` AUD-2 no longer call
  `private.write_audit` the only writer.
- **The no-clinics rule is enforced at redemption, not in the invitation policies.**
  `20261014001820` lines 52-63 and 93-104 only require every named clinic to belong to the
  inviting organization. The refusal is `private.accept_invitation`
  (`20261014001790` lines 134-138: `raise exception 'that invitation names clinics, which this
release does not support'`). `SRS.md` INV-7 and `RLS_POLICIES.md` now point at the right layer.
- **The application does not read `SUPABASE_SERVICE_ROLE_KEY`.** Its only reader is
  `tests/helpers/auth-session-fixture.ts`; `lib/supabase/server.ts` reads the URL and the
  publishable key, and `lib/supabase/client.ts` names the service key only in a comment. The
  path rule is unchanged (allowed in `lib/supabase/server.ts` and under `tests/`), which is why
  `README.md` and `DEPLOYMENT.md` no longer imply the server client reads it.
- **The "executable by `authenticated`" list is not a list of policy helpers.** It mixes policy
  expressions, trigger functions and the definer the public wrapper reaches, and
  `RLS_POLICIES.md` now says so.

## Task 20 - final gate

Run on 2026-10-26 on branch `feature/foundation` at `fb54f1f` (base commit, tree clean).
Node v24.22.1, npm 11.19.1. Every command below was run separately and its exit code was read
from `$LASTEXITCODE`; no result here is restated from an earlier task. This task adds NO
application code, SQL, migration or runtime configuration - it appends this section and corrects
one stale E2E locator (below). **`AGENTS.md` is NOT edited, and that is a deliberate choice with
a reason:** its "Current state" says "Tasks 1-19 of 20 are complete ... Task 20 is next", which
is now false, and the brief allows a minimal factual update only in that case - but every other
sentence in it is confirmed by this run, so the bare correction is left to the reviewer rather
than guessed at here.

### THE GATES

| Gate                | Command                | Exit      | Decisive output                                                                                                                                                            |
| ------------------- | ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck           | `npm run typecheck`    | 0         | `tsc --noEmit` completed with no diagnostics printed                                                                                                                       |
| lint sub-gate 1     | `eslint .`             | 0         | 0 errors, 1 pre-existing warning in `.opencode/plugins/graphify.js` (`import/no-anonymous-default-export`, line 32)                                                        |
| lint sub-gate 2     | `check:secrets`        | 0         | `check:secrets OK - no service-role or hard-coded secret references found.`                                                                                                |
| lint sub-gate 3     | `format:check`         | 0         | `All matched files use Prettier code style!`                                                                                                                               |
| lint sub-gate 4     | `migrations:check`     | 0         | `migrations check OK: 61 file(s), all valid`, each file listed with its `idempotency_key`                                                                                  |
| lint (combined)     | `npm run lint`         | 0         | all four sub-gates above ran in sequence and all passed                                                                                                                    |
| test                | `npm test`             | 0         | `Test Files 39 passed (39)`; `Tests 899 passed (899)`; duration 463.55 s; 39 workers, `fileParallelism: false`                                                             |
| build               | `npm run build`        | 0         | `next build` with Next.js 16.4.3 (Turbopack): compiled in 1428 ms, TypeScript 2.1 s, 14 static pages generated, 14 routes plus `/api/auth/verify` and `Proxy (Middleware)` |
| e2e (first run)     | `npm run e2e`          | 1         | 32 tests, 30 passed, 2 failed - see the section below                                                                                                                      |
| e2e (after fix)     | `npm run e2e`          | 0         | 32 passed (1.4 m) across chromium and firefox                                                                                                                              |
| format:check (post) | `npm run format:check` | see below | recorded verbatim in the closing block                                                                                                                                     |

`npm run build` type-checks itself ("Running TypeScript ... Finished TypeScript in 2.1s"), so
the typecheck result is confirmed twice, in two different runs.

**Playwright browsers were NOT installed.** The first `npx playwright install --dry-run` listed
`chromium-1248`, `firefox-1555`, `webkit-2370`, `ffmpeg-1013` and `winldd-1007` and
`C:\Users\Maruata\AppData\Local\ms-playwright` did not exist. `npx playwright install chromium
firefox` was run once (webkit was not installed: no project in `playwright.config.ts` uses it),
exit 0, and the E2E gate then ran. This was needed and is recorded as such.

### THE E2E FAILURE, AND WHY IT WAS FIXED RATHER THAN RECORDED AS RED

The first E2E run failed the same test in both browsers:

```
[chromium] › tests\e2e\platform-gate.spec.ts:74:3 › the marketing shell › the public root
renders without a session, and says nothing about a signed-in visitor
  Locator: getByRole('heading', { name: /Each clinic gets its own workspace/ })
  Expected: visible
  Error: element(s) not found
```

The cause is a stale assertion, not a product defect, and it is traceable:

- `components/marketing/hero.tsx` renders
  `Every organization is its own isolated workspace, and the database keeps them apart.`
- That copy was corrected in commit `5929ba6` (2026-10-22), whose message records the reason:
  the hero said "Each clinic gets its own workspace", but **an organization is the isolation
  boundary and intra-tenant multi-clinic is not built**. The old sentence was false.
- The spec still asserted the old string, and no E2E run had happened since `5929ba6` - the
  E2E gate was last run at `1756b9b`/`12cfbd5`, and Tasks 18 and 19 did not run it. So the
  red gate was latent, and this task is the first run to see it.

The fix is the assertion, not the copy: `tests/e2e/platform-gate.spec.ts` now looks for
`/Every organization is its own isolated workspace/`, with a comment naming the earlier
revision and why it was false. The assertion's purpose - the page renders and its hero states
the tenancy claim - is unchanged, and the rest of the test (a signed-in visitor sees the same
page; no "Sign out" control in the public shell) is untouched. The failing test was then run
alone on both browsers (2 passed) before the full suite was re-run.

The E2E suite creates no residue of its own: `tests/helpers/e2e-cleanup.ts` verifies itself
and the run finished with no cleanup error. Measured separately (below), the live project holds
no row any E2E spec created.

### WHAT THE RESIDUE CHECK FOUND, AND WHY IT IS NOT THIS TASK'S

Measured over `TEST_DATABASE_URL` after the final E2E run:

| Measure                                        | Value                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| organizations                                  | 2 - `Isolation Tenant A` (`iso-a-mvoyeyloksv4`), `Isolation Tenant B` (`iso-b-mvoyeyloksv4`) |
| auth users                                     | 2 - `probe-1793000852676-106375@example.test`, `probe-1793000854748-308706@example.test`     |
| clinics / patients / identifiers / invitations | 2 / 3 / 3 / 3                                                                                |
| memberships / clinic_memberships / assignments | 2 / 2 / 3                                                                                    |
| audit_logs / tenant_creation_events            | 2 / 2                                                                                        |
| roles                                          | 32 (16 and 15 per surviving tenant, 1 platform role)                                         |
| storage.objects                                | 2, both in `patient-documents`, both named by their own org prefix                           |
| schema_migrations                              | 61                                                                                           |

These rows are the **security isolation fixture's own tenants** (`tests/security/fixtures.ts`
line 110 names them `Isolation Tenant ${label}`), and their account ids and slugs date them to
`2026-10-26T07:47:32Z-07:47:39Z` - during the `npm test` run this task executed, not during the
E2E runs. Two decisive measurements:

1. **The suite cleans up after itself.** `npx vitest run
tests/security/tenant-isolation.test.ts` alone: `Test Files 1 passed (1)`, `Tests 21 passed
(21)`, exit 0, 162.25 s. The residue counts above were UNCHANGED afterwards - so the run
   added and removed its own tenants successfully.
2. **The survivors carry identifiers only an aborted run can produce.** Tenant A's patient row
   has `last_name = "Own rename"` (written by the UPDATE test at line 606, whose positive
   control deliberately renames A's OWN patient and leaves it); a second patient
   `CROSS-TENANT-CONTROL` and an invitation `insert-ctrl-e31bd1c4@example.test` are the INSERT
   tests' positive controls. A completed run's `destroyTwoOrganizations` deletes all of them.
   So the run that produced these rows was interrupted after seeding, before the tests, and
   before its `afterAll`.

**This is recorded, not cleaned, and it is not fixed here.** Removing two tenants and two
accounts from a live database that is not this task's to mutate would itself be an unauthorised
write, and the residue is inert: both accounts hold no administrator permission, both
organizations are `active` with one membership each, and no cross-tenant exposure exists. The
next agent must know the two accounts and the two organizations are there, and that a full
green `npm test` does NOT imply zero residue in this project.

### MIGRATION EVIDENCE

`npm run migrations:check` - exit 0, `migrations check OK: 61 file(s), all valid`, every file
named with its idempotency key, `20261014000100_extensions_and_schemas.sql` through
`20261014001880_organizations_update_restoration.sql`.

Read over `TEST_DATABASE_URL`:

- `supabase_migrations.schema_migrations`: **61 rows**, 61 distinct `name` values, 61 files.
- **Every committed migration filename has exactly one history row naming it, and no history
  row names a file that does not exist.** The comparison is on the `name` column (the filename);
  the `version` column is the applier's own apply timestamp, and it is NOT the filename - the
  first version of this check compared the file stem against `version` and produced 61 false
  "no history row" mismatches for exactly that reason.
- **The applied order is NOT the filename order, and this is a fact, not a defect the check
  may manufacture.** Measured: `20261014001200_rls_tenant_data_audit_and_platform.sql` was
  applied at history index 14, while `01000` and `01100` occupy indices 15 and 16. Three files
  differ; the other 58 match. The dependencies are DDL statements whose order in a single
  apply call is not the filename order, and `migrations:check` validates filename order, naming
  and idempotency keys - not the order the rows happen to carry in history.

Catalogue, read from the same connection (evidence that the applied system exists; NOT evidence
that a clean apply works):

- 16 public tables, every one `relrowsecurity = true`, none forced.
- 39 public policies, 14 of the 16 tables: `audit_logs` 1, `clinic_memberships` 4, `clinics` 2,
  `invitations` 4, `organization_memberships` 2, `organizations` 2, `patient_identifiers` 4,
  `patients` 4, `permissions` 1, `platform_settings` 1, `profiles` 2, `role_permissions` 4,
  `roles` 4, `user_role_assignments` 4. `tenant_sequences` and `tenant_creation_events` carry
  zero by design.
- 20 storage policies on `storage.objects`; 5 buckets, all `public = false`
  (`clinical-attachments`, `investigation-reports`, `org-assets`, `patient-documents`,
  `prescription-documents`).
- 35 `private` functions; the public no-argument functions are `has_any_membership`,
  `is_platform_admin`, `rls_auto_enable` and `tenant_directory`.

**The migration-from-zero clean-room check is BLOCKED, and it is recorded as BLOCKED, not as
passing.** Exact reason: no Docker (`docker` is not on PATH), no Supabase CLI (`supabase` is not
on PATH), no Supabase Personal Access Token - migrations are applied through the Composio MCP
applier, which reaches only the live project - and the live project is the only reachable
database, so dropping or recreating its schema to obtain a clean schema is destructive and is
not authorised by this task. The evidence above proves that 61 files correspond to 61 history
rows and that the objects they create are present; it does not prove that applying them in
filename order to an empty schema produces a working system. Task 19 recorded the same gap.

### `npm audit` - the residual, run this task

`npm audit` exits **1** with **6 vulnerabilities: 1 moderate, 5 high**. Identical to the Task 18
record; none is claimed as fixed.

- `body-parser` 2.0.0 - 2.3.0, high (DoS via trailing bytes after a compressed request body).
- `fast-uri` 3.0.0 - 3.1.8, moderate (four advisories: URI scheme spoofing, path equivalence,
  host confusion, scheme injection).
- `undici` 7.0.0 - 7.30.0 and 8.0.0 - 8.12.1, high (three advisories: two EventSource DoS, SRI
  bypass, content-encoding DoS), reached through `@dotenvx/dotenvx`, `@shadcn/registry`,
  `shadcn` and a top-level copy.
- `zod` < 4.6.6, high (memory exhaustion validating oversized constrained collections), inside
  `shadcn` / `@shadcn/registry`; the fix requires `npm audit fix --force`, which would install
  `shadcn@4.22.1`, outside the stated dependency range.

All are dev-toolchain dependencies except `body-parser`/`fast-uri` via `@hookform/resolvers ->
ajv`, which Task 18 already named as the one moderate that reaches the application dependency
path. No advisory is closed by this task.

### EVERY BLOCKED ITEM, CARRIED FORWARD

1. **Migration apply from a clean schema** - BLOCKED. No Docker, no Supabase CLI, no PAT; the
   live project cannot be destructively reset. Reasons as recorded above.
2. **Razorpay billing wiring (Phase 8)** - BLOCKED. `lib/billing/` is a refusing seam:
   every method raises `PaymentNotConfiguredError`, `isPaymentConfigured()` is `false`, and no
   provider SDK, HTTP client or environment variable exists in it. Test keys are absent. Nothing
   about billing works.
3. **Invitation email delivery** - BLOCKED. There is no mail provider, no send and no queue;
   `/app/settings/members` shows the link for manual sharing and says so.
4. **Password-reset mail delivery** - BLOCKED, and unverified here. Task 15 measured that the
   provider refuses a known `example.com` address with `email_address_invalid`; the cause was
   never established. The hosted project's redirect allow-list is not configured, so even a
   successful send redirects to a URL GoTrue refuses. This task did not re-measure it.
5. **Email confirmation is disabled** - BLOCKED and a production blocker. With it off, Supabase
   sets `email_confirmed_at` implicitly at signup, so anybody who registers an invited address
   can accept that invitation. Re-enabling confirmation is mandatory before launch.
6. **Platform-console HTTP coverage** - BLOCKED beyond its current shape. Measured over real
   HTTPS for the non-administrator refusal and a positive control, but rate limiting, CORS,
   error-message leakage and load behaviour are not covered anywhere.
7. **Gates that did not run here** - none. All five gates ran in this task. `npx playwright
install` was required first and is recorded above. `npm audit` ran and is reported above.
   Note what the running of these gates does NOT cover: the HTTP/JWT isolation measurement of
   Tasks 9-10 is cited from the record, not repeated here; nor are the audit-metadata and
   password-reset provider measurements, and the clinicDayBounds sweep (601,920 samples) is
   pinned by the test suite, not re-run here.
8. **The two surviving isolation tenants and probe accounts** described above are residue in
   the live project. They are inert, they are not this task's, and they are NOT claimed as
   clean.

### CONCLUSION

The foundation is **verified**: typecheck, the four lint sub-gates, 899 tests in 39 files, the
production build and 32 E2E tests across chromium and firefox all ran and all passed, with the
one real defect this run found (the stale marketing-copy assertion, introduced by a copy
correction on 2026-10-22 that no E2E run had caught since) fixed and re-proven. The 59-policy
catalogue (39 public, 20 storage), the mutation-verified tenant-isolation suite, and the
RLS/HTTP measurements in the record stand as evidence that the tenancy boundary holds.

The foundation is **not a product**. Phases 4-10 remain unbuilt. There is no patient record, no
appointment, no invoice, no notification, no subscription and no payment in this release; the
marketing page deliberately names only what exists, and the dashboard shows no clinical numbers
because there are none to show. **This system is NOT production-ready and must not be presented
as such.** The blockers are the eight above, led by the disabled email confirmation and the
unverified migration-from-zero apply.
