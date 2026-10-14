import { defineConfig, devices } from "@playwright/test";

/**
 * Browser binaries are intentionally NOT installed by this task. Task 15 owns the
 * first E2E spec and runs `npx playwright install` before it.
 *
 * testDir is configured but does not exist yet. Measured: a missing testDir is an
 * ERROR, not a warning — `npx playwright test --list` prints
 * "Error: No tests found" and exits 1. The directory therefore ships as a
 * tracked placeholder so this gate reports "no specs yet" rather than
 * "misconfigured".
 */
const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    // Build once, then serve the production bundle. `npm run dev` would test a
    // different artefact from the one that ships, and would hide build-time
    // breakage (e.g. a client component importing a server module) from Task 15's
    // gate. Set PLAYWRIGHT_BASE_URL to test an already-running server instead.
    command: process.env.PLAYWRIGHT_BASE_URL
      ? "echo 'using external server'"
      : "npm run build && npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
