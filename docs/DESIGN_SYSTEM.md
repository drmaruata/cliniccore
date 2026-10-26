# Design system - ClinicCore foundation

Tailwind v4, CSS-first. There is **no `tailwind.config.js`**: design tokens live in
`app/globals.css` and are compiled by `@tailwindcss/postcss`. `components.json` points shadcn at
the same tokens. What follows is measured from those files and pinned by
`tests/unit/design-tokens.test.ts`.

## The six brand colours

Mandated in hex, declared in OKLCH because every derivative is a lightness/chroma move off a brand
hue. In light mode the conversion round-trips to the mandated hex **exactly**, and the test asserts
that - so the mandate cannot drift by a rendering tolerance.

| Role        | Hex       | Light OKLCH            | Dark OKLCH          | Allowed use                      |
| ----------- | --------- | ---------------------- | ------------------- | -------------------------------- |
| Primary     | `#05ab29` | `0.6442 0.2049 144.41` | `0.75 0.19 144.41`  | Actions, active state, "go"      |
| Secondary   | `#066fc4` | `0.537 0.1559 251.47`  | `0.76 0.13 251.47`  | Informational actions, links     |
| Destructive | `#bf140b` | `0.5118 0.2009 29.44`  | `0.7 0.16 29.44`    | Destructive actions only         |
| Neutral     | `#b5bdbb` | `0.7915 0.0093 179.53` | `0.5 0.0093 179.53` | Borders and muted surfaces only  |
| Success     | `#35a677` | `0.6497 0.1237 161.64` | `0.78 0.13 161.64`  | Confirmed, paid, healthy         |
| Navy        | `#172099` | `0.3453 0.1893 268.45` | `0.75 0.14 268.45`  | Headings and emphasis, not fills |

The brand neutral measures about **1.8:1 on white**. It is a border and muted-surface colour and
nothing else; the suite asserts it never qualifies as text.

Dark mode **re-lights** every brand colour on its own hue rather than reusing the light value.
Keeping light navy on the dark surface would be about 1.5:1 - the heading would disappear.

## Token layers

`:root` and `.dark` are the only places a colour is written, **including in comments**. Every
other rule, utility and component reaches colour through a custom property. A hex literal outside
those two blocks fails the suite.

```
brand hue  →  semantic role  →  Tailwind namespace  →  utility
#05ab29    →  --primary      →  --color-primary    →  bg-primary
```

- `--primary`, `--secondary`, `--destructive`, `--success` are brand-backed.
- `--primary-ink`, `--success-ink`, `--destructive-ink` are the **on-surface text** variants. The
  brand fills fail AA as text: primary is 2.93:1 on background, success 3.06:1 on white.
- `--primary-foreground` and `--success-foreground` are a deep ink, not white - white on those
  fills is 3.06:1, below AA. The ink measures 5.70:1 and 5.71:1.
- `--border` and `--input` are darkened off the brand neutral to clear WCAG 1.4.11's 3:1 for a
  control boundary. The brand neutral itself is 1.84:1 on background.
- `--radius` is `0.625rem`; `--radius-sm` … `--radius-4xl` derive from it.
- `--chart-1` … `--chart-5` map onto the brand set, so a chart never introduces a seventh hue.
- `--sidebar-*` are pre-mapped so a later `shadcn add sidebar` cannot reintroduce shadcn's default
  blue.

### The Tailwind bridge

`@theme inline` is load-bearing. Without `inline`, Tailwind resolves each `var(...)` at build time
and inlines the light value, so `.dark` could never re-colour anything. With it, `bg-primary`
compiles to `background-color: var(--primary)`, resolved at run time.

The test asserts every token is bridged. A token that exists but is not in the bridge is not
reachable as a utility - which is how `--destructive-hover` was once unusable.

## Dark mode

Class-based, not media-based: `@custom-variant dark (&:is(.dark *))`. Tailwind's default is
`prefers-color-scheme`, which cannot express "the user chose light inside an OS set to dark".

`color-scheme` is set explicitly on both blocks. Without it a dark page still gets a light
scrollbar, light form-control chrome and a light autofill dropdown, because those are painted by
the user agent from the keyword rather than from a token.

## Typography

`next/font` owns `--font-geist-sans` in `app/layout.tsx`; `@theme inline` points `--font-sans` and
`--font-heading` at it. The direction of the reference is always one way.

`--font-sans: var(--font-sans)` is **not** valid: a self-referencing custom property resolves to
the guaranteed-invalid value, and every heading silently falls back to the system font with no
error anywhere. The test asserts no declaration in `@theme inline` references itself, and that the
heading utility has a consumer.

## `cn`

`import { cn } from "@/lib/utils/cn"` - always. `shadcn add` re-emits `import { cn } from "cn"`,
which resolves to the unrelated npm package whose merge engine does not know this project's custom
colours and therefore cannot collapse `bg-primary` against `bg-success`; CSS source order then
decides the colour. Two defences:

- `eslint.config.mjs` makes the bad import a hard error under `components/**` and `app/**`;
- `tests/unit/cn.test.tsx` asserts the correct module and that `package.json` does not depend on
  `cn` (ESLint cannot see a dependency entry).

`components.json`'s `aliases.utils` is **not** a defence - the CLI emitted the bad import anyway.

## Components

| Group                               | Files                                                                                                | Notes                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Primitives (`components/ui/`)       | `alert-dialog`, `badge`, `button`, `card`, `input`, `label`, `skeleton`, `table`                     | Generated by shadcn, kept byte-for-byte; `.prettierignore` excludes `components/ui` on purpose |
| Shared (`components/shared/`)       | `confirm-dialog`, `data-table`, `empty-state`, `kpi-card`, `page-header`, `skeleton`, `status-badge` | House wrappers. `data-table` and `kpi-card` are primitives with no data source yet             |
| Application (`components/app/`)     | `clinic-switcher`, `org-switcher`, `sidebar-nav`                                                     | Server components read the data; the switchers post to server actions                          |
| Marketing (`components/marketing/`) | `feature-highlights`, `hero`, `site-footer`, `site-header`                                           | Public, reads no session                                                                       |

`CardTitle` renders a `div`, not a heading. A page whose title is a `CardTitle` has **no heading at
all** - invisible to a screen reader navigating by heading. The auth pages wrap their titles in an
`<h1>`; do the same.

`ConfirmDialog` is built on `AlertDialog`, whose enter/exit animation is driven by `data-open:` and
`data-closed:` from the vendored CSS below.

## Vendored `app/shadcn.css`

`shadcn@latest init` originally wrote `@import "shadcn/tailwind.css"`, which put a devDependency on
the build-time CSS resolution path - Tailwind reads `node_modules` while compiling, so a build that
installs with `--omit=dev` could not resolve it. Vercel installs devDependencies for its build
phase, so neither the local nor the Vercel build exercised that path.

Only the two `@custom-variant data-open` / `data-closed` blocks the generated components actually
reference are vendored. Deleting them fails no build; it only kills the dialog animation. Do not
restore the package import.

## Accessibility

The palette is held to WCAG AA by measurement, not by eye:

| Assertion                                                                              | Result                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Brand neutral never used as body text                                                  | enforced                                                                                         |
| Brand primary never used as body text; `--primary-ink` is the text token               | enforced (5.08:1 on background, 5.30:1 on card)                                                  |
| `--border` usable as a component boundary                                              | 3.47:1 on background, 3.62:1 on card, 3.18:1 on muted                                            |
| `--input` boundary                                                                     | clears 3:1 on every light surface                                                                |
| Every generated Button and Badge variant clears AA as text, or has a compensating rule | enforced by enumerating the variant strings from the generated source                            |
| `Button asChild` slots                                                                 | derived by scanning wrappers; a compensating rule must cover every emitted `data-slot`           |
| Destructive variant boundary                                                           | solid `--destructive` fill; 6.06:1 vs background, 6.33:1 vs card (light); 6.46:1 / 5.90:1 (dark) |
| Destructive hover                                                                      | 6.91:1 light, 7.43:1 dark                                                                        |
| `ConfirmDialog` in the real DOM                                                        | rendered and measured in both modes                                                              |

Compensating rules live **unlayered** in `app/globals.css`, because Tailwind emits utilities into
`@layer utilities` and an unlayered declaration outranks every layer. They key on `data-variant`,
which the generated Button and Badge already emit.

**Residuals, recorded rather than solved:**

- **No automated accessibility audit.** There is no axe or Playwright accessibility scan; the
  suite measures colour contrast and specific DOM slots. Structure, labels and keyboard order are
  not machine-checked.
- **Touch users get no destructive-hover state.** `:hover` does not fire on touch. This matches
  what the generated `hover:` utilities already gave them.
- **A destructive Badge used as a link loses its generated `[a]:hover` tint**, because the
  compensating rule is unconditional. Nothing in the app renders one today.
- **Two components (`data-table`, `kpi-card`) have no live consumer**, so their accessibility is
  only as good as their markup review.
- **The marketing copy is Phase 4.** It makes no claim that has not been verified, and the footer
  says the foundation is what exists.
