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
    // Postgres pooler and impersonate principals in them. MEASURED: one test took
    // 5005ms against a 5s default and failed, while the other 15 in that file took
    // 1.3-2.0s. The cost is ROUND TRIPS, not parallel load - a fixture is ~15
    // sequential statements at ~70ms each - so parallelism does not help and a longer
    // timeout does not fix it, it only stops the suite misreporting that as broken.
    // The real defence is statement_timeout in beginSession, which distinguishes a slow
    // network from a slow predicate. 15s is still a hard bound, so a hung test fails.
    testTimeout: 15_000,
    // MEASURED: vitest's hookTimeout DEFAULTS TO 10s and is not covered by testTimeout.
    // The auth fixtures' fully exhausted rate-limit retry is ~28.5s (three calls x
    // 0+2.5+7s), so the hook - not the test - is the budget, and the timeout lands exactly
    // when the auth server is slowest: which is the moment that leaks a probe user.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `server-only` THROWS on import outside a React Server Component bundler, which
      // is the whole point of it in production. That also made lib/supabase/server.ts
      // impossible to import from a test, and it shipped with zero coverage while
      // getUser() contradicted its own declared return type. Aliasing it to a stub keeps
      // the production boundary intact and lets the suite exercise the module.
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only-stub.ts", import.meta.url)),
    },
  },
});
