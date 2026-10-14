/**
 * Two jobs:
 *  1. Cover `cn`, the helper every component task depends on.
 *  2. Act as the canary for vitest's `include` glob. Before I4 this file was a
 *     `.tsx` test that vitest never matched — `npm test` reported success while
 *     silently skipping it. If this file stops running, the glob regressed.
 */
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
