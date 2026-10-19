/**
 * The server/client boundary, enforced rather than described.
 *
 * WHY A TEST AND NOT A COMMENT. `import "server-only"` as the FIRST LINE of
 * `lib/supabase/server.ts` is the only bundle-time defence against a Client Component
 * importing the service-role client. `check-no-secrets` is a BACKSTOP for a different rule
 * - it does not inspect this line - and the comment in that scanner saying the boundary
 * "cannot be bypassed by an alias this scanner does not model" became actively misleading
 * once `vitest.config.ts` grew an alias for that exact specifier.
 *
 * MEASURED, before this file existed: deleting line 1, or moving it below the imports,
 * leaves the ENTIRE suite green - `lint`, `typecheck`, `test` and `build` all pass - while
 * removing the only thing that fails a real client-component build. The re-review separately
 * confirmed the boundary DOES fire when the import is present, by building a route that
 * imports the module from a `"use client"` component and watching `next build` fail. So the
 * import works; nothing was checking that it stayed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

describe("the server boundary", () => {
  it("imports server-only as the very first line of lib/supabase/server.ts", () => {
    // FIRST line, not merely present. A moved import still evaluates, but it reads as a
    // deliberate refactor to anyone skimming, and "deliberate" is how boundaries erode.
    const lines = read("lib", "supabase", "server.ts")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines[0]).toBe(`import "server-only";`);
  });

  it("keeps the service role key out of the browser-reachable module", () => {
    // Checked as USAGE, not as a bare string. A first pass asserted the file does not
    // contain the key NAME at all and failed - because the module's own doc comment says
    // the key must never appear there. Matching the bare name would have made the test
    // permanently red, or worse, pushed someone to delete the warning that helps.
    const client = read("lib", "supabase", "client.ts");
    expect(client).not.toContain("process.env.SUPABASE_SERVICE_ROLE_KEY");
    // ...and it must not reach the server module to get it either.
    expect(client).not.toContain("supabase/server");
    expect(client).not.toContain("./server");
  });

  it("does not let the vitest server-only alias reach application code", () => {
    // The alias exists so tests can import the module. It lives in vitest.config.ts,
    // which nothing but the vitest binary reads - next.config.ts, tsconfig.json,
    // eslint.config.mjs and playwright.config.ts must not reference it, or a production
    // build could resolve `server-only` to an empty stub.
    for (const file of ["next.config.ts", "tsconfig.json", "eslint.config.mjs"]) {
      const contents = read(file);
      expect(contents.includes("server-only-stub"), `${file} must not alias server-only`).toBe(
        false,
      );
      expect(contents.includes('"server-only"'), `${file} must not alias server-only`).toBe(false);
    }
  });

  it("the alias target is an inert stub, not a re-implementation of the boundary", () => {
    const stub = read("tests", "helpers", "server-only-stub.ts");
    expect(stub.trim().endsWith("export {};")).toBe(true);
  });
});
