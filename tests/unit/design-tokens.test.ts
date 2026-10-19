/**
 * Design-token gate for `app/globals.css`.
 *
 * WHY THIS FILE EXISTS. Two of the global constraints are only checkable
 * against the CSS file itself:
 *
 *   - the six mandated brand colours exist as `--brand-*` tokens, in BOTH
 *     `:root` and `.dark`;
 *   - no component hardcodes a hex, so the palette has exactly one home.
 *
 * HOW THE "NO HEX" RULE IS SCOPED (and why it is not brittle).
 *
 *   The rule asserted here is: **a hex literal may appear only inside the
 *   bodies of the top-level `:root { … }` and `.dark { … }` token blocks.**
 *   Everywhere else in `globals.css` — the `@theme inline` bridge, the
 *   `@layer base` block, a `@media` override, anything a future contributor
 *   appends — hex is forbidden.
 *
 *   A stricter reading ("globals.css contains no hex at all") is what was
 *   rejected: `shadcn@latest init` and any future dependency may legitimately
 *   emit a hex in a generated base rule, and a test that turns red for that
 *   teaches people to delete the gate. The scoped reading still catches the
 *   defect. The regression it describes is a colour pasted into the wrong
 *   place — a `@layer base` rule, a `@media` block, a component class — and
 *   every one of those is outside the token blocks by definition. Two
 *   structural choices keep it tight:
 *
 *     - exclusion is by TOP-LEVEL RULE, not by substring. A `:root` nested in
 *       `@media` is not a token block and its hex is still reported;
 *     - hex is permitted inside the token blocks, so the brand-hex provenance
 *       comments can live next to the value they document.
 *
 *   To prove the rule is live rather than vacuous,
 *   `describe("the hex rule is not vacuous")` runs the *same* scanner over
 *   synthetic CSS with a hex planted outside the token blocks and asserts it
 *   is reported — including the nested-`:root` and nested-`.dark` cases the
 *   first cut of this file got wrong.
 *
 * CONTRAST. WCAG 2.1 AA (4.5:1 normal text, 3:1 non-text UI) is computed from
 * the resolved token values, not from a comment. `#b5bdbb` is the brand
 * neutral: it sits near 1.8:1 on white, so it is pinned to borders, muted
 * surfaces and decoration. `describe("contrast")` asserts that stays true, so
 * a future "just use the brand grey for helper text" change fails loudly
 * instead of shipping unreadable copy.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stripComments } from "@/scripts/check-no-secrets";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

/**
 * Vitest serves test modules over a non-`file:` URL in the jsdom
 * environment, so `import.meta.url` cannot be used to locate the repo. Walk up
 * from the working directory to the first ancestor that holds `app/globals.css`
 * instead; that makes the test independent of the directory it is invoked from.
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

const REPO_ROOT = findRepoRoot();
const GLOBALS_CSS = readFileSync(join(REPO_ROOT, "app", "globals.css"), "utf8");

/* ------------------------------------------------------------------ */
/* CSS parsing                                                          */
/* ------------------------------------------------------------------ */

export interface RuleBlock {
  /** Text between the rule's `{` and its matching `}`, comments stripped. */
  body: string;
  /** Text before the `{` — the selector or at-rule prelude. */
  prelude: string;
  /** Char offsets of the whole rule in the source, for range-exclusion. */
  start: number;
  end: number;
}

/**
 * Rules at nesting depth 0. Depth 0 is the boundary the gate cares about: it
 * is where `:root` and `.dark` are declared, and it is where a stray
 * `@media` / `@layer` / `@supports` wrapper would smuggle a hex past a
 * substring-only check.
 *
 * Two things a naive brace-counter gets wrong, both of which this file hit in
 * its first cut and both of which the negative controls now pin:
 *
 *   - a `;` at depth 0 closes a statement rather than opening a block, so the
 *     `@import` and `@custom-variant` lines ahead of the token blocks are not
 *     absorbed into the next rule's prelude;
 *   - comments are skipped, in preludes AND in the brace count, so the header
 *     prose does not become part of the `:root` selector and a brace inside a
 *     comment cannot desynchronise the matcher.
 */
export function topLevelRules(css: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  const end = css.length;
  let i = 0;
  let chunkStart = 0;
  while (i < end) {
    if (/\s/.test(css[i] ?? "")) {
      i++;
      continue;
    }
    if (css.startsWith("/*", i)) {
      const close = css.indexOf("*/", i + 2);
      i = close === -1 ? end : close + 2;
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
    while (cursor < end && depth > 0) {
      if (css.startsWith("/*", cursor)) {
        const close = css.indexOf("*/", cursor + 2);
        cursor = close === -1 ? end : close + 2;
        continue;
      }
      if (css[cursor] === "{") depth++;
      else if (css[cursor] === "}") depth--;
      cursor++;
    }
    const stop = depth === 0 ? cursor : end;
    blocks.push({
      prelude: stripComments(css.slice(chunkStart, i)).trim(),
      body: css.slice(i + 1, stop - 1),
      start: chunkStart,
      end: stop,
    });
    i = stop;
    chunkStart = stop;
  }
  return blocks;
}

function topLevelRuleFor(css: string, prelude: string): RuleBlock | undefined {
  const wanted = prelude.trim();
  return topLevelRules(css).find((rule) => rule.prelude.trim() === wanted);
}

/** Declarations of a rule body, keyed by property name. Comments stripped. */
export function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of stripComments(body).split(";")) {
    const text = chunk.trim();
    const colon = text.indexOf(":");
    if (colon === -1) continue;
    const name = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (!/^[a-zA-Z-][a-zA-Z0-9-]*$/.test(name) || value === "") continue;
    out.set(name, value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Colour maths                                                         */
/* ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number];

interface Oklch {
  L: number;
  C: number;
  H: number;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function hueOf(value: Oklch): number {
  return ((value.H % 360) + 360) % 360;
}

/** sRGB hex to gamma-encoded sRGB channels in 0..1. */
export function hexToRgb(hex: string): Rgb {
  const body = hex.replace(/^#/, "");
  const wide = body.length <= 4 ? [...body].map((c) => c + c).join("") : body;
  const read = (offset: number): number =>
    Number.parseInt(wide.slice(offset, offset + 2), 16) / 255;
  return [read(0), read(2), read(4)];
}

/**
 * OKLCH to gamma-encoded sRGB channels in 0..1 — the SAME encoding
 * `hexToRgb` produces.
 *
 * That shared encoding is the whole point. WCAG relative luminance wants
 * linear-light channels, so `luminance` gamma-decodes whatever it is handed.
 * If this function returned linear values the decode would be applied twice
 * and every oklch-sourced ratio would be silently wrong — which is exactly
 * the bug the first run of this file shipped. Out-of-gamut channels are
 * clamped, which is what a browser does at paint time.
 */
export function oklchToSrgb({ L, C, H }: Oklch): Rgb {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
  return linear.map((channel) => Math.min(1, Math.max(0, linearToSrgb(channel)))) as unknown as Rgb;
}

/** Gamma-encoded sRGB channels in 0..1 to sRGB hex. */
export function rgbToHex([r, g, b]: Rgb): string {
  const channel = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function parseColor(value: string): Oklch | Rgb | null {
  const text = value.trim();
  const oklch =
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(text);
  if (oklch) {
    const raw = oklch[1] ?? "0";
    return {
      L:
        (raw.endsWith("%") ? Number.parseFloat(raw) : Number.parseFloat(raw)) /
        (raw.endsWith("%") ? 100 : 1),
      C: Number.parseFloat(oklch[2] ?? "0"),
      H: Number.parseFloat(oklch[3] ?? "0"),
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = (rgb[1] ?? "").split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const channel = (raw: string): number =>
        raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
      return [channel(parts[0] ?? "0"), channel(parts[1] ?? "0"), channel(parts[2] ?? "0")];
    }
  }
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return hexToRgb(text);
  return null;
}

function isOklch(value: Oklch | Rgb): value is Oklch {
  return typeof (value as Oklch).H === "number" && typeof (value as Oklch).L === "number";
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio between two already-resolved sRGB colours. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] =
    luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ */
/* OKLab, for tinted backgrounds                                       */
/* ------------------------------------------------------------------ */

/**
 * Gamma-encoded sRGB to OKLab (Björn Ottosson's matrices, as CSS Color 4 §12.2
 * uses them).
 *
 * Needed because a generated variant can name a TINTED background —
 * `bg-destructive/10` on the destructive Button, `dark:bg-input/30` on the
 * outline Button — and `bg-destructive` is not the colour that ends up behind
 * the text.
 *
 * THE LINEARISATION IS NOT OPTIONAL. OKLab is defined as
 * `cbrt(linear-light sRGB) -> LMS -> M2`. The previous version of this function
 * fed GAMMA-ENCODED channels straight into the LMS matrix, which computes
 * `cbrt(gamma)` where it should compute `cbrt(linear)`. The two agree only at 0
 * and 1.
 *
 * OKLab's defining property is that, for a neutral, `L == relativeLuminance^(1/3)`.
 * Measured against that property:
 *
 * | sRGB channel | linear Y | correct L | cbrt(gamma) L |
 * | --- | --- | --- | --- |
 * | 0.10 | 0.0100 | 0.2156 | 0.4642 |
 * | 0.50 | 0.2140 | 0.5982 | 0.7937 |
 * | 0.90 | 0.7874 | 0.9234 | 0.9655 |
 *
 * The error is bidirectional — `oklabToSrgb` was correct, so every tint computed
 * through the pair was systematically too light, which made composited
 * backgrounds measure too close to the text sitting on them. The
 * `the OKLab transform is correct` describe block pins the fixed version by
 * round-trip and against the `L == Y^(1/3)` property directly, because the
 * previous self-test used only black and white, which is exactly where the two
 * models coincide.
 */
export function srgbToOklab([r, g, b]: Rgb): readonly [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to gamma-encoded sRGB, gamut-clipped the way a browser clips at paint time. */
export function oklabToSrgb([L, a, bb]: readonly [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
  return linear.map((channel) => Math.min(1, Math.max(0, linearToSrgb(channel)))) as unknown as Rgb;
}

/**
 * CSS `color-mix(in oklab, a p%, b)` — oklab interpolation.
 *
 * One of TWO compositing models, because they are NOT the same computation and
 * a verdict that depends on which one you happened to pick is not a verdict.
 *
 *   - **oklab interpolation** (`this`) — interpolate in OKLab. This is what
 *     `color-mix(in oklab, …)` is specified to do, and what the colour-mix
 *     layer of a `/N` modifier computes.
 *   - **gamma-sRGB premultiplied** (`compositeGammaSrgb`) — `a*p + b*(1-p)` per
 *     channel in gamma-encoded sRGB. This is what a translucent layer actually
 *     contributes once the browser composites the resulting semi-transparent
 *     colour over an opaque backdrop, which is the paint that reaches the
 *     screen. `color-mix(in oklab, var(--x) N%, transparent)` does NOT produce
 *     "the oklab mix of x and the backdrop"; premultiplied interpolation toward
 *     `transparent` leaves the colour's own channels alone, so it yields the
 *     token at alpha N — and the mixing with the backdrop happens afterwards,
 *     in sRGB.
 *
 * MEASURED ON BOTH SAMPLES THE GATE CARES ABOUT — `--destructive` as text on
 * its own generated wash — gamma-sRGB is the LOWER of the two:
 *
 *   | sample                       | oklab-interp | gamma-sRGB |
 *   | ---------------------------- | ------------ | ---------- |
 *   | light, ink on its `/10` wash | 5.23:1       | 5.10:1     |
 *   | dark, ink on its `/20` wash  | 4.96:1       | 4.83:1     |
 *
 * The ruling that built this gate described oklab interpolation as "the
 * conservative model, the lower of the two". It is not: on both samples it is
 * the higher, by 0.13:1 in dark and 0.13:1 in light. The number the round-2
 * report carried for the dark sample (2.06:1) came from the broken transform;
 * the number the dispatch carried (5.70:1 / 5.76:1) could not be reproduced
 * here by either model — re-measured independently, the pair is 4.83:1 and
 * 4.96:1. Those figures are what this comment and the tests now use.
 *
 * SO THE GATE TAKES THE MINIMUM OF THE TWO. That satisfies the ruling's actual
 * intent — "a gate must not admit a failing paint" — without depending on which
 * model happens to be lower, which is a property of the palette and not of the
 * code. A second test below pins that the two models agree to within 0.25:1 on
 * every surface the shipped variants actually use, so the min is a guard
 * against future divergence rather than a permanent tax; if a future change
 * pushes them apart, that test fails and the gate is already conservative.
 */
export function mixOklab(a: Rgb, b: Rgb, percent: number): Rgb {
  const [al, aa, ab] = srgbToOklab(a);
  const [bl, ba, bb] = srgbToOklab(b);
  const t = percent / 100;
  return oklabToSrgb([al * t + bl * (1 - t), aa * t + ba * (1 - t), ab * t + bb * (1 - t)]);
}

/** Alpha compositing in gamma-encoded sRGB: `a*p + b*(1-p)`, per channel. */
export function compositeGammaSrgb(a: Rgb, b: Rgb, percent: number): Rgb {
  const t = percent / 100;
  return [
    a[0] * t + b[0] * (1 - t),
    a[1] * t + b[1] * (1 - t),
    a[2] * t + b[2] * (1 - t),
  ] as unknown as Rgb;
}

/** Contrast between two literal colours. Used for the brief's fixed navy pairs. */
export function contrastOf(a: string, b: string): number {
  return contrast(hexToRgb(a), hexToRgb(b));
}

/**
 * Resolve a token value to gamma-encoded sRGB, following `var(--other)`
 * indirection. Throws on anything it cannot resolve, so a malformed token
 * fails the test loudly instead of silently scoring a meaningless ratio.
 */
export function resolveRgb(
  value: string,
  vars: Map<string, string>,
  seen: readonly string[] = [],
): Rgb {
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (ref) {
    const name = ref[1] ?? "";
    if (seen.includes(name))
      throw new Error(`circular token reference: ${[...seen, name].join(" -> ")}`);
    const next = vars.get(name);
    if (next === undefined) throw new Error(`unknown token reference: ${name}`);
    return resolveRgb(next, vars, [...seen, name]);
  }
  const colour = parseColor(value);
  if (colour === null) throw new Error(`unresolvable colour value: ${value}`);
  return isOklch(colour) ? oklchToSrgb(colour) : colour;
}

function requireToken(vars: Map<string, string>, name: string): string {
  const value = vars.get(name);
  if (value === undefined) throw new Error(`token ${name} is not declared`);
  return value;
}

/** Contrast between two token names within one mode. */
export function tokenContrast(vars: Map<string, string>, fg: string, bg: string): number {
  return contrast(
    resolveRgb(requireToken(vars, fg), vars),
    resolveRgb(requireToken(vars, bg), vars),
  );
}

/* ------------------------------------------------------------------ */
/* The hex rule                                                         */
/* ------------------------------------------------------------------ */

const HEX_LITERAL = /#[0-9a-f]{3,8}\b/gi;
const TOKEN_BLOCK_SELECTORS = [":root", ".dark"] as const;

/** Char ranges of the top-level `:root` / `.dark` token blocks. */
export function tokenBlockRanges(css: string): Array<[number, number]> {
  return topLevelRules(css)
    .filter((rule) =>
      rule.prelude
        .split(",")
        .map((selector) => selector.trim())
        .some((selector) => (TOKEN_BLOCK_SELECTORS as readonly string[]).includes(selector)),
    )
    .map((rule) => [rule.start, rule.end] as [number, number]);
}

/**
 * `css` with the top-level `:root` / `.dark` token blocks removed.
 *
 * The exemption is structural rather than textual: a colour may be written
 * inside the token blocks because that is where the palette is declared, and
 * nowhere else. Split out from `findHexLiterals` because the off-palette-class
 * rule needs the same exemption and must not reimplement it.
 */
export function outsideTokenBlocks(css: string): string {
  let remainder = css;
  for (const [start, end] of tokenBlockRanges(css).sort((a, b) => b[0] - a[0])) {
    remainder = remainder.slice(0, start) + remainder.slice(end);
  }
  return remainder;
}

/**
 * Hex literals in `css` that sit OUTSIDE the top-level `:root` / `.dark`
 * token blocks. This is the assertion the gate exists for; it is exported so
 * the negative controls below can prove it is not vacuous.
 */
export function findHexLiterals(css: string): string[] {
  return (outsideTokenBlocks(css).match(HEX_LITERAL) ?? []).map((literal) => literal.toLowerCase());
}

/**
 * Directories whose `.ts` / `.tsx` / `.css` files are product UI surface, i.e.
 * where a hard-coded colour would be a defect.
 *
 * `lib/` is here because the gate's scope used to be `app/` and `components/`
 * only, which meant a component placed under `lib/` — a natural home for a
 * `lib/components/` or a shared feature primitive — was silently unscanned and
 * the gate went quiet without failing. A gate that can be narrowed by moving a
 * file is not a gate.
 */
const SCAN_ROOTS = ["app", "components", "lib"] as const;

/** Source files that are product UI surface, i.e. where a hex would be a defect. */
function uiSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) uiSourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every scanned file, as repo-relative POSIX paths. */
function scannedUiFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => uiSourceFiles(join(REPO_ROOT, root)))
    .map((file) => file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"))
    .sort();
}

function scannedUiSource(codeOnly = false): Array<readonly [string, string]> {
  return scannedUiFiles()
    .filter((file) => (codeOnly ? /\.(tsx?)$/.test(file) : true))
    .map((file) => [file, join(REPO_ROOT, file)] as const);
}

/**
 * Tailwind's built-in numeric palette.
 *
 * `--color-red-500` and friends are a complete, off-palette colour system that
 * bypasses every token in `app/globals.css` while producing a green gate: the
 * hex half of this rule cannot see them because there is no hex on the class
 * name, and no token is consulted. `bg-red-500` in a component is exactly the
 * "all colours come from tokens" violation the brief names, so it is gated.
 *
 * The list is deliberately the numeric families Tailwind ships. It does not
 * include `black` / `white` / `transparent` / `current` — see the remaining-gap
 * note below for why.
 */
const TAILWIND_PALETTE_CLASS =
  /-(?:red|blue|green|slate|gray|zinc|amber|orange|emerald|sky|indigo|violet|rose|purple|fuchsia|lime|teal|cyan)-[0-9]{2,3}\b/g;

/**
 * Off-palette palette classes in one scanned file.
 *
 * Runs against CSS as well as TS/TSX. `@apply bg-red-500` inside
 * `app/globals.css` was previously unscanned, because the palette rule was
 * restricted to code files. That restriction was necessary for the
 * COLOUR-FUNCTION rule — every token declaration in `globals.css` is literally
 * an `oklch(` call — but it was not necessary here, and it left a hole: a
 * stylesheet can hardcode a palette colour without touching the token blocks.
 *
 * CSS files get the same structural exemption the hex rule uses (the top-level
 * `:root` / `.dark` blocks, where the palette is declared) rather than a
 * blanket skip.
 */
export function offPaletteClasses(source: string, isCss: boolean): string[] {
  const text = stripComments(isCss ? outsideTokenBlocks(source) : source);
  TAILWIND_PALETTE_CLASS.lastIndex = 0;
  return text.match(TAILWIND_PALETTE_CLASS) ?? [];
}

/**
 * A colour function called with a literal argument.
 *
 * `oklch(0.6 0.2 30)` or `hsl(210 80% 40%)` in a component is the same
 * violation as a hex, reached without the word `#`. `color-mix(` is NOT in
 * this list: mixing two tokens (`bg-[color-mix(in_oklch,var(--secondary),…)]`,
 * which `components/ui/button.tsx` ships) is still a token-derived colour and
 * is the sanctioned way to derive one.
 */
const LITERAL_COLOUR_FUNCTION = /\b(?:oklch|oklab|lab|lch|rgba?|hsla?)\(/g;

/**
 * REMAINING GAP, recorded rather than pretended away.
 *
 * The palette regex above is anchored on the numeric suffix, because a bare
 * `-(red|blue|…)-` prefix pattern would also flag `bg-white`, `border-border`
 * and `bg-muted` — which are as much an off-palette colour as `bg-red-500`, but
 * need their own allowlist-of-one decision. The consequence is that
 * `bg-white`, `text-black`, `bg-transparent` and `bg-current` in a component are
 * still uncaught by this gate.
 *
 * That is a real gap, not a rounding error: `--card` is white in light mode, so
 * `bg-white` is the kind of thing a contributor reaches for. It needs its own
 * rule plus a decision about which of `white` / `black` / `transparent` are
 * legitimate, so it is left to the next task rather than half-solved here.
 */

/* ------------------------------------------------------------------ */
/* Expectations                                                         */
/* ------------------------------------------------------------------ */

const BRAND = {
  "--brand-primary": "#05ab29",
  "--brand-secondary": "#066fc4",
  "--brand-destructive": "#bf140b",
  "--brand-neutral": "#b5bdbb",
  "--brand-success": "#35a677",
  "--brand-navy": "#172099",
} as const;

/** The shadcn semantic layer the brief mandates, for BOTH modes. */
const SEMANTIC = [
  "--background",
  "--foreground",
  "--card",
  "--popover",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--destructive",
  "--destructive-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
  "--success",
  "--success-foreground",
] as const;

/**
 * Tokens beyond the mandated list that the generated shadcn primitives
 * reference by name, so they are not optional: `card.tsx` renders
 * `text-card-foreground`, and `button.tsx`'s secondary and outline variants
 * render `secondary-foreground` and `border-input`.
 */
const SUPPORTING = ["--secondary-foreground", "--card-foreground", "--popover-foreground"] as const;

/**
 * Tokens that are not part of the mandated semantic layer but are still
 * declared in both blocks and reachable from `@theme inline`.
 *
 * `--destructive-hover` is here because the compensating rule for the
 * destructive variant paints it, and it was the one colour token in the file
 * that was in neither the token blocks' test coverage nor the bridge's: the
 * hover test pinned its existence and value, so it could not vanish silently,
 * but nothing asserted that it was *reachable* from Tailwind. A token that
 * exists but is not bridged cannot be used as `bg-destructive-hover` by a
 * future caller, and the bridge gate is where that should be noticed.
 */
const DERIVED = ["--destructive-hover"] as const;

/**
 * Brand colour used AS TEXT rather than as a fill. A brand hue that clears AA
 * as a fill under its own ink does not clear AA as a label on a surface, so the
 * two jobs need separate tokens.
 *
 * `--primary-ink` was missing from this list and the gate did not notice. The
 * fill pair `["--primary", "--primary-foreground"]` passed comfortably, and
 * nothing asserted `--primary` *as text* — where it measures 2.93:1 on
 * background. `components/ui/button.tsx` and `components/ui/badge.tsx` both ship
 * `link: "text-primary …"`, so `<Button variant="link">` was one call away from
 * shipping unreadable text with a green gate.
 */
const ON_SURFACE = ["--success-ink", "--destructive-ink", "--primary-ink"] as const;

const ALL_TOKENS = [...Object.keys(BRAND), ...SEMANTIC, ...SUPPORTING, ...DERIVED, ...ON_SURFACE];

const rootBlock = topLevelRuleFor(GLOBALS_CSS, ":root");
const darkBlock = topLevelRuleFor(GLOBALS_CSS, ".dark");
const rootVars = declarations(rootBlock?.body ?? "");
const darkVars = declarations(darkBlock?.body ?? "");

/** [foreground token, background token] pairs that actually carry text. */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--primary", "--primary-foreground"],
  ["--secondary", "--secondary-foreground"],
  ["--destructive", "--destructive-foreground"],
  ["--success", "--success-foreground"],
  ["--brand-navy", "--background"],
  ["--foreground", "--background"],
  ["--foreground", "--card"],
  ["--muted-foreground", "--background"],
  ["--muted-foreground", "--card"],
  ["--accent-foreground", "--accent"],
  ["--success-ink", "--card"],
  ["--success-ink", "--background"],
  ["--destructive-ink", "--card"],
  ["--destructive-ink", "--background"],
  ["--primary-ink", "--card"],
  ["--primary-ink", "--background"],
  // `--brand-secondary` clears AA as text on its own (4.93:1 on background), so
  // an `info` label may use the brand colour directly rather than an ink. This
  // is asserted rather than assumed because components/shared/status-badge.tsx
  // documents exactly that, and a doc comment citing a contrast number that no
  // test holds is how the 3.67:1 figure it used to cite survived review.
  ["--brand-secondary", "--background"],
  ["--brand-secondary", "--card"],
];

/**
 * Non-text UI, which WCAG 1.4.11 puts at 3:1.
 *
 * `--border` is here because it has two consumers with different claims, and
 * only one of them was being honoured. As a table rule it really is decoration
 * and 1.4.11 does not apply. As the `outline` Button variant's
 * `border-border bg-background` edge, the border IS the component boundary,
 * which is precisely the case 1.4.11 is about — and that one measured 1.84:1 on
 * background in light mode, i.e. a button with no perceivable edge.
 */
const NON_TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--input", "--background"],
  ["--ring", "--background"],
  ["--ring", "--card"],
  ["--border", "--background"],
];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const MODES = [
  ["light", rootVars],
  ["dark", darkVars],
] as const;

describe("app/globals.css token blocks", () => {
  it("declares a top-level :root block and a top-level .dark block", () => {
    expect(rootBlock).toBeDefined();
    expect(darkBlock).toBeDefined();
    expect(GLOBALS_CSS).toMatch(/^\s*\.dark\s*\{/m);
  });

  it("sets color-scheme in both blocks so native controls follow the theme", () => {
    expect(requireToken(rootVars, "color-scheme")).toBe("light");
    expect(requireToken(darkVars, "color-scheme")).toBe("dark");
  });

  it("registers .dark as the dark variant (dark mode is class-based, not media-based)", () => {
    expect(GLOBALS_CSS).toMatch(/@custom-variant\s+dark\b/);
  });

  it.each(Object.keys(BRAND))("defines %s in both :root and .dark", (name) => {
    expect(requireToken(rootVars, name)).toMatch(/^(oklch|var\()/);
    expect(requireToken(darkVars, name)).toMatch(/^(oklch|var\()/);
  });

  it.each(SEMANTIC)("defines the mandated semantic token %s in both modes", (name) => {
    expect(requireToken(rootVars, name)).toMatch(/^(oklch|var\()/);
    expect(requireToken(darkVars, name)).toMatch(/^(oklch|var\()/);
  });

  it.each(SUPPORTING)("defines the primitive-support token %s in both modes", (name) => {
    expect(requireToken(rootVars, name)).toMatch(/^(oklch|var\()/);
    expect(requireToken(darkVars, name)).toMatch(/^(oklch|var\()/);
  });

  it.each(DERIVED)("defines the derived token %s in both modes", (name) => {
    expect(requireToken(rootVars, name)).toMatch(/^(oklch|var\()/);
    expect(requireToken(darkVars, name)).toMatch(/^(oklch|var\()/);
  });

  it("bridges every token into Tailwind's colour namespace via `@theme inline`", () => {
    const theme = topLevelRuleFor(GLOBALS_CSS, "@theme inline");
    expect(theme).toBeDefined();
    // `inline` is what makes the var() references resolve per-mode at runtime
    // instead of being baked in at build time — without it, `.dark` cannot
    // re-colour anything.
    expect(theme?.prelude).toMatch(/@theme\s+inline\b/);
    const themeVars = declarations(theme?.body ?? "");
    for (const token of ALL_TOKENS) {
      expect(requireToken(themeVars, `--color-${token.slice(2)}`)).toBe(`var(${token})`);
    }
  });

  it.each(MODES)("resolves every token to a concrete colour in %s mode", (_mode, vars) => {
    for (const token of ALL_TOKENS) {
      expect(() => resolveRgb(requireToken(vars, token), vars), token).not.toThrow();
    }
  });
});

describe("palette provenance", () => {
  it.each(Object.entries(BRAND))(
    "%s in :root is exactly the mandated %s once converted back to sRGB",
    (name, hex) => {
      expect(rgbToHex(resolveRgb(requireToken(rootVars, name), rootVars))).toBe(hex);
    },
  );

  it.each(Object.keys(BRAND))(
    "%s in .dark stays on the brand hue — re-lightened, not replaced",
    (name) => {
      const light = parseColor(requireToken(rootVars, name));
      const dark = parseColor(requireToken(darkVars, name));
      if (light === null || dark === null || !isOklch(light) || !isOklch(dark)) {
        throw new Error(`${name} must be an oklch() literal to be checked against its brand hue`);
      }
      const gap = Math.abs(hueOf(light) - hueOf(dark));
      expect(Math.min(gap, 360 - gap)).toBeLessThan(8);
    },
  );

  it.each([
    [
      "--brand-primary",
      "--brand-secondary",
      "--brand-destructive",
      "--brand-success",
      "--brand-navy",
    ],
    // ...and the one that moves the other way. #b5bdbb is already a light
    // grey; carrying it unchanged into dark mode would make every table rule
    // and card outline the loudest thing on the page.
    ["--brand-neutral"],
  ])(
    "re-lights every brand colour for dark mode rather than reusing the light value",
    (...names) => {
      for (const name of names) {
        const light = parseColor(requireToken(rootVars, name));
        const dark = parseColor(requireToken(darkVars, name));
        if (light === null || dark === null || !isOklch(light) || !isOklch(dark)) {
          throw new Error(`${name} must be an oklch() literal`);
        }
        if (name === "--brand-neutral") {
          expect(dark.L, `${name} is unchanged in dark mode`).toBeLessThan(light.L);
        } else {
          expect(dark.L, `${name} is unchanged in dark mode`).toBeGreaterThan(light.L);
        }
      }
    },
  );
});

describe("contrast", () => {
  describe.each(MODES)("%s mode", (_mode, vars) => {
    it.each(TEXT_PAIRS)("%s on %s clears WCAG AA text contrast", (fg, bg) => {
      const ratio = tokenContrast(vars, fg, bg);
      expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it.each(NON_TEXT_PAIRS)("%s on %s clears WCAG AA non-text contrast", (fg, bg) => {
      const ratio = tokenContrast(vars, fg, bg);
      expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
  });

  it("satisfies the brief's two fixed navy pairs", () => {
    expect(contrastOf("#172099", "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastOf("#ffffff", "#172099")).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("keeps the brand neutral out of body-text duty", () => {
    // #b5bdbb sits near 1.8:1 on white. It is a border / muted-surface
    // colour; promoting it to text is the failure this pins shut.
    expect(tokenContrast(rootVars, "--brand-neutral", "--background")).toBeLessThan(AA_TEXT);
    expect(tokenContrast(darkVars, "--brand-neutral", "--background")).toBeLessThan(AA_TEXT);
  });

  it("keeps the brand primary out of body-text duty, which is what --primary-ink exists for", () => {
    // The counterpart to the neutral assertion. `--brand-primary` clears AA as
    // a FILL under `--primary-foreground` and fails AA badly as a label
    // (2.93:1 light, 8.88:1 dark). These two assertions are what make the ink
    // token mandatory rather than decorative: if a future palette change
    // lightens the brand enough to pass as text, the ink becomes unnecessary
    // and this test tells you so instead of leaving a redundant token behind.
    expect(tokenContrast(rootVars, "--brand-primary", "--background")).toBeLessThan(AA_TEXT);
    expect(tokenContrast(rootVars, "--brand-primary", "--card")).toBeLessThan(AA_TEXT);
  });

  it("keeps --border usable as a component boundary, not just as decoration", () => {
    // WCAG 1.4.11 applies to the `outline` Button's edge, so `--border` has to
    // clear 3:1 in BOTH modes and on EVERY surface it can land on — not only on
    // `--background`. It used to be asserted nowhere at all and measured 1.84:1
    // in light mode; dark mode was 3.09:1 on background but only 2.83:1 on card
    // and 2.44:1 on muted, so the outline button drawn on either of those had no
    // perceivable edge at night.
    //
    // An earlier version of this test branched on `surface === "--background"`
    // with the same expression on both arms, and printed ", reported only" for
    // the other two. That branch was a no-op: card and muted were gated all
    // along, and the message claimed otherwise. It is gone, and every pair below
    // is a live assertion.
    const surfaces = ["--background", "--card", "--muted"] as const;
    for (const [mode, vars] of [
      ["light", rootVars],
      ["dark", darkVars],
    ] as const) {
      for (const surface of surfaces) {
        const ratio = tokenContrast(vars, "--border", surface);
        expect(
          ratio,
          `--border on ${surface} in ${mode} mode is ${ratio.toFixed(2)}:1 (3:1 required by WCAG 1.4.11)`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Generated variants vs the text-colour gate                         */
/* ------------------------------------------------------------------ */

/**
 * The generated components whose variants this gate reads.
 *
 * Every one of these emits `data-slot` and `data-variant`, which is what makes
 * a compensating rule in `globals.css` possible without touching generated
 * code. Both are produced by `shadcn`, so the list is a real inventory rather
 * than a guess — but it is an inventory that has to be extended, which is why
 * the enumeration count is asserted below.
 */
const DIRECT_VARIANT_SOURCES = [
  ["button", "components/ui/button.tsx"],
  ["badge", "components/ui/badge.tsx"],
] as const;

/**
 * Pull the `variant: { … }` map out of a `cva(...)` call as `name -> classes`.
 *
 * A balanced-brace scan from `variant: {` rather than a regex over the file, so
 * the adjacent `size: { … }` map and the base class string are excluded by
 * construction instead of by pattern luck. If shadcn changes the emitted shape
 * the scan finds no `{` and this throws — loudly, which is the correct failure
 * mode for an inventory that has stopped being one.
 */
export function cvaVariantClasses(source: string): Record<string, string> {
  const anchor = source.indexOf("variant: {", source.indexOf("variants: {"));
  if (anchor === -1) throw new Error("no `variant: {` map found in the source");
  const open = source.indexOf("{", anchor);
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  const body = source.slice(open + 1, i - 1);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(?:^|[,{\s])([A-Za-z][\w-]*):\s*"([^"]*)"/g)) {
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

/**
 * Slots that a `data-variant` can actually land on, DERIVED rather than listed.
 *
 * This exists because round 3 shipped a compensating rule that reached nothing.
 * `Button` accepts `asChild`, which swaps its own `<button>` element for its
 * child through Radix `Slot`. `mergeProps(slotProps, childProps)` builds
 * `overrideProps = { ...childProps }` first, so **the child's props win** — and
 * a child that carries its own `data-slot` overrides the `data-slot="button"`
 * Button sets. `AlertDialogAction` and `AlertDialogCancel` are exactly that: a
 * `Button asChild` around a Radix primitive carrying
 * `data-slot="alert-dialog-action"` / `"alert-dialog-cancel"`.
 *
 * So `[data-slot="button"][data-variant="destructive"]` never matched
 * `ConfirmDialog`'s confirm button, and the whole accessibility work rested on a
 * selector the shipped DOM did not carry. The gate could not see it because it
 * read the cva class maps and modelled each variant as though it rendered on a
 * bare element.
 *
 * The derivation: every `<Button … asChild>` in a generated component, paired
 * with the `data-slot` on the child inside it. Both the wrapper count and the
 * slot names are asserted below, so a new `asChild` wrapper is a visible diff
 * and an empty scan is a loud failure rather than a silent narrowing.
 */
export function asChildSlots(files: ReadonlyArray<readonly [string, string]>): Array<{
  file: string;
  wrapper: string;
  slot: string;
}> {
  const found: Array<{ file: string; wrapper: string; slot: string }> = [];
  for (const [wrapper, rel] of files) {
    const source = readFileSync(join(REPO_ROOT, rel), "utf8");
    // `<Button … asChild>` — the open tag, so a mention in prose does not count.
    const opens = source.matchAll(/<Button\b[^>]*\basChild\b[^>]*>/g);
    for (const open of opens) {
      const after = source.slice(open.index + open[0].length);
      // The child's own `data-slot` is the first one inside the wrapper.
      const slot = /data-slot="([^"]+)"/.exec(after)?.[1];
      if (slot === undefined) continue;
      found.push({ file: rel, wrapper, slot });
    }
  }
  return found;
}

/** Generated components that wrap `Button`, and therefore can emit another slot. */
const BUTTON_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["alert-dialog", "components/ui/alert-dialog.tsx"],
];

/**
 * Every slot a variant can reach: the direct `Button` / `Badge` elements, plus
 * every slot an `asChild` wrapper emits on Button's behalf.
 */
const REACHABLE_SLOTS: readonly string[] = [
  ...DIRECT_VARIANT_SOURCES.map(([slot]) => slot),
  ...asChildSlots(BUTTON_WRAPPERS).map(({ slot }) => slot),
];

/** A colour utility and the alpha Tailwind applies to it, as `[name, percent]`. */
type Utility = readonly [string, number];

function utilities(classString: string, prefix: "bg" | "text" | "border", variant = ""): Utility[] {
  const head = `${variant}${prefix}-`;
  const out: Utility[] = [];
  for (const token of classString.split(/\s+/).filter(Boolean)) {
    if (!token.startsWith(head)) continue;
    const [name, alpha] = token.slice(head.length).split("/");
    if (name === undefined || name.startsWith("[")) continue; // arbitrary value, not a token
    out.push([`--${name}`, alpha === undefined ? 100 : Number.parseInt(alpha, 10)]);
  }
  return out;
}

/**
 * The foreground, background and border a variant actually paints in one mode.
 *
 * Only utilities in force AT REST are considered. A state rule
 * (`hover:text-foreground`, `focus-visible:ring-destructive/20`) is a different
 * rule under a different condition and cannot collide with the resting colour,
 * so it is skipped — for the same reason the StatusBadge assertion counts whole
 * class tokens rather than substrings.
 *
 * `dark:` utilities only apply in dark mode and take precedence there, because
 * Tailwind compiles them to `:is(.dark *)`, which carries a class of specificity
 * the unprefixed utility does not have. Verified against a running build: the
 * outline Button computes `--input/30` in dark despite `bg-background` also being
 * present.
 *
 * `declaresBackground` is carried out because a variant naming no `bg-*` does not
 * sit on `--background` by definition — it inherits whatever surface it was placed
 * on, which for a Badge is very often `--card` or `--muted`. Assuming
 * `--background` is optimistic by construction; the caller uses this flag to test
 * such a variant against every host surface instead.
 *
 * A tinted `bg-…/N` is returned as-is, not flattened to the token: `--destructive`
 * is not the colour that ends up on screen.
 */
function restingColours(
  classString: string,
  mode: "light" | "dark",
): { fg: string; bg: Utility; declaresBackground: boolean; border: Utility | undefined } {
  // Two unconditional `bg-*` utilities in the SAME mode is precisely the
  // StatusBadge merge defect this repo already suffered. Picking the first would
  // model the result rather than flag it, so fail loudly instead of guessing
  // which one wins. An unprefixed utility AND its `dark:` override is not that —
  // that is the normal light/dark pairing — so each mode is checked separately.
  for (const prefix of ["bg", "text", "border"] as const) {
    for (const scope of ["", "dark:"] as const) {
      const count = utilities(classString, prefix, scope).length;
      expect(
        count,
        `${classString} declares ${count} unconditional \`${scope}${prefix}-*\` utilities ` +
          `(mode ${scope === "dark:" ? "dark" : "light"}); this gate can only model one`,
      ).toBeLessThanOrEqual(1);
    }
  }

  const pick = (prefix: "bg" | "text" | "border", darkMode: boolean): Utility | undefined => {
    if (darkMode) {
      const dark = utilities(classString, prefix, "dark:");
      if (dark.length > 0) return dark[0];
    }
    return utilities(classString, prefix)[0];
  };

  const bg = pick("bg", mode === "dark");
  const border = pick("border", mode === "dark");
  return {
    fg: pick("text", mode === "dark")?.[0] ?? "--foreground",
    bg: bg ?? ["--background", 100],
    declaresBackground: bg !== undefined,
    // `border-transparent` is on the base string of every generated variant; it
    // is not a boundary, so it is reported as absent rather than as `--border`.
    border: border !== undefined && border[0] !== "--transparent" ? border : undefined,
  };
}

/**
 * The compensating rule in `globals.css` for a generated variant, if one
 * applies in this mode. Returns the colours it declares.
 *
 * Only UNLAYERED rules count. Compensating rules are unlayered on purpose — see
 * the comment above the rules in `app/globals.css` — because a declaration
 * inside `@layer utilities` would lose to the very utility it is replacing.
 *
 * A rule scoped under `.dark` only applies in dark mode, and is ignored in
 * light: a variant that needs help in one mode must not be reported as
 * uncompensated in the other, and one that is compensated in both should be
 * held to both.
 *
 * Either property counts. Most of these variants need the TEXT changed; the
 * destructive ones need the BACKGROUND changed instead, and a model that only
 * understood `color:` would have demanded a text fix that cannot exist (see the
 * note on the destructive rule in globals.css).
 */
export function compensatingRule(
  slot: string,
  variant: string,
  mode: "light" | "dark",
): { colour?: string; background?: string } {
  const rules = topLevelRules(GLOBALS_CSS).filter(
    (rule) => !rule.prelude.trimStart().startsWith("@layer"),
  );
  for (const rule of rules) {
    const selectors = rule.prelude.split(",").map((selector) => selector.trim());

    // A STATE selector cannot be a resting-state compensation. `…:hover` paints
    // a different colour than the resting state, and modelling it as the resting
    // compensation would attribute the fix to the wrong rule.
    if (
      selectors.some((selector) =>
        /:(?:hover|focus|focus-visible|active|disabled)\b/.test(selector),
      )
    ) {
      continue;
    }

    // The rule must be entirely about THIS variant. One rule may legitimately
    // serve several slots at once (`[data-slot="button"][data-variant="link"]`,
    // `[data-slot="badge"][data-variant="link"]` in a single selector list), so
    // the test is that every branch keys this variant — not that every branch
    // names this slot. A list mixing two variants is therefore rejected rather
    // than half-applied.
    const keyedBySlot = selectors.some(
      (selector) =>
        selector.includes(`[data-slot="${slot}"]`) &&
        selector.includes(`[data-variant="${variant}"]`),
    );
    if (!keyedBySlot) continue;
    if (!selectors.every((selector) => selector.includes(`[data-variant="${variant}"]`))) continue;

    // Mode scoping, per branch. A selector applies in a mode unless it is
    // `.dark`-scoped and the mode is light. An UNSCOPED rule therefore applies in
    // both — which is the case round 3 had to get right, since dropping the
    // `.dark` prefix from the destructive rule is the fix itself. A genuinely
    // mixed list like `.dark [x], [x]` has an always-applicable branch and so
    // applies in both; the conservative direction, because over-applying a
    // compensation can only make the gate demand more, never less.
    const applies = selectors.some((selector) => !selector.includes(".dark") || mode === "dark");
    if (!applies) continue;

    const decls = declarations(rule.body);
    const colour = decls.get("color");
    const background = decls.get("background-color") ?? decls.get("background");
    if (colour !== undefined || background !== undefined) return { colour, background };
  }
  return {};
}

/**
 * A bare `var(--x)`, which is the only form a compensating rule may declare a
 * colour in.
 *
 * `color-mix(in oklab, var(--x) 90%, …)` is refused even though it is
 * token-derived: the gate has to resolve the paint and hold the RESULT to AA,
 * and a tint smuggled back in at this point is what would make the assertion
 * vacuous. `ref()` is also why a compensating rule pointing at an inaccessible
 * token fails rather than silently passing.
 */
function refToken(value: string | undefined, message: string): string {
  const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec((value ?? "").trim())?.[1];
  expect(token, message).toBeDefined();
  return token as string;
}

/**
 * `refToken`, naming the variant that owns the rule in the failure message.
 *
 * Kept out of the per-case closure so the hover test can use the same
 * requirement without duplicating the regex.
 */
function ref(value: string, context: string, mode: "light" | "dark"): string {
  return refToken(value, `${context} in ${mode} mode declares "${value}", which is not a var()`);
}

/** The `data-slot` a compensating-rule selector keys on, if it keys on one. */
function slotOf(selector: string): string | undefined {
  return /\[data-slot="([^"]+)"\]/.exec(selector)?.[1];
}

/** The `data-variant` a compensating-rule selector keys on, if it keys on one. */
function variantOf(selector: string): string | undefined {
  return /\[data-variant="([^"]+)"\]/.exec(selector)?.[1];
}

/**
 * The class string a variant paints on a given slot.
 *
 * A direct slot (Button, Badge) paints its own cva map. An `asChild` slot paints
 * **Button's** cva map, because the wrapper renders `<Button variant={…} asChild>`
 * and it is Button that computes the class string — the Radix child contributes
 * its own `data-slot` and `className` and nothing else. That is precisely why a
 * slot can differ from `button` while the classes it paints are unchanged, and
 * it is why round 3's rule was inert rather than wrong about colour.
 */
function variantClassesFor(slot: string, variant: string): string | undefined {
  const direct = DIRECT_VARIANT_SOURCES.find(([name]) => name === slot)?.[1];
  const wrapsButton = asChildSlots(BUTTON_WRAPPERS).some((entry) => entry.slot === slot);
  if (direct === undefined && !wrapsButton) return undefined;
  const source = direct ?? "components/ui/button.tsx";
  return cvaVariantClasses(readFileSync(join(REPO_ROOT, source), "utf8"))[variant];
}

type VariantCase = readonly [string, string, string];

const VARIANT_CASES: VariantCase[] = DIRECT_VARIANT_SOURCES.flatMap(([slot, rel]) =>
  Object.entries(cvaVariantClasses(readFileSync(join(REPO_ROOT, rel), "utf8"))).map(
    ([variant, classString]) => [slot, variant, classString] as const,
  ),
);

describe("every generated variant clears AA as text, or is compensated", () => {
  /*
   * WHY THIS EXISTS. Round 1 added `--primary-ink` because `--primary` is 2.93:1
   * as text, and it asserted the token. That fixed the instance and left the
   * class of defect standing: the generated `link` variant on both Button and
   * Badge still names `text-primary`, so the first feature to call
   * `<Button variant="link">` shipped 2.93:1 text with the suite green.
   *
   * The real error is one layer up. Of the three things in play, only
   * `--brand-primary` is mandated; `--primary` is a token `app/globals.css`
   * chooses, and it was doing two incompatible jobs — a fill under
   * `--primary-foreground` (5.70:1, fine) and link text (2.93:1, not fine). The
   * palette cannot move, so the fix has to be at the variant.
   *
   * This test is deliberately GENERAL. It reads every variant out of the
   * generated sources and derives what each one paints, rather than listing
   * `link`. A future `shadcn add` shipping `subtle: "text-primary"` fails here
   * without anyone having to think of it.
   */

  it("actually enumerates the generated variants", () => {
    // The guard against a vacuous gate: if the parser stopped finding anything,
    // every per-variant case below would pass by having no cases.
    expect(VARIANT_CASES.length).toBeGreaterThanOrEqual(10);
    const names = VARIANT_CASES.map(([slot, variant]) => `${slot}:${variant}`);
    expect(names).toContain("button:link");
    expect(names).toContain("badge:link");
    expect(names).toContain("button:destructive");
    expect(new Set(names).size).toBe(names.length);
  });

  it("derives the slots an `asChild` Button wrapper actually emits", () => {
    /*
     * THE ROUND-4 CRITICAL, turned into an inventory.
     *
     * Round 3's compensating rule named `[data-slot="button"]` and
     * `[data-slot="badge"]`. `ConfirmDialog`'s confirm button is neither: it is
     * `AlertDialogAction`, a `Button asChild` wrapper whose child Radix merges
     * with CHILD PROPS WINNING, so the emitted element carries
     * `data-slot="alert-dialog-action"` and the rule never matched it.
     *
     * Reading the class maps cannot see that, because the class maps are correct
     * — it is the DOM the wrapper emits that is not what the map implies. So the
     * inventory is derived from the source here, and the rule-coverage assertion
     * below holds every compensating rule to it.
     */
    const wrappers = asChildSlots(BUTTON_WRAPPERS);
    expect(
      wrappers.map(({ slot }) => slot).sort(),
      "the `Button asChild` wrappers found in components/ui — if this changes, a compensating rule's selector list may need a new slot",
    ).toEqual(["alert-dialog-action", "alert-dialog-cancel"]);
    expect(wrappers.every(({ wrapper }) => wrapper === "alert-dialog")).toBe(true);
    expect(REACHABLE_SLOTS).toContain("alert-dialog-action");
    expect(REACHABLE_SLOTS).toContain("alert-dialog-cancel");
    expect(REACHABLE_SLOTS).toContain("button");
    expect(REACHABLE_SLOTS).toContain("badge");
  });

  it("every compensating rule covers every slot a variant can reach", () => {
    /*
     * THE ANTI-PHANTOM GUARD. A compensating rule is written against a set of
     * `data-slot`s. If that set is narrower than the set of slots a variant can
     * actually reach, the rule is inert on the ones it misses — which is exactly
     * how round 3 shipped three selectors that covered none of the shipped
     * destructive control.
     *
     * Every `asChild` wrapper accepts Button's full `variant` prop type, so
     * statically any of them can carry any variant. The rule therefore has to
     * cover ALL reachable slots, which is deliberately the strict reading: the
     * cost of being strict is a few selectors that never match, and the cost of
     * being loose is another phantom.
     */
    for (const rule of topLevelRules(GLOBALS_CSS)) {
      if (rule.prelude.trimStart().startsWith("@layer")) continue;
      const selectors = rule.prelude.split(",").map((selector) => selector.trim());
      // A state selector is not a resting compensation; the hover rule is held
      // to the same inventory by its own test below.
      if (
        selectors.some((selector) =>
          /:(?:hover|focus|focus-visible|active|disabled)\b/.test(selector),
        )
      ) {
        continue;
      }
      const keyed = selectors
        .map((selector) => variantOf(selector))
        .filter((variant): variant is string => variant !== undefined);
      if (keyed.length === 0) continue;
      const covered = new Set(
        selectors
          .map((selector) => slotOf(selector))
          .filter((slot): slot is string => slot !== undefined),
      );
      for (const slot of REACHABLE_SLOTS) {
        expect(
          covered.has(slot),
          `globals.css has a compensating rule for [data-variant="${keyed[0]}"] whose selector ` +
            `list covers ${[...covered].sort().join(", ")} but not [data-slot="${slot}"] — a ` +
            `variant painted on that slot would get no compensation`,
        ).toBe(true);
      }
    }
  });

  it.each(VARIANT_CASES)(
    "%s variant=%s paints text that clears AA, or has a compensating rule",
    (slot, variant, classString) => {
      const HOSTS = ["--background", "--card", "--muted"] as const;

      for (const mode of ["light", "dark"] as const) {
        const vars = mode === "light" ? rootVars : darkVars;

        /**
         * Contrast of `fg` on the surface `bg` paints over `host`, under the
         * CONSERVATIVE of the two compositing models.
         *
         * Taking the minimum is what makes the gate safe: gamma-sRGB is the lower
         * model on both samples the palette actually uses (see `mixOklab`), but
         * that is a property of these hues rather than a guarantee, and a gate
         * must not admit a paint either model would fail. A solid fill (alpha
         * 100) is identical under both, so this only ever does work on a tint.
         */
        const paintedContrast = (fg: string, bg: Utility, host: Rgb): number => {
          const foreground = resolveRgb(requireToken(vars, fg), vars);
          const colour = resolveRgb(requireToken(vars, bg[0]), vars);
          if (bg[1] >= 100) return contrast(foreground, colour);
          return Math.min(
            contrast(foreground, mixOklab(colour, host, bg[1])),
            contrast(foreground, compositeGammaSrgb(colour, host, bg[1])),
          );
        };

        const asPainted = restingColours(classString, mode);
        const rule = compensatingRule(slot, variant, mode);
        const hasRule = Object.keys(rule).length > 0;
        const context = `${slot} variant="${variant}"`;
        const fixedFg = rule.colour === undefined ? asPainted.fg : ref(rule.colour, context, mode);
        const fixedBg: Utility =
          rule.background === undefined ? asPainted.bg : [ref(rule.background, context, mode), 100];

        // A variant that declares no `bg-*` inherits whatever it is placed on,
        // which for a Badge is usually `--card` or `--muted`. Testing only
        // `--background` would be optimistic by construction, so every host is
        // tested; a variant that declares its own fill is host-independent.
        const hosts = asPainted.declaresBackground ? (["--background"] as const) : HOSTS;

        for (const hostToken of hosts) {
          const host = resolveRgb(requireToken(vars, hostToken), vars);
          const where =
            `${context} in ${mode} mode on ${hostToken}: painted ${asPainted.fg} on ` +
            `${asPainted.bg[0]}${asPainted.bg[1] < 100 ? `/${asPainted.bg[1]}` : ""} = ` +
            `${paintedContrast(asPainted.fg, asPainted.bg, host).toFixed(2)}:1`;

          const painted = paintedContrast(asPainted.fg, asPainted.bg, host);
          if (painted >= AA_TEXT && !hasRule) continue;

          expect(
            hasRule,
            `${where}, which is below AA ${AA_TEXT}:1, and globals.css has no compensating rule for ` +
              `[data-slot="${slot}"][data-variant="${variant}"] applying in ${mode} mode`,
          ).toBe(true);

          // Apply whatever the rule changed, then hold the RESULT to AA. A rule
          // pointing at another inaccessible token is not a compensation, and a
          // rule painting a solid background while leaving the text alone fails
          // here too — text == background is 1:1.
          const fixed = paintedContrast(fixedFg, fixedBg, host);
          expect(
            fixed,
            `${where}, and its compensating rule yields ${fixedFg} on ${fixedBg[0]}, ` +
              `which is only ${fixed.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    },
  );

  it("covers the link variant, which is the one the review found", () => {
    // Named separately so the specific finding stays legible even if a future
    // palette change makes the loop above pass for a different reason.
    expect(tokenContrast(rootVars, "--primary", "--background")).toBeLessThan(AA_TEXT);
    expect(tokenContrast(rootVars, "--primary-ink", "--background")).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
    expect(compensatingRule("button", "link", "light").colour).toBe("var(--primary-ink)");
    expect(compensatingRule("badge", "link", "light").colour).toBe("var(--primary-ink)");
    // Dark mode never needed the compensation; asserting it documents why the
    // rule is harmless there rather than accidental.
    expect(tokenContrast(darkVars, "--primary", "--background")).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("covers the destructive variants, whose defect is the boundary, not the text", () => {
    /*
     * The second finding from generalising the gate, and the one where an
     * earlier version of this file was wrong in a way that mattered.
     *
     * Round 2 reported shadcn's destructive variant at 2.06:1 as TEXT in dark
     * mode and shipped a fix justified by it. That number was an artefact of a
     * broken `srgbToOklab` which computed `cbrt(gamma)` instead of
     * `cbrt(linear)`. With the transform corrected the text measures 5.10:1
     * (light, on its `/10` wash) and 4.96:1 (dark, on the `/20` wash) — it was
     * never failing, and the round-2 comment block claiming it did was false.
     *
     * The defect is real but different: WCAG 1.4.11, the control BOUNDARY. The
     * tint the variant paints against the page it sits on, as gamma-sRGB /
     * oklab-interpolation:
     *
     *   light /10  1.19:1 / 1.16:1      dark /10  1.13:1 / 1.12:1
     *   light /20  1.42:1 / 1.35:1      dark /20  1.34:1 / 1.30:1
     *
     * Swept across every alpha the tint only clears 3:1 at about 70% opacity
     * (1.07:1 at 5% in light, 6.06:1 solid), so the two alphas shadcn generates
     * leave the control with no perceivable edge. That is the `--border` defect
     * from fix round 1 — the same reason `--input` is darkened off the neutral —
     * one variant over, on the control that asks a user to confirm deleting a
     * patient.
     *
     * A text-side fix cannot exist either. Round 2's sweep claimed lightening
     * the ink only moved the `/20` wash from 2.06:1 to 3.35:1 even at L 0.93;
     * re-derived with the corrected transform, the same sweep is 4.96:1 at
     * L 0.70 and 8.82:1 at L 0.93. The surface moves WITH the ink, so the ratio
     * improves, but the EDGE does not move at all — and the edge is what fails.
     */
    const BOUNDARY = 3;
    for (const [mode, vars] of [
      ["light", rootVars],
      ["dark", darkVars],
    ] as const) {
      for (const host of ["--background", "--card"] as const) {
        const backdrop = resolveRgb(requireToken(vars, host), vars);
        for (const alpha of [10, 20]) {
          const tint = mixOklab(
            resolveRgb(requireToken(vars, "--destructive"), vars),
            backdrop,
            alpha,
          );
          // Assert the DEFECT first, so this test cannot quietly become vacuous
          // if the gate or the palette ever changes underneath it.
          expect(
            contrast(tint, backdrop),
            `destructive ${alpha}% on ${host} in ${mode} mode — if this now clears 3:1 the defect is gone and this block should be deleted`,
          ).toBeLessThan(BOUNDARY);
        }
        // And the compensation, which is unscoped, clears it in both modes.
        const solid = resolveRgb(requireToken(vars, "--destructive"), vars);
        expect(contrast(solid, backdrop)).toBeGreaterThanOrEqual(BOUNDARY);
      }
    }

    // Text was never the problem, and saying so with a number stops the next
    // reader re-deriving the round-2 claim.
    const lightDestructive = resolveRgb(requireToken(rootVars, "--destructive"), rootVars);
    const darkDestructive = resolveRgb(requireToken(darkVars, "--destructive"), darkVars);
    const lightBg = resolveRgb(requireToken(rootVars, "--background"), rootVars);
    const darkBg = resolveRgb(requireToken(darkVars, "--background"), darkVars);
    expect(
      contrast(lightDestructive, mixOklab(lightDestructive, lightBg, 10)),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(darkDestructive, mixOklab(darkDestructive, darkBg, 20))).toBeGreaterThanOrEqual(
      AA_TEXT,
    );

    const rule = compensatingRule("button", "destructive", "light");
    expect(rule.background).toBe("var(--destructive)");
    expect(rule.colour).toBe("var(--destructive-foreground)");
    expect(compensatingRule("badge", "destructive", "dark").background).toBe("var(--destructive)");
    // Unscoped, which is the whole point: a `.dark`-only rule left light mode
    // shipping a 1.19:1 edge on the safety-critical button.
    expect(compensatingRule("button", "destructive", "light")).not.toEqual({});
    expect(compensatingRule("button", "destructive", "dark")).not.toEqual({});
  });

  it("holds every hover compensation to AA, a state the resting gate cannot see", () => {
    /*
     * The resting gate reads a variant's UNPREFIXED utilities, so `:hover` is
     * invisible to it by construction — right for the generated
     * `hover:bg-muted` on the ghost variant, wrong for a hover rule globals.css
     * writes itself.
     *
     * Round 3 makes the destructive compensation UNSCOPED, and an unlayered
     * unconditional `background-color` outranks the generated
     * `hover:bg-destructive/20` for the same layer reason it outranks the
     * resting tint. So the compensation necessarily deletes hover feedback and
     * a rule has to put it back. That rule is where the danger is: an earlier
     * version mixed toward `black`, and the figures quoted next to it were
     * wrong (see the correction at the bottom of this block).
     */
    for (const rule of topLevelRules(GLOBALS_CSS)) {
      if (rule.prelude.trimStart().startsWith("@layer")) continue;
      const selectors = rule.prelude.split(",").map((selector) => selector.trim());
      if (!selectors.some((selector) => /:hover\b/.test(selector))) continue;
      for (const mode of ["light", "dark"] as const) {
        const vars = mode === "light" ? rootVars : darkVars;
        // Per branch, the same mode test the resting gate uses: a selector
        // applies unless it is `.dark`-scoped and the mode is light.
        if (!selectors.some((selector) => !selector.includes(".dark") || mode === "dark")) continue;
        const decls = declarations(rule.body);
        const background = decls.get("background-color") ?? decls.get("background");
        const fill = refToken(
          background,
          `${rule.prelude.trim()} in ${mode} mode declares "${background}", which is not a var()`,
        );
        // The label is whatever the resting rule left on the control, read out
        // of the generated sources rather than named here, so a hover rule for a
        // different variant is checked against its own ink.
        const target = selectors
          .map((selector) => [slotOf(selector), variantOf(selector)] as const)
          .find(([s, v]) => s !== undefined && v !== undefined);
        if (target === undefined) continue; // not about one variant; nothing to compare
        const [slot, variant] = target;
        const classes = variantClassesFor(slot as string, variant as string);
        const resting = classes === undefined ? "--foreground" : restingColours(classes, mode).fg;
        const compensatingColour = compensatingRule(slot as string, variant as string, mode).colour;
        const ink =
          compensatingColour === undefined
            ? resting
            : refToken(
                compensatingColour,
                `${slot} ${variant} in ${mode} mode declares "${compensatingColour}", which is not a var()`,
              );
        const ratio = tokenContrast(vars, ink, fill);
        expect(
          ratio,
          `${rule.prelude.trim()} paints ${fill} under ${ink}, which is ` +
            `${ratio.toFixed(2)}:1 in ${mode} mode`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }

    // Not vacuous. The loop above is a `for`, so it would pass silently with no
    // hover rules at all — and "the destructive variant has no hover rule" is
    // exactly the regression this test exists to catch, because deleting the
    // rule leaves the control with no hover feedback rather than an unreadable
    // one. So its existence is asserted, and the variants that must NOT need one
    // are asserted not to have one.
    const hoverRulesFor = (variant: string): string[] =>
      topLevelRules(GLOBALS_CSS)
        .filter((rule) => !rule.prelude.trimStart().startsWith("@layer"))
        .filter((rule) =>
          rule.prelude
            .split(",")
            .map((selector) => selector.trim())
            .some((selector) => variantOf(selector) === variant && /:hover\b/.test(selector)),
        )
        .map((rule) => rule.prelude.trim());

    // THE SAME INVENTORY AS THE RESTING RULE, MINUS THE BADGE. An unlayered
    // hover rule has to cover every slot the resting rule covers, because the
    // resting rule is what removed the generated hover on each of them. A Badge
    // is not pointer-driven and the generated badge variant scopes its hover to
    // `[a]:` — anchors — so it is deliberately excluded and the exclusion is
    // asserted rather than assumed.
    const POINTER_SLOTS = REACHABLE_SLOTS.filter((slot) => slot !== "badge");
    const destructiveHover = hoverRulesFor("destructive");
    expect(destructiveHover).toHaveLength(1);
    const hoverSlots = destructiveHover[0]!
      .split(",")
      .map((selector) => selector.trim())
      .map(slotOf)
      .filter((slot): slot is string => slot !== undefined);
    expect([...hoverSlots].sort()).toEqual([...POINTER_SLOTS].sort());
    // `link` is compensated by a `color:` change, which leaves the generated
    // `hover:underline` alone, so it needs no hover rule of its own.
    expect(hoverRulesFor("link")).toEqual([]);

    /*
     * CORRECTED PROVENANCE, round 4. The figures quoted above the loop used to
     * read "6.33:1 -> 20.62:1 light, 6.69:1 -> 1.09:1 dark" for a mix toward
     * `black`. Both numbers are real but they do not describe one proportion:
     * `color-mix(in oklab, var(--destructive) 88%, black)` measures 8.14:1
     * light and 4.85:1 dark; 20.62:1 appears at about 20% of the token (dark
     * 1.04 there) and 1.09:1 at about 10%. What survives the correction is the
     * direction, and it is the same conclusion: for every proportion at or below
     * 25% the dark ratio sits at about 1.0 — the label vanishing against its own
     * fill — while light never drops below 7.8.
     */
    const black: Rgb = [0, 0, 0];
    for (const [mode, vars] of [
      ["light", rootVars],
      ["dark", darkVars],
    ] as const) {
      const destructive = resolveRgb(requireToken(vars, "--destructive"), vars);
      const ink = resolveRgb(requireToken(vars, "--destructive-foreground"), vars);
      const at88 = contrast(ink, mixOklab(destructive, black, 88));
      expect(
        at88,
        `mixing --destructive 88% toward black leaves its ink at ${at88.toFixed(2)}:1 in ${mode} mode`,
      ).toBeGreaterThan(0);
      for (const percent of [25, 20, 10]) {
        const ratio = contrast(ink, mixOklab(destructive, black, percent));
        if (mode === "dark") {
          expect(
            ratio,
            `dark --destructive mixed ${percent}% toward black leaves its ink at ${ratio.toFixed(2)}:1`,
          ).toBeLessThan(AA_TEXT);
        } else {
          expect(
            ratio,
            `light --destructive mixed ${percent}% toward black leaves its ink at ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
  });

  describe("the compensating rules reach the controls that actually ship", () => {
    /*
     * React's `act` contract, set for the same reason as in
     * tests/unit/confirm-dialog-dom.test.tsx: jsdom does not set
     * `IS_REACT_ACT_ENVIRONMENT`, and Radix work flushing inside `act` then
     * logs "not configured to support act(...)" per commit. Measured in this
     * describe at 28 per run while the tests still unmounted in-body; after
     * that redundant unmount was removed this file read clean, but the
     * sibling file — which mounts the same dialog — measured the same
     * warnings arriving on some runs and not others, so the emission is
     * timing-dependent rather than gone. Every React interaction in this
     * describe is wrapped in `act`, which is the configuration the flag
     * declares, so set it and close the class rather than hope the timing
     * holds.
     */
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    /*
     * WHY THIS EXISTS — the round-4 Critical, and the reason it survived three
     * rounds of review.
     *
     * The accessibility work of rounds 2 and 3 was inert in the one place it was
     * justified. `AlertDialogAction` is a `Button asChild` wrapper around Radix's
     * `AlertDialogPrimitive.Action`. Radix `Slot.mergeProps(slotProps, childProps)`
     * builds `overrideProps = { ...childProps }` first — CHILD PROPS WIN — so the
     * child's `data-slot` overrides the `data-slot="button"` Button sets. The
     * shipped control therefore carries `data-slot="alert-dialog-action"`, and the
     * rule keyed on `[data-slot="button"]` never matched it.
     *
     * Nothing caught it because the gate reads the cva class maps and models each
     * variant as though it renders on a bare element. The class maps are correct;
     * it is the emitted DOM that is not what the map implies. So this test renders
     * the real tree, reads the attributes a browser would match selectors against,
     * and holds the rule's selector list to them.
     */
    let host: HTMLElement | null = null;
    let root: Root | null = null;

    /**
     * Mount into jsdom and return the element the dialog ACTUALLY renders into.
     *
     * Radix `AlertDialog` portals its content into `document.body`, not into the
     * mount host — querying the host finds nothing, which is exactly why the
     * committed ConfirmDialog tests in tests/unit/shared-primitives.test.tsx
     * query `container.ownerDocument.body` and why the round-4 probe queried
     * `document`. The first cut of this helper returned the host and saw zero
     * controls.
     */
    function renderConfirmDialog(tone: "default" | "destructive"): HTMLElement {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      act(() => {
        root?.render(
          React.createElement(ConfirmDialog, {
            open: true,
            onOpenChange: () => {},
            title: "Delete Ada Okafor?",
            description: "This cannot be undone.",
            onConfirm: () => {},
            tone,
          }),
        );
      });
      return host.ownerDocument.body;
    }

    beforeEach(() => {
      document.body.innerHTML = "";
    });

    it("renders ConfirmDialog and holds the rule's selectors to the emitted DOM", () => {
      const tree = renderConfirmDialog("destructive");
      const controls = Array.from(tree.querySelectorAll("[data-variant]"));
      expect(
        controls.length,
        "ConfirmDialog rendered no control carrying data-variant — the tree changed",
      ).toBeGreaterThan(0);

      const seen: Array<[string, string]> = [];
      for (const el of controls) {
        const slot = el.getAttribute("data-slot");
        const variant = el.getAttribute("data-variant");
        expect(slot, "a rendered control carries no data-slot").toBeTruthy();
        expect(variant).toBeTruthy();
        seen.push([slot as string, variant as string]);

        const classes = variantClassesFor(slot as string, variant as string);
        expect(
          classes,
          `no variant map found for slot=${slot} variant=${variant} — the inventory of slots a variant can reach is stale`,
        ).toBeDefined();

        for (const mode of ["light", "dark"] as const) {
          const vars = mode === "light" ? rootVars : darkVars;
          const painted = restingColours(classes as string, mode);

          /** Contrast of `fg` on `Utility` over the page, the conservative model. */
          const surfaceOf = (utility: Utility, hostToken: string): number => {
            const backdrop = resolveRgb(requireToken(vars, hostToken), vars);
            const colour = resolveRgb(requireToken(vars, utility[0]), vars);
            const [r, g, b] = mixOklab(colour, backdrop, utility[1]);
            return contrast([r, g, b], backdrop);
          };

          const BOUNDARY = 3;
          for (const hostToken of ["--background", "--card"] as const) {
            // The boundary a control paints is its BORDER when it declares one
            // — "the border IS the component boundary", as the outline Button's
            // own note under NON_TEXT_PAIRS records — and its fill otherwise.
            // The outline cancel is the case that forces the distinction: its
            // `bg-background` fill is 1:1 against the page by design, and its
            // perceivable edge is `border-border`.
            const edge = painted.border ?? painted.bg;
            const boundary = surfaceOf(edge, hostToken);
            const rule = compensatingRule(slot as string, variant as string, mode);
            if (boundary >= BOUNDARY) continue;
            // The variant's own boundary is not a boundary, so it needs help — and
            // the help must be keyed on the slot the DOM ACTUALLY carries.
            const covered = topLevelRules(GLOBALS_CSS).some((candidate) => {
              if (candidate.prelude.trimStart().startsWith("@layer")) return false;
              const selectors = candidate.prelude.split(",").map((selector) => selector.trim());
              if (
                selectors.some((selector) =>
                  /:(?:hover|focus|focus-visible|active|disabled)\b/.test(selector),
                )
              ) {
                return false;
              }
              return selectors.some(
                (selector) =>
                  selector.includes(`[data-slot="${slot}"]`) &&
                  selector.includes(`[data-variant="${variant}"]`),
              );
            });
            expect(
              covered,
              `rendered slot=${slot} variant=${variant} bounds itself by ${edge[0]}` +
                `${edge[1] < 100 ? `/${edge[1]}` : ""} on ${hostToken} ` +
                `at ${boundary.toFixed(2)}:1 in ${mode} mode — below 3:1 — and no compensating ` +
                `rule in globals.css is keyed on [data-slot="${slot}"][data-variant="${variant}"]`,
            ).toBe(true);

            // Whatever the rule paints must actually clear 1.4.11 on the page.
            const compensated = rule.background ?? painted.bg[0];
            const fixed = surfaceOf([refToken(rule.background, "rule background"), 100], hostToken);
            expect(
              fixed,
              `[data-slot="${slot}"][data-variant="${variant}"] in ${mode} mode paints ` +
                `${compensated} on ${hostToken}, whose boundary is ${fixed.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(BOUNDARY);
          }
        }
      }

      /*
       * NON-VACUITY, and the round-4 finding stated as an assertion.
       *
       * The guard above is a loop with a `continue`, so it would pass if the
       * destructive control were never rendered at all. So the exact pairing the
       * review found is pinned by name: the confirm button of the destructive
       * dialog carries `alert-dialog-action` + `destructive`, and the rule covers
       * it. Before round 4 this pairing was emitted by the DOM and matched by no
       * selector in the file.
       */
      expect(seen).toContainEqual(["alert-dialog-action", "destructive"]);
      expect(seen).toContainEqual(["alert-dialog-cancel", "outline"]);
      const destructiveHover = topLevelRules(GLOBALS_CSS)
        .filter((rule) => !rule.prelude.trimStart().startsWith("@layer"))
        .filter((rule) =>
          rule.prelude
            .split(",")
            .map((selector) => selector.trim())
            .some(
              (selector) =>
                slotOf(selector) === "alert-dialog-action" &&
                variantOf(selector) === "destructive" &&
                /:hover\b/.test(selector),
            ),
        );
      // The rule's prelude is a whole selector LIST (one string, several
      // selectors), so the individual selectors are what membership has to be
      // checked against — `toContain` on the joined prelude would compare one
      // multi-selector string against a single selector and never match.
      const hoverSelectors = destructiveHover.flatMap((rule) =>
        rule.prelude.split(",").map((selector) => selector.trim()),
      );
      expect(
        hoverSelectors,
        "the shipped confirm button is hoverable, so the hover rule must be keyed on the slot it actually carries",
      ).toContain('[data-slot="alert-dialog-action"][data-variant="destructive"]:hover');
      // No in-test unmount: `afterEach` below owns this describe's teardown.
      // The extra `act` an earlier cut spent unmounting here measured as 28
      // "not configured to support act(...)" errors attributed to this test on
      // every run; removing the redundant call removed the warnings with it.
    });

    it("renders ConfirmDialog and holds the shipped confirm button to AA in both modes", () => {
      /*
       * The measured consequence, asserted: the destructive confirm button's
       * resting boundary and its hover label ratio, in both modes, against the
       * surfaces it can land on.
       */
      const tree = renderConfirmDialog("destructive");
      const confirm = tree.querySelector('[data-slot="alert-dialog-action"]');
      expect(confirm, "ConfirmDialog emitted no alert-dialog-action control").not.toBeNull();
      expect(confirm?.getAttribute("data-variant")).toBe("destructive");

      for (const mode of ["light", "dark"] as const) {
        const vars = mode === "light" ? rootVars : darkVars;
        for (const hostToken of ["--background", "--card", "--muted"] as const) {
          const backdrop = resolveRgb(requireToken(vars, hostToken), vars);
          // Resting: the rule paints a solid fill, so the boundary is the fill.
          const restingFill = resolveRgb(requireToken(vars, "--destructive"), vars);
          const boundary = contrast(restingFill, backdrop);
          expect(
            boundary,
            `destructive confirm button on ${hostToken} in ${mode} mode has a ${boundary.toFixed(2)}:1 boundary`,
          ).toBeGreaterThanOrEqual(3);
          // Label on the solid fill.
          const label = tokenContrast(vars, "--destructive-foreground", "--destructive");
          expect(
            label,
            `destructive confirm button label in ${mode} mode is ${label.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
          // Hover: the generated `hover:bg-destructive/20` is outranked by the
          // unlayered hover rule, so what lands is `--destructive-hover`.
          const hovered = tokenContrast(
            vars,
            "--destructive-foreground",
            // resolved inline because --destructive-hover is a colour, not a pair
            "--destructive-hover",
          );
          expect(
            hovered,
            `destructive confirm button hover in ${mode} mode is ${hovered.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
      // Teardown is `afterEach`'s, as in the test above.
    });

    afterEach(() => {
      act(() => root?.unmount());
      root = null;
      host?.remove();
      host = null;
      document.body.innerHTML = "";
    });
  });

  it("reads what it thinks it reads out of the generated sources", () => {
    // The parser is the load-bearing part of this gate, so it gets its own
    // negative controls rather than being trusted.
    const button = cvaVariantClasses(
      readFileSync(join(REPO_ROOT, "components/ui/button.tsx"), "utf8"),
    );
    expect(button.link).toBe("text-primary underline-offset-4 hover:underline");
    expect(Object.keys(button)).not.toContain("lg"); // that is a SIZE, not a variant

    // Resting colours: a state rule must not be mistaken for the resting one.
    // `border-transparent` is on every generated base string and is reported as
    // no border at all, because a transparent border is not a boundary.
    const resting = (classString: string, mode: "light" | "dark" = "light") => {
      const { fg, bg, declaresBackground, border } = restingColours(classString, mode);
      return { fg, bg, declaresBackground, border };
    };
    expect(resting("text-primary underline-offset-4 hover:underline")).toEqual({
      fg: "--primary",
      bg: ["--background", 100],
      declaresBackground: false,
      border: undefined,
    });
    expect(resting("hover:bg-muted hover:text-foreground border border-transparent")).toEqual({
      fg: "--foreground",
      bg: ["--background", 100],
      declaresBackground: false,
      border: undefined,
    });
    // A declared border IS reported, so the 1.4.11 boundary of an outline
    // control is visible to the gate rather than assumed absent.
    expect(resting("border-border bg-background").border).toEqual(["--border", 100]);
    // Dark-only utilities apply in dark mode only.
    expect(resting("bg-background dark:bg-input/30", "light").bg).toEqual(["--background", 100]);
    expect(resting("bg-background dark:bg-input/30", "dark").bg).toEqual(["--input", 30]);
    // A variant that declares no fill says so, which is what makes it get
    // tested against --card and --muted rather than assuming --background.
    expect(resting("text-foreground").declaresBackground).toBe(false);
    expect(resting("bg-muted text-foreground").declaresBackground).toBe(true);
    // Alpha modifiers are carried through rather than flattened to the token.
    expect(resting("bg-destructive/10 text-destructive").bg).toEqual(["--destructive", 10]);
    // An arbitrary value is not a token reference.
    expect(resting("bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]").bg).toEqual([
      "--background",
      100,
    ]);
  });

  it("refuses to model two unconditional utilities of the same kind", () => {
    // The StatusBadge defect this repo already shipped: two `bg-*` on one
    // element, merge failed, both survived. Picking the first would model the
    // result instead of reporting it.
    expect(() => restingColours("bg-primary bg-success", "light")).toThrow(/unconditional/);
    expect(() => restingColours("text-primary text-success-foreground", "light")).toThrow(
      /unconditional/,
    );
    // An unprefixed utility and its `dark:` override is the normal pairing, not
    // a conflict, and must not trip the guard.
    expect(() => restingColours("bg-destructive/10 dark:bg-destructive/20", "dark")).not.toThrow();
  });

  it("round-trips sRGB through OKLab", () => {
    // The previous self-test for this transform used only black, white and
    // white@37% — precisely the inputs where "cbrt(gamma)" and "cbrt(linear)"
    // agree, so it could not have caught the missing linearisation. This one
    // sweeps the range and both models' agreement point disappears.
    for (const v of [0, 0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98, 1]) {
      const grey: Rgb = [v, v, v];
      const back = oklabToSrgb(srgbToOklab(grey));
      for (const channel of back) {
        expect(Math.abs(channel - v), `grey ${v} round-tripped to ${channel}`).toBeLessThan(1e-6);
      }
    }
    // Chromatic too: the brand hexes, and every token the palette is built from.
    for (const hex of ["#05ab29", "#066fc4", "#bf140b", "#b5bdbb", "#35a677", "#172099"]) {
      const source = hexToRgb(hex);
      const back = oklabToSrgb(srgbToOklab(source));
      expect(Math.max(...back.map((c, i) => Math.abs(c - source[i]!))), hex).toBeLessThan(1e-6);
    }
  });

  it("satisfies OKLab's defining property: L == Y^(1/3) for neutrals", () => {
    // This is the property the broken transform violated, stated as a property
    // rather than as three magic numbers, so it holds at any lightness.
    for (const v of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const [L] = srgbToOklab([v, v, v]);
      expect(L, `L at sRGB ${v}`).toBeCloseTo(Math.cbrt(srgbToLinear(v)), 7);
    }
    // And the specific figures the review reproduced, to three decimals.
    expect(srgbToOklab([0.1, 0.1, 0.1])[0]).toBeCloseTo(0.2156, 3);
    expect(srgbToOklab([0.5, 0.5, 0.5])[0]).toBeCloseTo(0.5982, 3);
    expect(srgbToOklab([0.9, 0.9, 0.9])[0]).toBeCloseTo(0.9234, 3);
  });

  it("does not confuse cbrt(gamma) with cbrt(linear) — the bug this replaced", () => {
    // Stated as a negative so a future refactor that drops the linearisation
    // fails here with a readable diff rather than silently shifting every
    // tinted ratio in the suite.
    const [L] = srgbToOklab([0.5, 0.5, 0.5]);
    expect(L).not.toBeCloseTo(Math.cbrt(0.5), 3); // the old, wrong answer
  });

  it("composites tints with a model, not an accident, and keeps the two honest", () => {
    // Endpoints are exact under both models.
    const black: Rgb = [0, 0, 0];
    const white: Rgb = [1, 1, 1];
    expect(rgbToHex(mixOklab(black, white, 0))).toBe("#ffffff");
    expect(rgbToHex(mixOklab(black, white, 100))).toBe("#000000");
    expect(rgbToHex(mixOklab(white, white, 37))).toBe("#ffffff");

    // The 50% neutral is the one interior value both models must agree on, and
    // it is NOT the sRGB average: oklab's L is not linear in gamma-encoded sRGB,
    // which is the whole reason for compositing here rather than averaging
    // channels.
    expect(rgbToHex(mixOklab(black, white, 50))).toBe("#636363");
    expect(rgbToHex(compositeGammaSrgb(black, white, 50))).toBe("#808080");
    expect(rgbToHex(mixOklab(black, white, 50))).not.toBe("#808080");

    // The two models are genuinely different computations, not aliases.
    const brand = hexToRgb("#05ab29");
    expect(rgbToHex(mixOklab(brand, white, 30))).not.toBe(
      rgbToHex(compositeGammaSrgb(brand, white, 30)),
    );
  });

  it("the two compositing models agree on every surface the shipped variants use", () => {
    // The gate holds the MINIMUM of the two models, which is only a guard
    // against future divergence rather than a permanent tax while they agree.
    // Where they diverge, which one is right depends on the browser's painting
    // path, and a 1.4.11 or AA verdict must not hinge on that — so the gap is
    // measured on the exact quantity the gate decides on: the FOREGROUND
    // contrast the painted surface produces, per variant, mode and host.
    //
    // MEASURED, not guessed: the largest gap on today's palette is 0.45:1, on
    // `button:outline` in dark mode (12.21:1 oklab vs 11.76:1 gamma-sRGB on
    // `--background`), and 0.32:1 on `--card`. That is the same pair the review
    // quoted as 4.76:1 under the broken transform, and it clears AA by more than
    // 7:1 of margin under either, so the 0.5 threshold below sits just above the
    // observed maximum: a change that pushes the models apart materially trips
    // this, and today's noise does not.
    const MAX_GAP = 0.5;
    const divergences: string[] = [];
    for (const [, rel] of DIRECT_VARIANT_SOURCES) {
      for (const [variant, classString] of Object.entries(
        cvaVariantClasses(readFileSync(join(REPO_ROOT, rel), "utf8")),
      )) {
        for (const mode of ["light", "dark"] as const) {
          const vars = mode === "light" ? rootVars : darkVars;
          const painted = restingColours(classString, mode);
          const foreground = resolveRgb(requireToken(vars, painted.fg), vars);
          for (const host of ["--background", "--card", "--muted"] as const) {
            const backdrop = resolveRgb(requireToken(vars, host), vars);
            const tint = resolveRgb(requireToken(vars, painted.bg[0]), vars);
            const gap = Math.abs(
              contrast(foreground, mixOklab(tint, backdrop, painted.bg[1])) -
                contrast(foreground, compositeGammaSrgb(tint, backdrop, painted.bg[1])),
            );
            if (gap > MAX_GAP) {
              divergences.push(
                `${rel} variant=${variant} ${mode} on ${host}: models differ by ${gap.toFixed(2)}:1`,
              );
            }
          }
        }
      }
    }
    expect(divergences, divergences.join("; ")).toEqual([]);
  });
});

describe("the font actually resolves", () => {
  /*
   * M3. `--font-sans` used to be declared `var(--font-sans)` — a custom property
   * referencing itself. Per spec that is invalid at computed-value time and
   * resolves to the guaranteed-invalid value, so `font-family: var(--font-sans)`
   * resolves to nothing and the element falls back to the system font.
   *
   * It LOOKED fine only because `next/font` emits its `--font-*` variable
   * unlayered on the element, and an unlayered declaration outranks any
   * `@layer`. Put the font into a layer, or let next/font change how it emits,
   * and every heading reverts with no error anywhere.
   *
   * The fix is shadcn's own convention: next/font owns `--font-geist-sans` and
   * Tailwind's theme points at it. These assertions pin all three links —
   * next/font's declaration, the theme bridge, and the absence of a cycle — so
   * renaming one end without the other fails here instead of silently.
   */

  const LAYOUT = readFileSync(join(REPO_ROOT, "app", "layout.tsx"), "utf8");
  const themeVars = declarations(topLevelRuleFor(GLOBALS_CSS, "@theme inline")?.body ?? "");

  /** Follows `var(--x)` references the way the browser does. Throws on a cycle. */
  function resolveVarChain(start: string, vars: Map<string, string>): string[] {
    const chain: string[] = [];
    let current = start;
    while (current !== undefined) {
      if (chain.includes(current))
        throw new Error(`circular reference: ${[...chain, current].join(" -> ")}`);
      chain.push(current);
      const next = /^var\(\s*(--[\w-]+)\s*\)$/.exec((vars.get(current) ?? "").trim())?.[1];
      if (next === undefined) return chain;
      current = next;
    }
    return chain;
  }

  it("no declaration in @theme inline references itself", () => {
    // The general form of the defect, so the next token that tries it fails too.
    const selfReferential = [...themeVars.entries()]
      .filter(([name, value]) => value.trim() === `var(${name})`)
      .map(([name]) => name);

    expect(
      selfReferential,
      `self-referential custom properties: ${selfReferential.join(", ")}`,
    ).toEqual([]);
  });

  it.each(["--font-sans", "--font-heading"])(
    "%s resolves through --font-geist-sans, not itself",
    (name) => {
      expect(themeVars.get(name)).toBe("var(--font-geist-sans)");
      // The browser's own algorithm, run over the declarations: follow the var()
      // reference until it lands on a non-reference. A cycle throws.
      expect(resolveVarChain(name, themeVars)).toEqual([name, "--font-geist-sans"]);
    },
  );

  it("app/layout.tsx declares the custom property the theme points at", () => {
    // The far end of the chain. If next/font's variable is renamed without the
    // theme following, `--font-geist-sans` is simply never declared and every
    // heading silently falls back — with both of the assertions above still
    // green, because the theme's own text is unchanged.
    expect(LAYOUT).toMatch(/variable:\s*["']--font-geist-sans["']/);
    expect(LAYOUT).not.toMatch(/variable:\s*["']--font-sans["']/);
    expect(LAYOUT).toMatch(/className=\{geist\.variable\}/);
  });

  it("the heading utility is actually used, so the chain has a consumer", () => {
    // `--font-heading` existing is not the same as anything reaching for it.
    expect(
      readFileSync(join(REPO_ROOT, "components", "shared", "page-header.tsx"), "utf8"),
    ).toContain("font-heading");
  });
});

describe("no hard-coded colour outside the token blocks", () => {
  it("app/globals.css carries no hex outside :root and .dark", () => {
    const offenders = findHexLiterals(GLOBALS_CSS);
    expect(offenders, `hex literals in globals.css: ${offenders.join(", ")}`).toEqual([]);
  });

  it.each(scannedUiSource())("%s contains no hex literal", (_label, file) => {
    expect(stripComments(readFileSync(file, "utf8")).match(HEX_LITERAL) ?? []).toEqual([]);
  });

  it.each(scannedUiSource())("%s uses no off-palette Tailwind colour class", (_label, file) => {
    expect(offPaletteClasses(readFileSync(file, "utf8"), file.endsWith(".css"))).toEqual([]);
  });

  it.each(scannedUiSource(true))("%s calls no literal colour function", (_label, file) => {
    expect(stripComments(readFileSync(file, "utf8")).match(LITERAL_COLOUR_FUNCTION) ?? []).toEqual(
      [],
    );
  });
});

describe("the hex rule is not vacuous", () => {
  // Prefixed with the statements a real globals.css opens with, so the
  // fixture also proves an `@import` does not get absorbed into the `:root`
  // prelude and hide the block from the range exclusion.
  const withTokens = [
    '@import "tailwindcss";',
    "@custom-variant dark (&:is(.dark *));",
    ":root {",
    "  --brand-primary: oklch(0.6442 0.2049 144.41); /* #05ab29 */",
    "  --background: oklch(0.985 0.002 250);",
    "}",
    ".dark {",
    "  --brand-primary: oklch(0.75 0.19 144.41);",
    "}",
  ].join("\n");

  it("ignores a hex documented inside a token block", () => {
    expect(findHexLiterals(withTokens)).toEqual([]);
  });

  it("reports a hex planted in a top-level @layer base rule", () => {
    expect(findHexLiterals(`${withTokens}\n@layer base { body { background: #123456; } }`)).toEqual(
      ["#123456"],
    );
  });

  it("reports a hex in a top-level @theme bridge", () => {
    expect(findHexLiterals(`${withTokens}\n@theme inline { --color-x: #05ab29; }`)).toEqual([
      "#05ab29",
    ]);
  });

  it("reports a hex in a :root nested inside @media — nesting is not a token block", () => {
    expect(
      findHexLiterals(`${withTokens}\n@media (min-width: 40rem) { :root { --x: #abcdef; } }`),
    ).toEqual(["#abcdef"]);
  });

  it("reports a hex in a rule nested inside .dark", () => {
    expect(findHexLiterals(`${withTokens}\n.dark body { color: #abcdef; }`)).toEqual(["#abcdef"]);
  });

  it("reports 3-digit and 8-digit forms too", () => {
    expect(findHexLiterals("@theme inline { --a: #fff; --b: #05ab29ff; }")).toEqual([
      "#fff",
      "#05ab29ff",
    ]);
  });

  /*
   * The controls above prove the globals.css scoping. These two prove the
   * component scan is not vacuous either — it is the assertion that actually
   * matches the brief's constraint, "no component may hardcode a hex", and a
   * gate that passes because it walked zero files is not a gate.
   */
  it("walks the component tree, so the per-file assertions have files to assert on", () => {
    const files = scannedUiFiles();
    const code = files.filter((file) => /\.(tsx?)$/.test(file));
    const css = files.filter((file) => file.endsWith(".css"));

    // Exact counts, so a change to the scan roots or to the file extensions is
    // a visible diff rather than a silent narrowing. Measured, not guessed: the
    // hex and palette rules run on both kinds of file, the literal
    // colour-function rule on code only — every token declaration in a
    // stylesheet is an `oklch(` call, so that rule cannot apply to CSS at all.
    //
    // (Round 1 and round 2 of this report both said "17 x 3 = 51" for the
    // per-file count. Both were wrong twice over: there were 18 code files then
    // as well, and `.css` files never got three cases. Only the *delta* of 3
    // from a temporary demo route survived, which is the one number the
    // controller's audit confirmed.)
    expect(css).toEqual(["app/globals.css", "app/shadcn.css"]);
    // Task 3 added lib/permissions/registry.ts, which is not UI surface but
    // lives under a scan root — the gate scans it rather than trusting the
    // directory a file happens to sit in. 16 -> 17 code files; measured.
    // Task 11 added lib/utils/money.ts and lib/utils/datetime.ts on the same
    // reasoning: neither is UI surface, but both sit under lib/, and a module
    // that slipped past the gate would let a hard-coded hex into the codebase
    // unnoticed. 17 -> 19 code files; measured.
    expect(code.length + css.length).toBe(21);
    expect(code.length).toBe(19);

    expect(files).toContain("components/shared/status-badge.tsx");
    // `lib/` used to be outside the scan roots, so a component placed there was
    // invisible and the gate went quiet without failing.
    expect(files).toContain("lib/utils/cn.ts");
    expect(files).toContain("lib/utils/money.ts");
    expect(files).toContain("lib/utils/datetime.ts");
  });

  it("applies the colour-function rule to code only, and the other two to CSS too", () => {
    // The scoping is deliberate and asserted rather than implied, because the
    // three rules differ for a reason: `.css` files may legitimately contain
    // `oklch(` inside the token blocks, but may never contain a hex outside
    // them or an off-palette class at all.
    expect(
      scannedUiSource(true)
        .map(([label]) => label)
        .sort(),
    ).toEqual(
      scannedUiFiles()
        .filter((file) => /\.(tsx?)$/.test(file))
        .sort(),
    );
    expect(scannedUiSource().length).toBe(scannedUiFiles().length);
    // And the difference is exactly the stylesheets.
    expect(scannedUiSource().length - scannedUiSource(true).length).toBe(2);
  });

  it("flags a hex pasted into a component the same way it flags one in CSS", () => {
    // The per-file assertion is `stripComments(source).match(HEX_LITERAL)`, run
    // over each file's own contents. Reproduced here on synthetic source so a
    // future edit to `stripComments` or to HEX_LITERAL cannot quietly neuter
    // the scan.
    //
    // DELIBERATE LOOPHOLE: a hex inside a COMPONENT COMMENT is not reported,
    // because `stripComments` runs first. That is intentional — a component
    // comment is allowed to say "--brand-neutral is #b5bdbb", and globals.css
    // depends on the same behaviour for its token provenance. The cost is that
    // a colour could in principle be parked in a comment to evade the gate; the
    // benefit is that the palette cannot be documented at the point of use.
    // The loophole is stated here because a silent loophole is how a gate stops
    // meaning anything.
    const flagged = (source: string): string[] => stripComments(source).match(HEX_LITERAL) ?? [];
    expect(flagged('<span className="bg-[#05ab29]">')).toEqual(["#05ab29"]);
    expect(flagged('const c = "#b5bdbb"; // brand neutral, see globals.css')).toEqual(["#b5bdbb"]);
    expect(flagged('/* --brand-neutral is #b5bdbb */\n<span className="bg-muted" />')).toEqual([]);
    expect(flagged('<span className="bg-muted text-foreground" />')).toEqual([]);
  });

  it("flags off-palette Tailwind classes and literal colour functions", () => {
    // Negative controls for the two rules added after review. `bg-red-500` is
    // the exact class tests/unit/cn.test.tsx uses, which is why the reviewer
    // could name a violation this gate would have waved through.
    const palette = (source: string): string[] => offPaletteClasses(source, false);
    expect(palette('<span className="bg-red-500" />')).toEqual(["-red-500"]);
    expect(palette('<span className="border-slate-200 text-zinc-900" />')).toEqual([
      "-slate-200",
      "-zinc-900",
    ]);
    expect(palette('<span className="bg-primary text-brand-navy border-border" />')).toEqual([]);
    expect(palette('<span className="bg-muted text-muted-foreground" />')).toEqual([]);
    // A palette word inside an identifier must not match.
    expect(palette('const redundancy = "blue-500";')).toEqual([]);
    // And it must not match inside a comment, for the same reason hex does not.
    expect(palette('/* not bg-red-500, this is prose */\n<span className="bg-muted" />')).toEqual(
      [],
    );
  });

  it("flags an off-palette class applied inside a stylesheet, not only in a component", () => {
    // N-E. The palette rule used to run on code files only, which meant
    // `@apply bg-red-500` in app/globals.css passed every rule. The colour-
    // function rule still cannot cover CSS — every token declaration is an
    // `oklch(` call — but the palette rule can and now does.
    const css = (source: string): string[] => offPaletteClasses(source, true);

    expect(css("@layer base { body { @apply bg-red-500; } }")).toEqual(["-red-500"]);
    expect(css("@media (min-width: 40rem) { .thing { @apply text-zinc-900; } }")).toEqual([
      "-zinc-900",
    ]);
    // The token blocks stay exempt, exactly as for hex: that is where the
    // palette is declared. A `var(--blue-500)` written on a token declaration
    // is inside the block and is not this gate's business.
    expect(
      css(
        ":root {\n  --brand-primary: oklch(0.6442 0.2049 144.41); /* #05ab29 */\n  --x: var(--blue-500);\n}\n@layer base { body { @apply bg-primary; } }",
      ),
    ).toEqual([]);
    // The same class one rule outside the blocks is reported.
    expect(
      css(":root { --x: oklch(0.5 0 0); }\n@layer base { body { @apply var(--blue-500); } }"),
    ).toEqual(["-blue-500"]);
    // Comments are still prose.
    expect(css("/* migrated from bg-red-500 */\n.a { @apply bg-primary; }")).toEqual([]);
    // And a clean stylesheet stays clean.
    expect(css("@layer base { body { @apply bg-background text-foreground; } }")).toEqual([]);
  });

  it("flags literal colour functions in code but not in a stylesheet", () => {
    const fn = (source: string): string[] =>
      stripComments(source).match(LITERAL_COLOUR_FUNCTION) ?? [];
    expect(fn('style={{ color: "oklch(0.6 0.2 30)" }}')).toEqual(["oklch("]);
    expect(fn('style={{ color: "hsl(210 80% 40%)" }}')).toEqual(["hsl("]);
    // `color-mix` over two tokens is a token-derived colour, not a literal —
    // components/ui/button.tsx ships exactly this and must stay legal.
    expect(
      fn(
        '<Button className="hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]" />',
      ),
    ).toEqual([]);
    expect(fn('<span className="bg-primary text-primary-foreground" />')).toEqual([]);
  });
});
