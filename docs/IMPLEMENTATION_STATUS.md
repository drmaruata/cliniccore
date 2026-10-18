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
