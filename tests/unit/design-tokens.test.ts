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

import { describe, expect, it } from "vitest";

import { stripComments } from "@/scripts/check-no-secrets";

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
  const read = (offset: number): number => Number.parseInt(wide.slice(offset, offset + 2), 16) / 255;
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
      L: (raw.endsWith("%") ? Number.parseFloat(raw) : Number.parseFloat(raw)) /
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
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
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
export function resolveRgb(value: string, vars: Map<string, string>, seen: readonly string[] = []): Rgb {
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (ref) {
    const name = ref[1] ?? "";
    if (seen.includes(name)) throw new Error(`circular token reference: ${[...seen, name].join(" -> ")}`);
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
  return contrast(resolveRgb(requireToken(vars, fg), vars), resolveRgb(requireToken(vars, bg), vars));
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
 * Hex literals in `css` that sit OUTSIDE the top-level `:root` / `.dark`
 * token blocks. This is the assertion the gate exists for; it is exported so
 * the negative controls below can prove it is not vacuous.
 */
export function findHexLiterals(css: string): string[] {
  let remainder = css;
  for (const [start, end] of tokenBlockRanges(css).sort((a, b) => b[0] - a[0])) {
    remainder = remainder.slice(0, start) + remainder.slice(end);
  }
  return (remainder.match(HEX_LITERAL) ?? []).map((literal) => literal.toLowerCase());
}

/** Source files that are product UI surface, i.e. where a hex would be a defect. */
function uiSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) uiSourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

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
 * Brand colour used AS TEXT rather than as a fill. A brand hue that clears AA
 * as a fill under its own ink does not clear AA as a label on a light surface,
 * so the two jobs need separate tokens.
 */
const ON_SURFACE = ["--success-ink", "--destructive-ink"] as const;

const ALL_TOKENS = [...Object.keys(BRAND), ...SEMANTIC, ...SUPPORTING, ...ON_SURFACE];

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
];

/** Non-text UI, which WCAG 1.4.11 puts at 3:1. */
const NON_TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--input", "--background"],
  ["--ring", "--background"],
  ["--ring", "--card"],
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
    ["--brand-primary", "--brand-secondary", "--brand-destructive", "--brand-success", "--brand-navy"],
    // ...and the one that moves the other way. #b5bdbb is already a light
    // grey; carrying it unchanged into dark mode would make every table rule
    // and card outline the loudest thing on the page.
    ["--brand-neutral"],
  ])("re-lights every brand colour for dark mode rather than reusing the light value", (...names) => {
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
  });
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
});

describe("no hard-coded colour outside the token blocks", () => {
  it("app/globals.css carries no hex outside :root and .dark", () => {
    const offenders = findHexLiterals(GLOBALS_CSS);
    expect(offenders, `hex literals in globals.css: ${offenders.join(", ")}`).toEqual([]);
  });

  it.each(
    [...uiSourceFiles(join(REPO_ROOT, "components")), ...uiSourceFiles(join(REPO_ROOT, "app"))].map(
      (file) => [file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"), file] as const,
    ),
  )("%s contains no hex literal", (_label, file) => {
    expect(stripComments(readFileSync(file, "utf8")).match(HEX_LITERAL) ?? []).toEqual([]);
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
    expect(findHexLiterals(`${withTokens}\n@layer base { body { background: #123456; } }`)).toEqual([
      "#123456",
    ]);
  });

  it("reports a hex in a top-level @theme bridge", () => {
    expect(findHexLiterals(`${withTokens}\n@theme inline { --color-x: #05ab29; }`)).toEqual(["#05ab29"]);
  });

  it("reports a hex in a :root nested inside @media — nesting is not a token block", () => {
    expect(findHexLiterals(`${withTokens}\n@media (min-width: 40rem) { :root { --x: #abcdef; } }`)).toEqual([
      "#abcdef",
    ]);
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
  it("walks the component tree, so the per-file assertion has files to assert on", () => {
    const files = [...uiSourceFiles(join(REPO_ROOT, "components")), ...uiSourceFiles(join(REPO_ROOT, "app"))];
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith("status-badge.tsx"))).toBe(true);
    expect(files.some((file) => file.endsWith(join("app", "globals.css")))).toBe(true);
  });

  it("flags a hex pasted into a component the same way it flags one in CSS", () => {
    // The per-file assertion is `stripComments(source).match(HEX_LITERAL)`, run
    // over each file's own contents. Reproduced here on synthetic source so a
    // future edit to `stripComments` or to HEX_LITERAL cannot quietly neuter
    // the scan — in particular, a hex inside a component comment is fine (it is
    // documentation) while a hex in the returned className is not.
    const flagged = (source: string): string[] => stripComments(source).match(HEX_LITERAL) ?? [];
    expect(flagged('<span className="bg-[#05ab29]">')).toEqual(["#05ab29"]);
    expect(flagged('const c = "#b5bdbb"; // brand neutral, see globals.css')).toEqual(["#b5bdbb"]);
    expect(flagged('/* --brand-neutral is #b5bdbb */\n<span className="bg-muted" />')).toEqual([]);
    expect(flagged('<span className="bg-muted text-foreground" />')).toEqual([]);
  });
});
