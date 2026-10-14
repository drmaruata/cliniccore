/**
 * Two jobs:
 *  1. Cover `cn`, the helper every component task depends on.
 *  2. Act as the canary for vitest's `include` glob. Before I4 this file was a
 *     `.tsx` test that vitest never matched — `npm test` reported success while
 *     silently skipping it. If this file stops running, the glob regressed.
 *  3. Pin this repo to ONE merge engine. See the single-engine test below.
 *
 * (Three, since the tripwire was added in review. The numbering was left alone
 * deliberately — the "Two jobs" line is referenced from the Task 1 report.)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils/cn";
import { stripComments } from "@/scripts/check-no-secrets";

function Badge({ className, tone }: { className?: string; tone: "neutral" | "danger" }) {
  return (
    <span className={cn("px-2 py-1", tone === "danger" && "bg-red-500", className)}>{tone}</span>
  );
}

describe("cn", () => {
  it("runs in a DOM environment", () => {
    expect(typeof document).toBe("object");
    expect(typeof window).toBe("object");
  });

  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("lets the later conflicting Tailwind utility win", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", { "text-blue-500": true })).toBe("text-blue-500");
  });

  it("drops falsy conditional classes", () => {
    expect(cn("p-2", false && "hidden", null, undefined, "m-1")).toBe("p-2 m-1");
  });

  it("renders a component that uses it", () => {
    const html = renderToStaticMarkup(<Badge tone="danger" className="rounded" />);
    expect(html).toContain("bg-red-500");
    expect(html).toContain("rounded");
    expect(html).not.toContain("undefined");
  });
});

/**
 * The repo has exactly one class-merge engine, and every UI file imports it from
 * `@/lib/utils/cn`.
 *
 * WHY THIS IS ASSERTED. `shadcn@latest init` with the `radix-nova` style emits
 * `import { cn } from "cn"` into `components/ui/*.tsx` — a DIFFERENT npm package
 * whose default engine does not know this project's custom theme colours
 * (`success`, `accent`, `secondary`, ...). It therefore cannot collapse
 * `bg-primary` against `bg-success` and leaves both on the element, which is the
 * defect `StatusBadge` hit: the badge's colour was decided by CSS source order
 * rather than by the class. `tailwind-merge`, which `@/lib/utils/cn` wraps, has
 * no such gap.
 *
 * `components.json` sets `"aliases": { "utils": "@/lib/utils/cn" }`. That is NOT
 * a defence and is deliberately not cited as one anywhere: the CLI emitted
 * `from "cn"` in spite of it.
 *
 * A later `shadcn add` re-emits that import and re-adds the dependency. The
 * import half is also covered by an `no-restricted-imports` rule in
 * eslint.config.mjs, so it fails at lint time rather than here; the dependency
 * half is only observable from this file, which is why it is asserted here.
 */
describe("cn is the only merge engine", () => {
  function repoRoot(): string {
    let dir = resolve(process.cwd());
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "app", "globals.css"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`could not locate the repository root from ${process.cwd()}`);
  }

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /*
   * Deliberately wider than `from "cn"`.
   *
   * The original pattern was exact-double-quote and would have missed every one
   * of these: `from 'cn'`, `from "cn/index"`, `require("cn")`, and a bare
   * side-effect `import "cn"`. Each resolves to the same npm package, so each
   * reintroduces the same defect. The eslint rule covers the common shapes; this
   * is the backstop that does not care about quote style or entry point.
   */
  const BARE_CN_IMPORT =
    /(?:from\s*|import\s*|require\s*\(\s*)["']cn(?:\/[^"']*)?["']|\bimport\s+["']cn(?:\/[^"']*)?["']/g;

  it("no file under app/ or components/ imports cn from the bare 'cn' package", () => {
    const root = repoRoot();
    const offenders = [...sources(join(root, "app")), ...sources(join(root, "components"))]
      .filter((file) => {
        BARE_CN_IMPORT.lastIndex = 0;
        return BARE_CN_IMPORT.test(stripComments(readFileSync(file, "utf8")));
      })
      .map((file) => file.slice(root.length + 1).replace(/\\/g, "/"));

    expect(
      offenders,
      `${offenders.join(", ")} import cn from the npm 'cn' package instead of @/lib/utils/cn`,
    ).toEqual([]);
  });

  it("the pattern this test uses would actually catch every spelling of the import", () => {
    // Negative controls. A widened regex that never matches is the same as no
    // regex at all.
    const caught = [
      'import { cn } from "cn"',
      "import { cn } from 'cn'",
      'import { cn } from "cn/index"',
      'const { cn } = require("cn")',
      'import "cn"',
      'import { cn } from "cn/tables"',
    ];
    for (const source of caught) {
      BARE_CN_IMPORT.lastIndex = 0;
      expect(BARE_CN_IMPORT.test(source), source).toBe(true);
    }

    const allowed = [
      'import { cn } from "@/lib/utils/cn"',
      'import { clsx } from "clsx"',
      'import { cva } from "class-variance-authority"',
      // The word "cn" inside an identifier or a path must not match.
      'import { config } from "./cn"',
      'const cname = "cn"',
    ];
    for (const source of allowed) {
      BARE_CN_IMPORT.lastIndex = 0;
      expect(BARE_CN_IMPORT.test(source), source).toBe(false);
    }
  });

  it("package.json does not depend on the npm 'cn' package", () => {
    // The other half of the failure mode. Even if every import were repointed,
    // a dependency entry left behind means the next `shadcn add` finds the
    // package already resolvable and silently uses it.
    const manifest = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("cn");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("cn");
  });
});
