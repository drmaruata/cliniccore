import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom so shadcn/component tests can render. Tests that need plain Node
    // semantics still work — jsdom adds globals, it does not remove Node's.
    environment: "jsdom",
    // .tsx MUST be matched. A *.test.ts-only glob silently reports success
    // while skipping every component test added from Task 2 onward.
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
    passWithNoTests: false,
    // The integration and security suites open real transactions against a remote
    // Postgres pooler and impersonate principals in them. At the 5s default they
    // flaked under parallel load - MEASURED: 2 failures in 3 full runs, both a single
    // DB-backed test timing out, and both green in isolation. 15s is still a hard
    // bound (a hung test still fails) and it stops a loaded CI box from reporting a
    // security suite as broken when nothing is.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
