import { describe, expect, it } from "vitest";

import {
  check,
  findViolations,
  isAllowedServiceRolePath,
  isClientFile,
  run,
} from "../../scripts/check-no-secrets";

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

  it("tolerates the .env.example placeholders inside source comments only if not secret-shaped", () => {
    expect(check([["app/page.tsx", "// SUPABASE_SERVICE_ROLE_KEY is server-only"]])).toBe(false);
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
