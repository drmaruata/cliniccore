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
