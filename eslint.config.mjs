import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Flat config. eslint-config-next 16 ships native flat-config arrays, so no
 * FlatCompat shim is used (FlatCompat + these arrays crashes with
 * "Converting circular structure to JSON").
 *
 * NOTE: typescript-eslint refuses to load under typescript@7.x
 * (typescript@6.0.x is the newest version it supports). See
 * docs/IMPLEMENTATION_STATUS.md for the measurement.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    /*
     * There is exactly one class-merge engine in this repo: `@/lib/utils/cn`.
     *
     * `shadcn@latest init` with the `radix-nova` style emits
     * `import { cn } from "cn"` into every file it generates — a DIFFERENT npm
     * package whose engine does not know this project's custom theme colours
     * (`success`, `accent`, `secondary`, `primary`) and therefore cannot collapse
     * `bg-primary` against `bg-success`. Both survive on the element, and CSS
     * source order rather than the class decides the badge's colour.
     *
     * `components.json` already sets `"aliases": { "utils": "@/lib/utils/cn" }`.
     * That is NOT a defence: the CLI emitted `from "cn"` anyway. The alias is
     * therefore not cited anywhere as protection against this.
     *
     * This lives in eslint rather than only in the test suite because it is a
     * "do not do this" rule, and `npm run lint` runs earlier and covers the file
     * the moment it is written. The matching assertion in
     * tests/unit/cn.test.tsx stays: eslint covers imports, the test also covers
     * the dependency entry in package.json.
     */
    files: ["components/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "cn",
              message:
                "Import `cn` from '@/lib/utils/cn', never from the npm 'cn' package. That package's merge engine does not know this project's theme colours and fails to collapse conflicting bg-*/text-* utilities. The `shadcn` CLI emits `from \"cn\"` by default — repoint the import after `shadcn add`.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      // NOTE: vitest.config.ts and playwright.config.ts are deliberately NOT
      // ignored. tsconfig.json typechecks them, so lint must cover them too —
      // otherwise the two gates disagree about what "the codebase" means.
    ],
  },
];

export default config;
