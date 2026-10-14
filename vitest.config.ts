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
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
