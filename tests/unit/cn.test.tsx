/**
 * Two jobs:
 *  1. Cover `cn`, the helper every component task depends on.
 *  2. Act as the canary for vitest's `include` glob. Before I4 this file was a
 *     `.tsx` test that vitest never matched — `npm test` reported success while
 *     silently skipping it. If this file stops running, the glob regressed.
 *  3. Pin this repo to ONE merge engine. See the single-engine test below.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils/cn";

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
 * A later `shadcn add` re-emits that import and re-adds the dependency, and
 * nothing about it is a type error or a lint error. This is the tripwire.
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

  it("no file under app/ or components/ imports cn from the bare 'cn' package", () => {
    const root = repoRoot();
    const offenders = [...sources(join(root, "app")), ...sources(join(root, "components"))]
      .filter((file) => /from\s+"cn"/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1).replace(/\\/g, "/"));

    expect(
      offenders,
      `${offenders.join(", ")} import cn from the npm 'cn' package instead of @/lib/utils/cn`,
    ).toEqual([]);
  });
});
