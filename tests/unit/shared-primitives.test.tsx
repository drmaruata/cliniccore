/**
 * Smoke and contract tests for the seven shared primitives.
 *
 * These are not snapshot tests. They check the three properties the design
 * system actually promises and that nothing else in the suite covers:
 *
 *   1. every primitive renders in the jsdom environment Task 1 wired up;
 *   2. a primitive's colour reaches the DOM as a TOKEN class, not a value —
 *      in particular that a `StatusBadge` tone actually replaces the
 *      generated `Badge`'s default fill rather than sitting beside it;
 *   3. money is never touched — a pre-formatted string survives byte for byte.
 *
 * The "no hard-coded colour" property is enforced over the whole `components/`
 * tree by tests/unit/design-tokens.test.ts; duplicating a per-file check here
 * would only add a second place for it to drift.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { Skeleton, SkeletonRows } from "@/components/shared/skeleton";
import { StatusBadge, type StatusTone } from "@/components/shared/status-badge";

interface Patient {
  id: string;
  name: string;
  balance: string;
}

const PATIENTS: Patient[] = [
  { id: "p1", name: "Ada Okafor", balance: "120.50" },
  { id: "p2", name: "Rune Vik", balance: "0.00" },
];

const COLUMNS: DataTableColumn<Patient>[] = [
  { key: "name", header: "Patient", cell: (row) => row.name },
  { key: "balance", header: "Balance", align: "right", cell: (row) => row.balance },
];

interface Mounted {
  container: HTMLElement;
  root: Root;
}

let mounted: Mounted | null = null;

/** Mount into jsdom so the Radix portal in ConfirmDialog actually renders. */
function mount(node: React.ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted = { container, root };
  return mounted;
}

afterEach(() => {
  if (mounted !== null) {
    act(() => {
      mounted?.root.unmount();
    });
    mounted?.container.remove();
    mounted = null;
  }
});

describe("PageHeader", () => {
  it("renders the title as the page h1, coloured by the navy brand token", () => {
    const html = renderToStaticMarkup(<PageHeader title="Patients" description="All tenants" />);
    expect(html).toContain("<h1");
    expect(html).toContain("Patients");
    expect(html).toContain("All tenants");
    expect(html).toContain("text-brand-navy");
  });

  it("renders an actions slot only when actions are supplied", () => {
    const withoutActions = renderToStaticMarkup(<PageHeader title="Patients" />);
    const withActions = renderToStaticMarkup(
      <PageHeader title="Patients" actions={<button>Add</button>} />,
    );

    expect(withoutActions).not.toContain('data-slot="page-header-actions"');
    expect(withoutActions).not.toContain("sm:flex-row");
    expect(withoutActions).toContain("Patients"); // the title is still there

    expect(withActions).toContain('data-slot="page-header-actions"');
    expect(withActions).toContain("sm:flex-row");
    expect(withActions).toContain("Add");
  });

  it("renders the title as the h1 whether or not actions were supplied", () => {
    // Guards the assertion above: the h1 belongs to `title`, not to the
    // actions slot, so "no actions" must never be observable as "no heading".
    expect(renderToStaticMarkup(<PageHeader title="Patients" />)).toContain("<h1");
  });
});

describe("EmptyState", () => {
  it("renders icon, copy and action", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No patients yet"
        description="Add the first patient to get started"
        action={<span>Add patient</span>}
      />,
    );
    expect(html).toContain("No patients yet");
    expect(html).toContain("Add the first patient to get started");
    expect(html).toContain("Add patient");
    // Decorative: the icon well is hidden from assistive tech.
    expect(html).toContain('aria-hidden="true"');
    // Quiet surface, per the component's documented rule.
    expect(html).toContain("bg-muted");
  });
});

describe("StatusBadge", () => {
  const tones: StatusTone[] = ["success", "danger", "info", "pending", "neutral"];

  const TONE_NAMES = "primary|success|destructive|secondary|accent|muted";

  /**
   * Colour utilities that apply to the element UNCONDITIONALLY.
   *
   * A bare `bg-*` / `text-*` token is one the element always wears; anything
   * carrying a variant prefix (`hover:`, `dark:`, `[a]:hover:`, `aria-…:`) is a
   * separate rule under a separate state and cannot collide with it. Matching
   * whole tokens rather than substrings is what keeps
   * `[a]:hover:bg-primary/80` — a legitimate hover fill the generated Badge
   * ships — from being counted as a second unconditional background.
   */
  function unconditionalColourClasses(
    html: string,
    prefix: "bg" | "text",
    suffix: string,
  ): string[] {
    const tokens = (html.match(/class="[^"]*"/g) ?? []).flatMap((attr) =>
      attr.slice('class="'.length, -1).split(/\s+/),
    );
    const pattern = new RegExp(`^${prefix}-(${TONE_NAMES})${suffix}$`);
    return tokens.filter((token) => pattern.test(token));
  }

  it.each(tones)("renders the %s tone and replaces the generated default fill", (tone) => {
    const html = renderToStaticMarkup(<StatusBadge label="Paid" tone={tone} />);
    expect(html).toContain("Paid");

    // The generated Badge defaults to bg-primary / text-primary-foreground.
    // If the tone class is merged in rather than laid beside it, exactly one
    // background and one foreground colour class must survive.
    //
    // This is the assertion that caught a second merge engine in the tree: the
    // generated Badge was importing `cn` from the npm `cn` package, whose engine
    // does not know this project's custom theme colours and so left `bg-primary`
    // on the element beside `bg-success`. Two bare `bg-*` tokens means CSS
    // source order, not the class, decides the colour.
    expect(unconditionalColourClasses(html, "bg", "")).toHaveLength(1);
    expect(unconditionalColourClasses(html, "text", "-foreground")).toHaveLength(1);
  });

  it.each(tones)("does not leave the generated primary fill behind on the %s tone", (tone) => {
    // Named separately from the count above so the failure message says which
    // colour actually survived, rather than only that two things did.
    const html = renderToStaticMarkup(<StatusBadge label="Paid" tone={tone} />);
    expect(unconditionalColourClasses(html, "bg", "")).not.toContain("bg-primary");
  });

  it("keeps the generated hover fill, which is a state rule and not a conflict", () => {
    // The counterpart to the assertions above: a state-scoped utility on the
    // same element is not the bug, and the check must not be so blunt that
    // fixing it would mean deleting legitimate generated styling.
    expect(renderToStaticMarkup(<StatusBadge label="Paid" tone="success" />)).toContain(
      "[a]:hover:bg-primary/80",
    );
  });

  it("defaults to the neutral tone so an unlabelled status implies nothing", () => {
    const html = renderToStaticMarkup(<StatusBadge label="Draft" />);
    expect(html).toContain("bg-muted");
    expect(html).toContain('data-tone="neutral"');
  });
});

describe("KpiCard", () => {
  it("renders a pre-formatted money string byte for byte and never parses it", () => {
    const html = renderToStaticMarkup(
      <KpiCard label="Outstanding" value="120.50" delta={{ direction: "down", label: "-3.1%" }} />,
    );
    expect(html).toContain("120.50");
    expect(html).toContain("Outstanding");
    expect(html).toContain("-3.1%");
    expect(html).toContain('data-direction="down"');
  });

  it("colours the delta with the on-surface ink tokens, never the raw brand", () => {
    const html = renderToStaticMarkup(
      <KpiCard label="Collected" value="9,000.00" delta={{ direction: "up", label: "+12.4%" }} />,
    );
    expect(html).toContain("text-success-ink");
    expect(html).not.toContain("text-brand-success");
  });

  it("treats a flat delta as its own answer", () => {
    const html = renderToStaticMarkup(
      <KpiCard label="Collected" value="0" delta={{ direction: "flat", label: "no change" }} />,
    );
    expect(html).toContain('data-direction="flat"');
    expect(html).toContain("text-muted-foreground");
  });
});

describe("DataTable", () => {
  it("renders one row per record and keys them by getRowKey", () => {
    const html = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={PATIENTS}
        getRowKey={(row) => row.id}
        caption="Patients owing a balance"
      />,
    );
    expect(html.match(/<tr/g) ?? []).toHaveLength(3); // header + 2 data rows
    expect(html).toContain("Ada Okafor");
    expect(html).toContain("120.50");
    expect(html).toContain("Patients owing a balance");
  });

  it("shows the empty state instead of a bare table when the query found nothing", () => {
    const html = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row: Patient) => row.id}
        emptyTitle="No patients"
      />,
    );
    expect(html).toContain("No patients");
    expect(html).not.toContain("<table");
  });

  it("renders skeleton rows while loading and no empty state", () => {
    const html = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row: Patient) => row.id}
        loading
        loadingRows={3}
      />,
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("Nothing here yet");
  });
});

describe("Skeleton", () => {
  it.each(["line", "title", "block", "avatar"] as const)("renders the %s shape", (size) => {
    const html = renderToStaticMarkup(<Skeleton size={size} />);
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain(`data-size="${size}"`);
    // A skeleton is not content; it must stay out of the accessibility tree.
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders the requested number of placeholder rows", () => {
    const html = renderToStaticMarkup(<SkeletonRows count={4} />);
    expect(html.match(/data-slot="skeleton"/g) ?? []).toHaveLength(4);
    expect(html).toContain('aria-hidden="true"');
  });

  it("clamps a negative count to zero rather than throwing", () => {
    expect(renderToStaticMarkup(<SkeletonRows count={-1} />)).not.toContain('data-slot="skeleton"');
  });
});

describe("ConfirmDialog", () => {
  it("mounts, states what is irreversible, and calls onConfirm once", async () => {
    let calls = 0;
    const { container } = mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete Ada Okafor?"
        description="This removes the patient and their appointment history. It cannot be undone."
        confirmLabel="Delete patient"
        tone="destructive"
        onConfirm={() => {
          calls++;
        }}
      />,
    );

    const dialog = container.ownerDocument.body;
    expect(dialog.textContent).toContain("Delete Ada Okafor?");
    expect(dialog.textContent).toContain("It cannot be undone.");

    const confirm = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Delete patient"),
    );
    expect(confirm).toBeDefined();

    await act(async () => {
      confirm?.click();
    });
    expect(calls).toBe(1);
  });

  it("keeps the dialog usable again after a rejected confirm", async () => {
    const { container } = mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Charge card?"
        description="This charges the card on file."
        onConfirm={() => Promise.reject(new Error("gateway timeout"))}
      />,
    );

    const dialog = container.ownerDocument.body;
    const confirm = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Confirm"),
    );

    await act(async () => {
      confirm?.click();
    });

    // The button must not stay disabled-and-labelled "Working…" forever if the
    // mutation throws; that would strand the user with no way forward.
    const after = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Confirm"),
    );
    expect(after?.hasAttribute("disabled")).toBe(false);
    // The failure must also be reported in place. An `onConfirm` that rejects
    // and is neither surfaced nor caught produces an unhandled rejection,
    // which vitest counts as an error and which leaves the user with a dialog
    // that silently did nothing.
    expect(dialog.textContent).toContain("gateway timeout");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("gateway timeout");
  });
});
