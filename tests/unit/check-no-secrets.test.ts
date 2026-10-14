import { execFileSync } from "node:child_process";
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
  isScannableFileName,
  isSourceFilePath,
  normalizePath,
  resolveImportSpecifier,
  resolvesIntoServerModule,
  run,
  stripComments,
} from "../../scripts/check-no-secrets";

const tempRoots: string[] = [];

/*
 * RULE 4 FIXTURES ARE BUILT AT RUNTIME — READ THIS BEFORE EDITING.
 *
 * Rule 4 is the only rule that catches a hard-coded credential, so it has no
 * path-based exemption: it scans `tests/` exactly as it scans `app/`. An earlier
 * revision exempted `tests/` wholesale so these fixtures could be literals, and
 * that exemption was removed because it disabled credential detection across
 * every test file for the life of the project — and test fixtures are precisely
 * where real payloads get pasted in by accident.
 *
 * So the credential-shaped strings below are assembled at runtime. Specifically:
 * `FAKE_SECRET_KEY`, `FAKE_JWT` and everything derived from them exist in no
 * tracked file as literals — that is what lets the "is clean against the real
 * repository tree" test below stay meaningful.
 *
 * This is NOT a claim about every secret-shaped string in the tree. The inert
 * placeholder `sb_secret_replace_me` does appear verbatim in tracked files —
 * `.env.example`, `scripts/check-no-secrets.ts`, this file, and the plan
 * document. It is a marker, not a credential, and it is what
 * `PLACEHOLDER_ALLOWLIST` exists to permit.
 *
 * If you add a new rule-4 case, build the literal this way too.
 *
 * Asserted by: "flags a hard-coded secret inside tests/ — no exemption".
 */
const FAKE_SECRET_KEY = `${["sb", "secret"].join("_")}_abcdef1234567890`;
const FAKE_JWT_HEADER = ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"].join("");
const FAKE_JWT_PAYLOAD = ["eyJ", "zdWIiOiIxIn0"].join("");
const FAKE_JWT = `${FAKE_JWT_HEADER}.${FAKE_JWT_PAYLOAD}.sig`;

/** A source line embedding the fake key, ready to drop into a fixture. */
const srcWithKey = `const k = "${FAKE_SECRET_KEY}";`;
/** A source line embedding the fake JWT, ready to drop into a fixture. */
const srcWithJwt = `const jwt = "${FAKE_JWT}";`;

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
    expect(check([["lib/supabase/server.ts", srcWithKey]])).toBe(false);
    expect(check([["lib/supabase/server.ts", srcWithJwt]])).toBe(false);
  });

  it("allows documented placeholders like sb_secret_replace_me", () => {
    // Deliberately a literal: this test asserts the PLACEHOLDER_ALLOWLIST, and
    // fragmenting it would make the assertion meaningless. It is still not a
    // real credential — `replace_me` is the documented inert placeholder.
    expect(check([["lib/supabase/server.ts", 'const k = "sb_secret_replace_me";']])).toBe(true);
  });

  it("flags a hard-coded secret inside tests/ — no exemption", () => {
    // Regression guard. Rule 4 once skipped every path under tests/, which
    // silently disabled the only rule that detects a pasted credential.
    const violations = findViolations({
      path: "tests/unit/fixtures/real-payload.test.ts",
      contents: srcWithKey,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("Supabase secret key");
    expect(check([["tests/unit/x.test.ts", srcWithKey]])).toBe(false);
    expect(check([["tests/unit/x.test.ts", srcWithJwt]])).toBe(false);
    expect(check([["tests/integration/y.test.ts", srcWithKey]])).toBe(false);
    expect(check([["tests/e2e/z.test.ts", srcWithJwt]])).toBe(false);
    // and still enforced everywhere else
    expect(check([["app/x.ts", srcWithKey]])).toBe(false);
    expect(check([["lib/x.ts", srcWithJwt]])).toBe(false);
  });

  it("keeps rules 1, 2 and 3 enforced under tests/", () => {
    // rules 1 and 2
    expect(
      check([["tests/unit/x.test.ts", '"use client";\nprocess.env.SUPABASE_SERVICE_ROLE_KEY;']]),
    ).toBe(false);
    // rule 3
    expect(
      check([["tests/unit/x.test.tsx", '"use client";\nimport a from "@/lib/supabase/server";']]),
    ).toBe(false);
    // rule 1's path allowance is unchanged: naming the env var under tests/ is fine
    expect(check([["tests/unit/x.test.ts", "process.env.SUPABASE_SERVICE_ROLE_KEY;"]])).toBe(true);
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

  it("still flags the env var name used as code on a line after a comment", () => {
    expect(
      check([
        ["app/page.tsx", "// documented below\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;"],
      ]),
    ).toBe(false);
    // a comment on the SAME line as real code does not hide the code either
    expect(
      check([["app/page.tsx", "const k = process.env.SUPABASE_SERVICE_ROLE_KEY; // used here"]]),
    ).toBe(false);
    // a comment preceding a name-only mention is still only a comment
    expect(check([["app/page.tsx", "// SUPABASE_SERVICE_ROLE_KEY\nconst k = 1;"]])).toBe(true);
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
    // NOTE: this pins the rule 1 PATH allowance only. It cannot detect a
    // walk-layer `if (rel.startsWith("tests/")) continue;`, because skipping the
    // file also yields []. Walk coverage of tests/ is pinned by the two tests
    // below, which put a *violating* file under tests/ and require it to be found.
    expect(
      runOnTempTree({
        "lib/supabase/server.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
        "tests/unit/server.test.ts": "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;",
      }),
    ).toEqual([]);
  });

  it("flags a hard-coded secret under tests/ during the walk — no walk-layer exemption", () => {
    // Regression guard for the WALK layer. The round-2 guard exercised
    // findViolations(), which only pins the detection layer; a per-path
    // `continue` added next to the SELF_PATH skip in run() disables rule 4 for
    // every test file while that guard stays green, because the fixtures are
    // runtime-built and the real tree is genuinely clean.
    const violations = runOnTempTree({
      "tests/unit/fixtures/pasted.test.ts": srcWithKey,
      "app/page.tsx": "export default function Page() { return null; }",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("tests/unit/fixtures/pasted.test.ts");
    expect(violations[0]).toContain("Supabase secret key");
  });

  it("the walk reads tests/ files at all — a rule 3 leak there is found", () => {
    // Second, independent pin on the walk layer: a rule 3 violation under tests/
    // must be reported, which can only happen if the file was actually read.
    const violations = runOnTempTree({
      "tests/unit/component.test.tsx":
        '"use client";\nimport { adminClient } from "@/lib/supabase/server";',
      "app/page.tsx": "export default function Page() { return null; }",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("tests/unit/component.test.tsx");
    expect(violations[0]).toContain("lib/supabase/");
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

/* ------------------------------------------------------------------ */
/* Walk scope — .env* dot-files and .sql migrations                    */
/* ------------------------------------------------------------------ */

/**
 * A realistic-but-inert `.env.example`, shaped like the tracked template: a
 * comment header, an empty anon key, and the `replace_me` service-role marker.
 * `serviceRoleValue` is swapped for a runtime-built key by the tests that need
 * to prove the gate actually fails.
 */
function envExample(serviceRoleValue: string): string {
  return [
    "# ClinicCore environment template.",
    "",
    "NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=",
    "",
    "# SERVER ONLY. Never prefix with NEXT_PUBLIC_.",
    `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleValue}`,
    "",
    "SUPABASE_PROJECT_REF=replace_me",
    "",
  ].join("\n");
}

describe("walk scope: .env* files and .sql migrations", () => {
  it("flags a credential pasted into .env.example — the file the old walk skipped", () => {
    // The incident this exists for: a real service-role key in the tracked
    // template produced ZERO violations, because collectFiles dropped every
    // dot-prefixed entry. `.env.example` is a tracked file, so it must be read.
    const violations = runOnTempTree({
      ".env.example": envExample(FAKE_SECRET_KEY),
      "app/page.tsx": "export default function Page() { return null; }",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(".env.example");
    expect(violations[0]).toContain("Supabase secret key");
  });

  it("flags a hard-coded JWT pasted into .env.example", () => {
    const violations = runOnTempTree({
      ".env.example": `NEXT_PUBLIC_SUPABASE_ANON_KEY=${FAKE_JWT}\n`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("hard-coded JWT");
  });

  it("keeps .env.example green because its values are inert, not because it is exempt", () => {
    // Same file, same walk, no exemption — only the value differs. An empty
    // anon key and the replace_me marker match no rule-4 pattern.
    expect(runOnTempTree({ ".env.example": envExample("sb_secret_replace_me") })).toEqual([]);
  });

  it("flags a credential pasted into a .sql migration", () => {
    const violations = runOnTempTree({
      "supabase/migrations/20261014000000_init.sql":
        "-- bootstrap\ninsert into app_settings (name, value)\n" +
        `values ('service_role', '${FAKE_SECRET_KEY}');\n`,
      "app/page.tsx": "export default function Page() { return null; }",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("supabase/migrations/20261014000000_init.sql");
    expect(violations[0]).toContain("Supabase secret key");
  });

  it("does not apply the code rules to .env or .sql files", () => {
    expect(isSourceFilePath(".env.example")).toBe(false);
    expect(isSourceFilePath("supabase/migrations/20261014000000_init.sql")).toBe(false);
    expect(isSourceFilePath("app/page.tsx")).toBe(true);
    // Naming the env var is what an env template and a migration comment are
    // FOR. Rule 4 is the rule that catches a pasted key, and it still runs.
    expect(check([[".env.example", "SUPABASE_SERVICE_ROLE_KEY=sb_secret_replace_me\n"]])).toBe(
      true,
    );
    expect(
      check([
        [
          "supabase/migrations/20261014000000_init.sql",
          "-- SUPABASE_SERVICE_ROLE_KEY is injected by the platform, never stored.\ncreate table t (id int);\n",
        ],
      ]),
    ).toBe(true);
  });

  it("rule 4 still fires on an env assignment line — only rules 1-3 are skipped", () => {
    const violations = findViolations({
      path: ".env.example",
      contents: `SUPABASE_SERVICE_ROLE_KEY=${FAKE_SECRET_KEY}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\n`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("Supabase secret key");
  });

  it("skips the gitignored .env* variants, which cannot be committed", () => {
    // Deliberate, and the reason is threat model rather than convenience: this
    // repo's .gitignore is `.env*` + `!.env.example`, so these files cannot be
    // committed without `git add -f`. They are also where real credentials are
    // SUPPOSED to live — scanning them would make the gate permanently red in
    // every correct checkout. Verified against git by the test below.
    const violations = runOnTempTree({
      ".env.local": envExample(FAKE_SECRET_KEY),
      ".env.production": envExample(FAKE_SECRET_KEY),
      ".env.test": envExample(FAKE_SECRET_KEY),
      "app/page.tsx": "export default function Page() { return null; }",
    });
    expect(violations).toEqual([]);
    // and the walk still reads the one env file that IS tracked
    expect(
      runOnTempTree({
        ".env.local": envExample(FAKE_SECRET_KEY),
        ".env.example": envExample(FAKE_SECRET_KEY),
      }),
    ).toHaveLength(1);
  });

  it("still ignores other dot-files and other extensions", () => {
    expect(isScannableFileName(".env.example")).toBe(true);
    expect(isScannableFileName(".env.local")).toBe(false);
    expect(isScannableFileName(".env.production")).toBe(false);
    expect(isScannableFileName(".git")).toBe(false);
    expect(isScannableFileName("app/page.tsx")).toBe(true);
    expect(isScannableFileName("supabase/migrations/0001_init.sql")).toBe(true);
    // explicitly NOT widened: prose and data files carry illustrative
    // credentials in this repo and would be permanent false positives.
    expect(isScannableFileName("docs/superpowers/plans/2026-10-14-cliniccore-foundation.md")).toBe(
      false,
    );
    expect(isScannableFileName("package.json")).toBe(false);
    expect(isScannableFileName("tsconfig.json")).toBe(false);
    expect(isScannableFileName(".github/workflows/ci.yml")).toBe(false);
  });
});

/** Env-file names used to cross-check the walk exclusion against real git. */
const GIT_PROBE_ENV_FILES = [
  ".env.local",
  ".env.production",
  ".env.staging.local",
  ".env.development",
  ".env.test",
  ".envrc",
  ".env.example",
];

/**
 * True only when `git check-ignore` can actually answer in this directory.
 *
 * `git --version` alone is not enough: outside a checkout `check-ignore` exits
 * 128 and `execFileSync` throws, so the test would hard-fail during collection
 * instead of skipping. `--is-inside-work-tree` is the cheapest honest probe.
 */
function gitAvailable(): boolean {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

describe.skipIf(!gitAvailable())("the .env* walk exclusion matches real git behaviour", () => {
  it("skips every env file git ignores and reads every one git does not", () => {
    const stdout = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: process.cwd(),
      input: GIT_PROBE_ENV_FILES.join("\n") + "\n",
      encoding: "utf8",
    });
    const ignored = new Set(stdout.split(/\r?\n/).filter(Boolean));

    for (const name of GIT_PROBE_ENV_FILES) {
      // If git ignores it, it cannot be committed, so the walk must skip it.
      // If git tracks it, the walk must read it. Any divergence between the
      // constant in scripts/check-no-secrets.ts and the real .gitignore shows
      // up here as a failing assertion instead of a silently blind gate.
      expect(isScannableFileName(name)).toBe(!ignored.has(name));
    }

    // Spelled out so the intent survives a future edit that makes the loop vacuous.
    expect(ignored.has(".env.local")).toBe(true);
    expect(ignored.has(".env.production")).toBe(true);
    expect(ignored.has(".env.example")).toBe(false);
    expect(isScannableFileName(".env.example")).toBe(true);
  });
});
