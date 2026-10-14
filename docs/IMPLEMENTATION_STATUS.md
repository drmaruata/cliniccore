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

### Files created

`package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
`eslint.config.mjs`, `.prettierrc`, `vitest.config.ts`, `playwright.config.ts`,
`.gitignore`, `.env.example`, `lib/utils/cn.ts`, `scripts/check-no-secrets.ts`,
`app/layout.tsx`, `app/globals.css`, `app/page.tsx`,
`tests/unit/check-no-secrets.test.ts`, `tests/integration/placeholder.ts`.

See `.superpowers/sdd/cliniccore-foundation/task-1-report.md` for the full
report, including the reasoning behind the three files the brief did not list.
