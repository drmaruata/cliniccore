# Implementation status

Append-only log. Newest entry last.

---

## Task 1 — Project scaffold and toolchain gates

Branch: `feature/foundation`
Node v24.16.0, npm 12.1.0, Windows + PowerShell.

### TypeScript version — resolved by measurement, not assumption

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

#### Run 1 — `typescript@7.0.2` (`npx tsc --version` → `Version 7.0.2`)

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

#### Run 2 — `typescript@6.0.3`

`typescript@6.0.3` is a published stable (note: it is **not** the `latest`
dist-tag, which is `7.0.2`; `npm view typescript@6 version` → `6.0.3`). It is
inside typescript-eslint's supported range `>=4.8.4 <6.1.0`, and it is the exact
version Microsoft's own error message points to ("run typescript-eslint using
the TS 6 API").

- `npx tsc --version` → `Version 6.0.3`
- `npm run typecheck` → exit 0
- `npm run lint` → exit 0 (typescript-eslint loaded cleanly, no warning)
- `npm test` → 13 passed
- `npm run build` → exit 0, Next 16.4.0 + Turbopack

**Decision: pin `typescript` to `6.0.3` exactly.** Rationale:

1. It is the newest TypeScript for which every gate in the definition of done
   provably passes, and the newest one the Next.js 16 lint stack supports.
2. It is materially newer than the `^5.9` fallback the brief anticipated, so
   this is the least-surprising resolution rather than a retreat to the fallback.
3. It keeps a _single_ TypeScript in the tree. The "side-by-side" arrangement
   Microsoft's post suggests would mean `tsc` on 7.0.2 and typescript-eslint on
   a second copy — two compilers that can disagree, for no observed benefit.

**Revisit condition.** Upgrade to `typescript@>=7.1` once
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
ships, and re-run this measurement. Do not assume the fix; re-measure.

### Why `exactOptionalPropertyTypes: false` is a deliberate exception

Brief Step 2 requires this be documented as a deliberate exception rather than
an oversight. It is the single flag left off from the strict family.

With `exactOptionalPropertyTypes: true`, `{ prop?: T }` rejects an explicit
`prop: undefined`. Almost every third-party prop type in this stack is written
as `prop?: T` without that constraint in mind, so enabling it produces errors at
component boundaries we do not control — shadcn/ui primitives, `@supabase/ssr`
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

### HARD OBLIGATION — `lib/supabase/server.ts` must start with `import "server-only"`

Carried forward into whichever task creates the Supabase server client. This is
the **primary** enforcement layer for the service-role boundary; the lint gate is
the secondary one.

- `server-only` fails at **bundle time**, inside React Server Component
  boundaries. Nothing in the codebase can talk the bundler out of it.
- The lint gate (`scripts/check-no-secrets.ts` rule 3) catches the mistake
  earlier and in review, but it is a lexical scanner: it models the specifiers
  it knows (`@/lib/supabase/…`, `lib/supabase/…`, relative `../lib/supabase/…`)
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

### OBLIGATION FOR TASK 15 — remove `--pass-with-no-tests` from `e2e`

`package.json` currently defines:

```json
"e2e": "playwright test --pass-with-no-tests"
```

Task 1 has no E2E specs by design. Without the flag, `npm run e2e` fails with
`Error: No tests found` (exit 1) for a reason that is not a defect — there is
simply nothing to run — which makes the gate lie in both directions: it reports
failure for a healthy repo, and it would report success for a repo whose specs
failed to be collected.

**Task 15 must remove `--pass-with-no-tests` from both the `e2e` and
`test:e2e` scripts when it adds the first real spec.** From that point on an
empty or uncollectable spec set must be a hard failure again. Do not carry the
flag forward past Task 15.

---

## Task 2 — design system, and the toolchain rules it established

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
Vercel builds never exercised that path — which is why this went unnoticed
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
  noisy — but only once you have removed devDependencies, which a local
  `npm install` never does.

So: the visible symptom is fine. The reason to care is that the one gate which
_looks_ like it covers the design system (the token test) has a structural blind
spot, and `tailwindcss` moving sections is exactly the kind of change that is
made without running a production build. **Treat "tailwindcss →
dependencies" as a change requiring a `--omit=dev` build to verify.**

### `app/shadcn.css` is vendored, not imported from the package

`@import "shadcn/tailwind.css"` was replaced by a 40-line vendored file
carrying only the two `@custom-variant` blocks the generated components actually
use (`data-open`, `data-closed` — verified by grepping every `data-*:` variant
in `components/ui/*.tsx`; nothing references the accordion keyframes,
`no-scrollbar`, `scroll-fade-*` or `shimmer-*`).

Consequence for anyone tempted to restore the package import: losing these rules
**fails no build and fails no test**. `components/ui/alert-dialog.tsx` drives its
enter/exit animation from `data-open:animate-in` and `data-closed:animate-out`,
and `components/shared/confirm-dialog.tsx` is built on that alert dialog. Delete
them and the dialog simply pops in with no animation — a silent visual
regression. Measured effect of the vendoring: the compiled stylesheet is
identical for the variants and 900 bytes smaller, having dropped dead
`--scroll-fade-*` / `--shimmer-*` registrations.

### One merge engine: `cn` comes from `@/lib/utils/cn`, never from the `cn` package

`shadcn@latest init` with the `radix-nova` style emits
`import { cn } from "cn"` into every file it generates — an unrelated npm
package whose merge engine does not know this project's custom theme colours
and therefore cannot collapse `bg-primary` against `bg-success`. Both survive on
the element and CSS source order decides the colour.

`components.json` already sets `"aliases": { "utils": "@/lib/utils/cn" }`. **That
is not a defence.** The CLI emitted the bad import anyway. Three independent
guards now exist, each catching something the others cannot:

- ESLint `no-restricted-imports` scoped to `app/**` and `components/**` — fails
  at lint time, before tests.
- `tests/unit/cn.test.tsx` — catches quote styles and subpath forms ESLint's
  pattern does not, and asserts `package.json` has no `cn` dependency, which
  ESLint cannot see at all.
- `AGENTS.md`, for the human.

### Compensating rules in `app/globals.css` for generated variants that fail as text

`--primary` does two jobs — the `default` Button's fill (fine, paired with
`--primary-foreground`) and the `link` variant's text (2.93:1, not fine). Only
`--brand-primary` is mandated; `--primary` is a token this project chooses, so
the fix is at the token and variant layer, not the palette.

`components/ui/` is generated and is not hand-edited for colour. Instead,
`app/globals.css` carries unlayered rules keyed on `data-slot` + `data-variant`
(both already emitted by the generated code, so they survive a future
`shadcn add`). `tests/unit/design-tokens.test.ts` then reads **every** variant
out of `button.tsx` and `badge.tsx` and requires each to clear AA against what
it actually paints, or to have such a rule — and requires the rule's own token
to clear AA too. A new `shadcn add` shipping `variant="subtle": "text-primary"`
fails the suite without anyone thinking of it.

### OBLIGATION FOR A LATER TASK — `--input` on `--muted` is 2.83:1 in light mode

Measured, not asserted. `--muted` is `oklch(0.955 0.004 250)` against
`--background`'s `oklch(0.985 0.002 250)`, so a form control sitting on a muted
panel has an under-contrast edge, where the same control on `--background` clears
3:1. This is the same class of defect as the `--border` finding Task 2 fix round
1 closed, one declaration over, and it was outside what that round was asked to
change. Decide whether `--input` should clear 3:1 on `--muted` too, or whether
WCAG 1.4.11 does not apply to an input on a panel — then either fix the token or
gate it.

### OBLIGATION FOR A LATER TASK — `bg-white` and friends escape the colour gate

`tests/unit/design-tokens.test.ts` rejects hex literals, Tailwind's numeric
palette (`bg-red-500`) and literal colour functions in component files. It does
**not** reject `bg-white`, `text-black`, `bg-transparent` or `bg-current`: the
palette regex is anchored on the numeric suffix, because a bare
`-(red|blue|…)-` prefix pattern would also flag `border-border` and `bg-muted`,
which need their own allowlist-of-one decision. `--card` is white in light mode,
so `bg-white` is exactly what a contributor reaches for. Needs its own rule plus
that decision.

### RECORDED, NOT FIXED — test fixtures leak palette colours into the stylesheet

Tailwind scans the whole project, so the throwaway merge fixtures in
`tests/unit/cn.test.tsx` (`bg-red-500`, `text-blue-500`) cause Tailwind to emit
`--color-red-500`, `--color-blue-500`, `--color-slate-200`, `--color-zinc-900`,
`--color-black` and `--color-white` into the production stylesheet. Tests are
deliberately outside the gate's scan roots — they are not product UI surface,
and the fixtures have to name a real palette class to exercise merging — so this
is not a violation of any rule. Cosmetic, but it means the shipped stylesheet is
not purely a function of shipped components.

### RECORDED — M8, the CSS gate reuses a TypeScript comment stripper

`findHexLiterals` and the per-file component scan both call `stripComments` from
`scripts/check-no-secrets.ts`. It works only because CSS and TypeScript share
the `/* … */` form. A CSS-native stripper is the correct fix.

See `.superpowers/sdd/cliniccore-foundation/task-2-report.md` for the full
report, including the contrast measurements behind every token value.
