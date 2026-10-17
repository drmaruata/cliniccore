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
