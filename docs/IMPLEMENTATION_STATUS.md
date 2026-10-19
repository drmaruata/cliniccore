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
