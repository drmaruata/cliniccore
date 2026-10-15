/**
 * The round-4 Critical, pinned from the DOM that actually ships.
 *
 * `ConfirmDialog`'s confirm button is not a `Button` element: it is
 * `AlertDialogAction`, a `Button asChild` wrapper around Radix's
 * `AlertDialogPrimitive.Action`, and Radix `Slot` merges props with CHILD
 * PROPS WINNING — so the element the browser sees carries
 * `data-slot="alert-dialog-action"`, not the `data-slot="button"` the cva
 * map implies. Rounds 2 and 3 keyed the destructive compensation on slots
 * this dialog never emits, and the gate stayed green for three rounds
 * because it read class maps, not rendered trees.
 *
 * This file is the DOM half of the fix's evidence. It renders the real
 * component, reads the attributes a browser would match selectors against,
 * and then holds `app/globals.css`'s RESTING compensating rule to exactly
 * that pairing: the slot and variant read off the confirm button must appear
 * together in the selector list of an unlayered, state-free rule that paints
 * a colour. Delete that selector from the rule and this test fails — which is
 * the regression this round existed to make impossible to reintroduce
 * quietly.
 *
 * It lives apart from `tests/unit/shared-primitives.test.tsx` on purpose:
 * that file is smoke/contract coverage for the seven primitives, while this
 * one reads `app/globals.css` off disk to hold one selector list to the
 * shipped DOM. The CSS scanner below is carried here rather than imported
 * from `tests/unit/design-tokens.test.ts` — importing a test file registers
 * its whole suite a second time under this one.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { stripComments } from "@/scripts/check-no-secrets";

/*
 * React's `act` contract: tell React this environment supports it.
 *
 * jsdom does not set `IS_REACT_ACT_ENVIRONMENT`, so React logs "The current
 * testing environment is not configured to support act(...)" — one per
 * commit — whenever scheduled work (Radix presence, focus management, portal
 * teardown) flushes inside `act` without the flag. Emission is
 * timing-dependent: the same run of this file measured 28 of them once and
 * none the next. Every React interaction in this file is wrapped in `act`,
 * which is precisely the configuration the flag describes, so set it and
 * make the output deterministic rather than merely quiet today.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Vitest serves test modules over a non-`file:` URL in the jsdom
 * environment, so `import.meta.url` cannot locate the repo. Walk up from
 * the working directory to the first ancestor that holds `app/globals.css`
 * instead — the same approach as tests/unit/design-tokens.test.ts.
 */
function findRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "app", "globals.css"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the repository root from ${process.cwd()}`);
}

const GLOBALS_CSS = readFileSync(join(findRepoRoot(), "app", "globals.css"), "utf8");

/** A top-level rule: the selector list before the `{`, and the declarations in it. */
interface TopLevelRule {
  prelude: string;
  body: string;
}

/**
 * Top-level `{ prelude { body } }` blocks of a stylesheet.
 *
 * A compact relative of the scanner in tests/unit/design-tokens.test.ts,
 * carried here rather than imported (see the file header). It handles the
 * two traps that file documents hitting: a `;` at depth 0 ends a statement
 * rather than opening a block, and comments are skipped in preludes AND in
 * the brace count so a prose brace cannot desynchronise the matcher.
 */
function topLevelRules(css: string): TopLevelRule[] {
  const rules: TopLevelRule[] = [];
  let i = 0;
  let chunkStart = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const close = css.indexOf("*/", i + 2);
      i = close === -1 ? css.length : close + 2;
      continue;
    }
    if (css[i] === ";") {
      i++;
      chunkStart = i;
      continue;
    }
    if (css[i] !== "{") {
      i++;
      continue;
    }
    let depth = 1;
    let cursor = i + 1;
    while (cursor < css.length && depth > 0) {
      if (css.startsWith("/*", cursor)) {
        const close = css.indexOf("*/", cursor + 2);
        cursor = close === -1 ? css.length : close + 2;
        continue;
      }
      if (css[cursor] === "{") depth++;
      else if (css[cursor] === "}") depth--;
      cursor++;
    }
    rules.push({
      prelude: stripComments(css.slice(chunkStart, i)).trim(),
      body: css.slice(i + 1, cursor - 1),
    });
    i = cursor;
    chunkStart = cursor;
  }
  return rules;
}

let root: Root | null = null;

/** Mount into jsdom so the Radix portal the dialog renders through exists. */
function mount(node: React.ReactNode): void {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root?.unmount();
    root = createRoot(host);
    root.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ConfirmDialog's destructive compensation", () => {
  it("is keyed on the slot and variant the confirm button actually carries", () => {
    mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete Ada Okafor?"
        description="This cannot be undone."
        onConfirm={() => {}}
        tone="destructive"
        confirmLabel="Delete patient"
        cancelLabel="Cancel"
      />,
    );

    /** The shipped button for `label`, found by label — not by slot. */
    const buttonByLabel = (label: string): HTMLElement => {
      const found = Array.from(document.body.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      expect(
        found,
        `no button labelled "${label}" reached the document — the dialog did not mount through its portal`,
      ).toBeDefined();
      return found!;
    };

    /*
     * THE EXACT PAIRING that was silently broken for three rounds. The
     * confirm control is `AlertDialogAction`, so Radix's child props win over
     * Button's `data-slot="button"` — the browser matches it as
     * `alert-dialog-action`, and a compensation keyed any other way reaches
     * nothing.
     */
    const confirm = buttonByLabel("Delete patient");
    const confirmSlot = confirm.getAttribute("data-slot");
    const confirmVariant = confirm.getAttribute("data-variant");
    expect(confirmSlot, "the confirm button's data-slot").toBe("alert-dialog-action");
    expect(confirmVariant, "the confirm button's data-variant").toBe("destructive");

    // The cancel control is `AlertDialogCancel` under the same merge, so its
    // slot is overridden the same way. Its variant is `outline`; the probe
    // this test replaces printed both attributes before it was deleted.
    const cancel = buttonByLabel("Cancel");
    expect(cancel.getAttribute("data-slot"), "the cancel button's data-slot").toBe(
      "alert-dialog-cancel",
    );

    /*
     * THE RULE HALF. A selector naming the rendered pairing must exist in an
     * unlayered, state-free rule that paints a colour — the shape a
     * compensation needs to outrank the generated tint (see the comment above
     * the rules in app/globals.css). "Entirely about this variant" is the
     * same requirement `compensatingRule` in tests/unit/design-tokens.test.ts
     * applies, so a selector list that mentions the slot under a different
     * variant cannot satisfy this either.
     */
    const covered = topLevelRules(GLOBALS_CSS).some((rule) => {
      if (rule.prelude.trimStart().startsWith("@layer")) return false;
      const selectors = rule.prelude.split(",").map((selector) => selector.trim());
      if (
        selectors.some((selector) =>
          /:(?:hover|focus|focus-visible|active|disabled)\b/.test(selector),
        )
      ) {
        return false;
      }
      if (!selectors.every((selector) => selector.includes(`[data-variant="${confirmVariant}"]`))) {
        return false;
      }
      const paints = stripComments(rule.body)
        .split(";")
        .some((chunk) => /^\s*(?:color|background(?:-color)?)\s*:/.test(chunk));
      return (
        paints &&
        selectors.some(
          (selector) =>
            selector.includes(`[data-slot="${confirmSlot}"]`) &&
            selector.includes(`[data-variant="${confirmVariant}"]`),
        )
      );
    });
    expect(
      covered,
      `the resting compensating rules in app/globals.css cover [data-variant="${confirmVariant}"] ` +
        `but none is keyed on [data-slot="${confirmSlot}"] — the rule reaches every slot except ` +
        `the one the confirm button actually carries`,
    ).toBe(true);
  });
});
