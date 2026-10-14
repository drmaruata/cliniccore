import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  check,
  extractImportSpecifiers,
  findServerModuleImports,
  findViolations,
  isAllowedServiceRolePath,
  isClientFile,
  normalizePath,
  resolveImportSpecifier,
  resolvesIntoServerModule,
  run,
  stripComments,
} from "../../scripts/check-no-secrets";

const tempRoots: string[] = [];

/** Build a throwaway repo tree and run the real filesystem walk over it. */
function runOnTempTree(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "cliniccore-gate-"));
  tempRoots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return run(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("check-no-secrets gate", () => {
  it("rejects a service role key reference in app/ (brief Step 4 case 1)", () => {
    expect(check([["app/page.tsx", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY"]])).toBe(
      false,
    );
  });

  it("accepts a service role key reference in lib/supabase/server.ts (brief Step 4 case 2)", () => {
    expect(check([["lib/supabase/server.ts", "process.env.SUPABASE_SERVICE_ROLE_KEY"]])).toBe(true);
  });

  it("accepts references under tests/", () => {
    expect(
      check([["tests/unit/supabase-server.test.ts", "process.env.SUPABASE_SERVICE_ROLE_KEY"]]),
    ).toBe(true);
  });

  it("rejects a client component even in an allowed path", () => {
    expect(
      check([["lib/supabase/server.ts", '"use client"\nprocess.env.SUPABASE_SERVICE_ROLE_KEY']]),
    ).toBe(false);
  });

  it("rejects a client component anywhere", () => {
    expect(
      check([["components/Nav.tsx", '"use client"\nprocess.env.SUPABASE_SERVICE_ROLE_KEY']]),
    ).toBe(false);
  });

  it("accepts an empty file list", () => {
    expect(check([])).toBe(true);
  });

  it("accepts a repo with no secret references", () => {
    expect(
      check([
        ["app/page.tsx", "export default function Page() { return null; }"],
        ["lib/utils/cn.ts", "return twMerge(clsx(inputs));"],
        ["components/ui/Button.tsx", "import { cn } from '@/lib/utils/cn';"],
      ]),
    ).toBe(true);
  });

  it("flags hard-coded sb_secret keys and JWTs", () => {
    expect(check([["lib/supabase/server.ts", 'const k = "sb_secret_abcdef1234567890";']])).toBe(
      false,
    );
    expect(
      check([
        [
          "lib/supabase/server.ts",
          'const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig";',
        ],
      ]),
    ).toBe(false);
  });

  it("allows documented placeholders like sb_secret_replace_me", () => {
    expect(check([["lib/supabase/server.ts", 'const k = "sb_secret_replace_me";']])).toBe(true);
  });

  it("exempts tests/ from rule 4 only, so adversarial fixtures can exist", () => {
    // allowed: the gate's own tests must be able to embed a bad-looking literal
    expect(check([["tests/unit/x.test.ts", 'const k = "sb_secret_abcdef1234567890";']])).toBe(true);
    // still enforced everywhere else
    expect(check([["app/x.ts", 'const k = "sb_secret_abcdef1234567890";']])).toBe(false);
    expect(
      check([
        ["lib/x.ts", 'const j = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig";'],
      ]),
    ).toBe(false);
    // rules 1 and 2 stay enforced under tests/
    expect(
      check([["tests/unit/x.test.ts", '"use client";\nprocess.env.SUPABASE_SERVICE_ROLE_KEY;']]),
    ).toBe(false);
    // rule 3 stays enforced under tests/
    expect(
      check([["tests/unit/x.test.tsx", '"use client";\nimport a from "@/lib/supabase/server";']]),
    ).toBe(false);
  });

  it("ignores the env var name when it appears only in comments", () => {
    expect(check([["app/page.tsx", "// SUPABASE_SERVICE_ROLE_KEY is server-only"]])).toBe(true);
    expect(check([["lib/utils/cn.ts", "/* never read SUPABASE_SERVICE_ROLE_KEY here */"]])).toBe(
      true,
    );
    expect(
      check([
        [
          "components/ui/Button.tsx",
          "/**\n * SUPABASE_SERVICE_ROLE_KEY is forbidden here.\n */\nexport const Button = () => null;",
        ],
      ]),
    ).toBe(true);
  });

  it("still flags the env var name used as code after a comment on the same line", () => {
    expect(
      check([
        ["app/page.tsx", "// documented below\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;"],
      ]),
    ).toBe(false);
  });

  it("preserves string literals while stripping comments, so // inside a string survives", () => {
    const source = 'const url = "https://x/y"; // SUPABASE_SERVICE_ROLE_KEY\nconst n = 1;';
    const stripped = stripComments(source);
    expect(stripped).toContain('"https://x/y"');
    expect(stripped).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(stripped).toContain("const n = 1;");
  });

  it("normalises windows separators and leading ./", () => {
    expect(isAllowedServiceRolePath(".\\lib\\supabase\\server.ts")).toBe(true);
    expect(isAllowedServiceRolePath("./tests/unit/a.test.ts")).toBe(true);
    expect(isAllowedServiceRolePath("lib/supabase/server.ts.bak")).toBe(false);
    expect(isAllowedServiceRolePath("tests")).toBe(false);
  });

  it("detects the client directive only at the top of the file", () => {
    expect(isClientFile('"use client";\nexport const a = 1;')).toBe(true);
    expect(isClientFile('// leading comment\n"use client";\nexport const a = 1;')).toBe(true);
    expect(isClientFile('/* block */\n\n"use client";')).toBe(true);
    // "use strict" occupies the directive slot, so "use client" is not a directive.
    expect(isClientFile('"use strict";\n"use client";')).toBe(false);
    expect(isClientFile('const directive = "use client";')).toBe(false);
  });

  it("reports actionable reasons", () => {
    const violations = findViolations({
      path: "components/Widget.tsx",
      contents: "process.env.SUPABASE_SERVICE_ROLE_KEY",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("is clean against the real repository tree", () => {
    expect(run(process.cwd())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 3 — "use client" must never import lib/supabase/               */
/* ------------------------------------------------------------------ */

describe("rule 3: client components importing the server module", () => {
  const LEAK = '"use client";\nimport { adminClient } from "@/lib/supabase/server";';

  it("rejects the canonical Next.js + Supabase client leak", () => {
    expect(check([["components/Dashboard.tsx", LEAK]])).toBe(false);
    const violations = findViolations({ path: "components/Dashboard.tsx", contents: LEAK });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("lib/supabase/");
  });

  it("rejects the alias form @/lib/supabase/...", () => {
    expect(resolvesIntoServerModule("@/lib/supabase/server", "components/Dashboard.tsx")).toBe(
      true,
    );
    expect(resolvesIntoServerModule("@/lib/supabase/admin", "app/page.tsx")).toBe(true);
  });

  it("rejects the repo-root form lib/supabase/...", () => {
    expect(resolvesIntoServerModule("lib/supabase/server", "components/Dashboard.tsx")).toBe(true);
    expect(
      check([["components/x.tsx", '"use client";\nimport x from "lib/supabase/server";']]),
    ).toBe(false);
  });

  it("rejects the relative form ../lib/supabase/...", () => {
    // one level up from components/ lands at the repo root
    expect(resolvesIntoServerModule("../lib/supabase/server", "components/Dashboard.tsx")).toBe(
      true,
    );
    // app/(dash)/settings/ is three levels deep, so it needs three "../"
    expect(
      resolvesIntoServerModule("../../../lib/supabase/server", "app/(dash)/settings/page.tsx"),
    ).toBe(true);
    // two levels up from app/(dash)/settings/ lands in app/, which is NOT the server module
    expect(
      resolvesIntoServerModule("../../lib/supabase/server", "app/(dash)/settings/page.tsx"),
    ).toBe(false);
  });

  it("allows a server file to import lib/supabase/", () => {
    expect(
      check([
        [
          "lib/supabase/server.ts",
          'import "server-only";\nimport { adminClient } from "./client";\nexport default adminClient;',
        ],
      ]),
    ).toBe(true);
  });

  it("allows a client file to import non-server modules and bare packages", () => {
    expect(
      check([
        [
          "components/ui/Button.tsx",
          '"use client";\nimport { cn } from "@/lib/utils/cn";\nimport { createClient } from "@supabase/supabase-js";\nimport clsx from "clsx";\nimport "server-only-not";\nexport const B = () => cn("p-2");',
        ],
      ]),
    ).toBe(true);
  });

  it("does not flag a commented-out import", () => {
    expect(
      check([
        [
          "components/Widget.tsx",
          '"use client";\n// import { admin } from "@/lib/supabase/server";',
        ],
      ]),
    ).toBe(true);
  });

  it("detects dynamic import and require forms", () => {
    const violations = findViolations({
      path: "components/Widget.tsx",
      contents:
        '"use client";\nconst m = await import("@/lib/supabase/server");\nconst r = require("@/lib/supabase/admin");',
    });
    expect(violations).toHaveLength(2);
  });

  it("extracts specifiers from side-effect, default, named and type imports", () => {
    const specifiers = extractImportSpecifiers(
      'import "server-only";\nimport x from "@/lib/a";\nimport { y } from "@/lib/b";\nimport type { Z } from "@/lib/c";\nexport { q } from "@/lib/d";',
    );
    expect(specifiers.sort()).toEqual(["@/lib/a", "@/lib/b", "@/lib/c", "@/lib/d", "server-only"]);
  });

  it("reports the offending specifier for the importing file", () => {
    expect(
      findServerModuleImports({
        path: "components/Dashboard.tsx",
        contents: '"use client";\nimport { adminClient } from "@/lib/supabase/server";',
      }),
    ).toEqual(["@/lib/supabase/server"]);
  });

  it("resolves bare package specifiers to null", () => {
    expect(resolveImportSpecifier("next/navigation", "app/page.tsx")).toBeNull();
    expect(resolveImportSpecifier("clsx", "lib/utils/cn.ts")).toBeNull();
    expect(resolveImportSpecifier("@supabase/ssr", "lib/supabase/server.ts")).toBeNull();
  });

  it("normalises . and .. segments", () => {
    expect(normalizePath("./a/b/../c")).toBe("a/c");
    expect(normalizePath("a\\b\\c")).toBe("a/b/c");
    expect(normalizePath("app/foo/../../lib/supabase/server")).toBe("lib/supabase/server");
  });
});

/* ------------------------------------------------------------------ */
/* run() — the filesystem walk, including its failing path (I1)         */
/* ------------------------------------------------------------------ */

describe("run(): filesystem walk", () => {
  it("flags a service role reference in app/ (failing path)", () => {
    const violations = runOnTempTree({
      "app/page.tsx": "export const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("app/page.tsx");
    expect(violations[0]).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("flags a root-level middleware.ts, which no app/-scoped walk would see", () => {
    const violations = runOnTempTree({
      "middleware.ts": "export const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("middleware.ts");
  });

  it("flags a nested source file outside app/, components/, lib/, scripts/", () => {
    const violations = runOnTempTree({
      "instrumentation.ts": "const k = 1; SUPABASE_SERVICE_ROLE_KEY;",
    });
    expect(violations).toHaveLength(1);
  });

  it("flags a client component importing lib/supabase/ (failing path, rule 3)", () => {
    const violations = runOnTempTree({
      "components/Dashboard.tsx":
        '"use client";\nimport { adminClient } from "@/lib/supabase/server";\nexport const D = () => adminClient;',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("lib/supabase/");
  });

  it("allows the service role in lib/supabase/server.ts and under tests/", () => {
    expect(
      runOnTempTree({
        "lib/supabase/server.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
        "tests/unit/server.test.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
      }),
    ).toEqual([]);
  });

  it("returns no violations for a clean tree", () => {
    expect(
      runOnTempTree({
        "app/page.tsx": "export default function Page() { return null; }",
        "lib/utils/cn.ts": "export function cn(...i: unknown[]) { return i.join(' '); }",
        "components/ui/Button.tsx": "import { cn } from '@/lib/utils/cn';",
        "scripts/build.ts": "console.log('build');",
      }),
    ).toEqual([]);
  });

  it("skips the gate's own source file, which names the env var by necessity", () => {
    expect(
      runOnTempTree({ "scripts/check-no-secrets.ts": "const x = 'SUPABASE_SERVICE_ROLE_KEY';" }),
    ).toEqual([]);
  });

  it("does not descend into node_modules or dot-directories", () => {
    expect(
      runOnTempTree({
        "node_modules/pkg/index.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
        ".next/types/route.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
        "app/page.tsx": "export const ok = 1;",
      }),
    ).toEqual([]);
  });

  it("reports several violations from one walk", () => {
    const violations = runOnTempTree({
      "app/a.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
      "components/b.tsx": '"use client";\nimport { admin } from "@/lib/supabase/server";',
      "lib/ok.ts": "export const ok = 1;",
    });
    expect(violations).toHaveLength(2);
  });
});
