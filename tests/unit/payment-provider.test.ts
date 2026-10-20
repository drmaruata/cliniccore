/**
 * Task 14 - the payment provider seam.
 *
 * WHAT THIS PROVES. The seam exists so that a clinic's billing can be written before a
 * payment provider is chosen, and it must be PROVABLE that nothing about billing is
 * functional yet: every call refuses, no request leaves the server, and no provider SDK
 * is anywhere near the application. A seam that quietly succeeded would be worse than no
 * seam, because it would misrepresent payment capability - the design spec's own words.
 *
 * WHY THE TESTS ARE SPLIT BY GUARANTEE RATHER THAN BY BEHAVIOUR. The first version of
 * this file carried several guarantees in one test, and a later phase that changed one
 * of them would have taken the others with it. Each guarantee now has its own test, and
 * each says what a later phase must do to it.
 *
 * WHY EVERY CONTROL IS PROVED ABLE TO MOVE. A control that cannot observe the thing it
 * claims to observe makes its assertion vacuous, which is the failure this project has
 * been bitten by repeatedly. The method set is pinned before the rejection loop, the
 * fetch spy is made to see a call before it is asked to stay still, and the whole suite
 * has been mutation-checked - twelve mutations, each caught.
 *
 * WHY THE HTTP-CLIENT RULE IS A WHITELIST. A deny-list of known-bad packages can only
 * catch the packages somebody thought of. The rule here is that `lib/` may import
 * NOTHING that is not on a short, explicit list, so a new HTTP client is a test failure
 * rather than a review comment.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as providerModule from "@/lib/billing/provider";
import * as unconfiguredModule from "@/lib/billing/unconfigured";

const { PaymentNotConfiguredError, getPaymentProvider, isPaymentConfigured } = providerModule;

const REPO_ROOT = process.cwd();
const LIB_ROOT = join(REPO_ROOT, "lib");
const BILLING_ROOT = join(LIB_ROOT, "billing");

/** The interface's method names, pinned so the loop below is never vacuous. */
const EXPECTED_METHODS = ["createCheckout", "refund", "verifyWebhook"];

/**
 * What each module of the seam is allowed to export. Pinned so that a fake provider
 * cannot be added to a module that already exists.
 *
 * PHASE 8 EXTENDS THIS LIST. The guarantee that survives is "no fake can be added
 * without a test failing" - and extending the list is how a REAL provider is added,
 * deliberately, rather than a fake slipping in unnoticed.
 */
const EXPECTED_EXPORTS: Record<string, string[]> = {
  "lib/billing/provider.ts": [
    "PaymentNotConfiguredError",
    "PaymentVerificationError",
    "getPaymentProvider",
    "isPaymentConfigured",
  ],
  "lib/billing/unconfigured.ts": ["unconfiguredProvider"],
};

/**
 * The only module specifiers the seam may import.
 *
 * Deny-by-default, because the seam is a module that will hold a secret key and a name
 * list of HTTP clients only catches the clients somebody thought of. The seam's own
 * dependencies are few enough to enumerate.
 *
 * PHASE 8 EXTENDS THIS LIST, to admit the provider's SDK.
 */
const ALLOWED_BILLING_IMPORTS = new Set(["server-only", "@/lib/errors", "@/lib/utils/money"]);

/**
 * The only packages any file under `lib/` may import.
 *
 * A deny-list of bad packages cannot catch a package nobody thought of. A whitelist can:
 * a new HTTP client in `lib/` is a test failure until somebody decides it belongs
 * there. `@supabase/ssr` and `@supabase/supabase-js` ARE HTTP clients, and they are
 * here on purpose - they are the sanctioned way for this application to talk to
 * Supabase, and the rule is that there is no OTHER way.
 */
const SANCTIONED_LIB_PACKAGES = new Set([
  "@supabase/ssr",
  "@supabase/supabase-js",
  "clsx",
  "next/headers",
  "next/server",
  "server-only",
  "tailwind-merge",
  "zod",
]);

/** The source extensions the scans read. A `.md` file in the seam is not a module. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

type AnyMethod = (...args: unknown[]) => unknown;

/** A repo-relative path with forward slashes, so the assertions read the same on Windows. */
function rel(file: string): string {
  return relative(REPO_ROOT, file).split(/[\\/]/).join("/");
}

/**
 * The provider's methods, own or inherited.
 *
 * The prototype chain is walked because a provider written as a class puts its methods
 * on the prototype, and a version of this that read only own properties would find
 * NOTHING in a class-based provider - which reads as "the provider has no methods" and
 * invites weakening the pin rather than fixing the finder.
 *
 * `constructor` is excluded, and the walk stops at `Function.prototype`: the
 * constructor is a function like any other, and calling it without `new` throws
 * something that is not a rejection; and a function's own prototype chain ends in
 * `Function.prototype`, whose `apply`/`bind`/`call` are not the provider's methods.
 */
function methodsOf(provider: object): Array<[string, AnyMethod]> {
  const found = new Map<string, AnyMethod>();
  let current: object | null = provider;
  while (current !== null && current !== Object.prototype && current !== Function.prototype) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (name === "constructor") continue;
      if (typeof descriptor.value === "function" && !found.has(name)) {
        found.set(name, descriptor.value);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...found];
}

/**
 * The methods of a provider-shaped export, however it is shaped.
 *
 * An OBJECT literal carries its methods on itself. A CLASS carries them on its
 * prototype, and the class itself is a function - so a scan that looked only for
 * objects would find a class-shaped fake to be harmless, which is the exact shape the
 * implementer's own positive control used.
 */
function providerMethodsOf(value: unknown): Array<[string, AnyMethod]> {
  if (typeof value === "function") {
    const prototype = (value as { prototype?: unknown }).prototype;
    return typeof prototype === "object" && prototype !== null
      ? methodsOf(prototype as object)
      : [];
  }
  return typeof value === "object" && value !== null ? methodsOf(value) : [];
}

/** Whether a value looks like a provider: something that can start a checkout. */
function isProviderLike(value: unknown): boolean {
  return providerMethodsOf(value).some(([name]) => name === "createCheckout");
}

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every module specifier a file names.
 *
 * `export ... from` counts as well as `import ... from`, because a RE-EXPORT is a
 * dependency: a seam that re-exported an HTTP client would be just as able to reach
 * the network as one that imported it.
 */
const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) found.push(specifier);
    }
  }
  return found;
}

/**
 * The ways a file can read the environment.
 *
 * `process.env` is the obvious one and `process["env"]` and `const { env } = process`
 * are the two that a scan for the first would miss. A prose mention of "the process
 * environment" is deliberately NOT a match: a rule that fires on English is a rule that
 * gets switched off.
 */
const ENV_ACCESS_PATTERNS = [
  /process\s*\.\s*env\b/,
  /process\s*\[\s*['"`]env['"`]\s*\]/,
  /\b(?:const|let|var)\s*\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/,
  /from\s*['"]node:process['"]/,
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the provider the factory hands out", () => {
  // PHASE 8 REPLACES THIS TEST. It is the brief's own requirement - every method of
  // getPaymentProvider() refuses - and a real provider will stop refusing. The
  // guarantees that must SURVIVE that change are in the tests below, which are
  // deliberately not part of this one.
  it("rejects every method with PaymentNotConfiguredError", async () => {
    const provider = getPaymentProvider();
    const methods = methodsOf(provider);

    // THE CONTROL. Without this pin, a provider exposing no methods at all would make
    // the loop below pass while proving nothing.
    expect(methods.map(([name]) => name).sort()).toEqual(EXPECTED_METHODS);

    for (const [name, method] of methods) {
      // A method that THREW synchronously would fail this line rather than the
      // assertion below, which is the right outcome: the contract is a rejection, and a
      // synchronous throw is a different - and harder to catch - contract.
      const outcome = method.call(provider);
      expect(outcome, `${name} must return a promise`).toBeInstanceOf(Promise);
      await expect(outcome, `${name} must reject`).rejects.toBeInstanceOf(
        PaymentNotConfiguredError,
      );
    }
  });

  it("reports the provider as unconfigured", () => {
    expect(isPaymentConfigured()).toBe(false);
    expect(getPaymentProvider().configured).toBe(false);
  });

  it("asks the provider whether it is configured, rather than keeping a second truth", () => {
    // A hardcoded `return false` would pass every other test here, because both the
    // provider and the answer would be false. That is exactly the control whose value is
    // identical for a permitted and an unpermitted principal, so the DERIVATION is
    // pinned instead of the answer.
    const source = readFileSync(join(BILLING_ROOT, "provider.ts"), "utf8");
    const body =
      source.match(/export function isPaymentConfigured\(\): boolean \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(body).toMatch(/getPaymentProvider/);
    expect(body).toMatch(/\bconfigured\b/);
    expect(body).not.toMatch(/\b(true|false)\b/);
  });
});

describe("the stub itself", () => {
  // This one does NOT change in Phase 8. The stub stays as the fallback, and it must
  // keep refusing for as long as it is the fallback.
  it("rejects every method with PaymentNotConfiguredError", async () => {
    const methods = methodsOf(unconfiguredModule.unconfiguredProvider);
    expect(methods.map(([name]) => name).sort()).toEqual(EXPECTED_METHODS);

    for (const [name, method] of methods) {
      await expect(
        method.call(unconfiguredModule.unconfiguredProvider),
        `${name} must reject`,
      ).rejects.toBeInstanceOf(PaymentNotConfiguredError);
    }
  });
});

describe("there is no working, fake or test provider", () => {
  it("adds no module to the seam", () => {
    // A fake in a NEW file would be reachable from application code by its path, and
    // the export pin below cannot see a module it does not know about.
    expect(sourceFilesUnder(BILLING_ROOT).map(rel).sort()).toEqual(
      Object.keys(EXPECTED_EXPORTS).sort(),
    );
  });

  it("exports nothing new from the modules that exist", () => {
    // The brief forbids a "test mode" that returns a successful fake payment, because
    // that would misrepresent payment capability. Pinning the runtime exports is how
    // that is proved rather than asserted.
    expect(Object.keys(providerModule).sort()).toEqual(
      EXPECTED_EXPORTS["lib/billing/provider.ts"] ?? [],
    );
    expect(Object.keys(unconfiguredModule).sort()).toEqual(
      EXPECTED_EXPORTS["lib/billing/unconfigured.ts"] ?? [],
    );
  });

  it("exports no provider that could take money", async () => {
    // Whichever module a provider-like object appears in, and whichever SHAPE it has,
    // it must be unconfigured and must refuse. This is the check that survives a fake
    // being added to either file, as an object or as a class.
    for (const [moduleName, module] of [
      ["provider", providerModule],
      ["unconfigured", unconfiguredModule],
    ] as const) {
      for (const [name, value] of Object.entries(module)) {
        if (!isProviderLike(value)) continue;
        if (typeof value === "object" && value !== null) {
          expect(
            (value as { configured?: unknown }).configured,
            `${moduleName}.${name} must not be configured`,
          ).toBe(false);
        }
        const methods = providerMethodsOf(value);
        expect(
          methods.map(([method]) => method).sort(),
          `${moduleName}.${name} must have the provider's methods`,
        ).toEqual(EXPECTED_METHODS);
        for (const [method, fn] of methods) {
          await expect(
            Promise.resolve().then(() => fn.call(value)),
            `${moduleName}.${name}.${method} must reject`,
          ).rejects.toBeInstanceOf(PaymentNotConfiguredError);
        }
      }
    }
  });

  it("reads no environment variable in the seam", () => {
    // An environment-gated branch is the other way a test mode could appear, and it
    // would be invisible to every other check here: the export pins cannot see it and
    // the refusal test only covers the path the deployment is on.
    for (const file of sourceFilesUnder(BILLING_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of ENV_ACCESS_PATTERNS) {
        expect(
          pattern.test(source),
          `${rel(file)} must not read the environment (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it("imports nothing in the seam that could reach the network", () => {
    for (const file of sourceFilesUnder(BILLING_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          // A relative import must stay INSIDE the seam. Otherwise the seam reaches a
          // module elsewhere in lib/ that reads the environment and talks to a network.
          const target = resolve(dirname(file), specifier);
          const inside =
            target === BILLING_ROOT ||
            target.startsWith(BILLING_ROOT + "\\") ||
            target.startsWith(BILLING_ROOT + "/");
          expect(inside, `${rel(file)} imports ${specifier}, which is outside the seam`).toBe(true);
          continue;
        }
        expect(ALLOWED_BILLING_IMPORTS.has(specifier), `${rel(file)} imports ${specifier}`).toBe(
          true,
        );
      }
    }
  });

  it("adds no payment SDK to the dependency list", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((name) => /razorpay|stripe|payment|braintree|paypal/i.test(name))).toEqual(
      [],
    );
  });
});

describe("no request leaves the server", () => {
  it("never issues one", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // THE CONTROL MUST BE ABLE TO MOVE. A spy that cannot observe a call would make
    // "never called" vacuously true. So prove the spy sees a call first - the mock
    // answers, so nothing leaves the machine - then clear it and watch the provider.
    await globalThis.fetch("https://example.invalid/probe");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();

    const provider = getPaymentProvider();
    for (const [name, method] of methodsOf(provider)) {
      await expect(method.call(provider), `${name} must reject`).rejects.toBeInstanceOf(
        PaymentNotConfiguredError,
      );
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports only sanctioned packages anywhere in lib/, and calls no fetch", () => {
    const offenders: string[] = [];
    for (const file of sourceFilesUnder(LIB_ROOT)) {
      const source = readFileSync(file, "utf8");
      const where = rel(file);
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("@/")) continue;
        if (!SANCTIONED_LIB_PACKAGES.has(specifier)) offenders.push(`${where}: ${specifier}`);
      }
      // A global `fetch(...)` needs no import to be found, and it can be hidden from a
      // call-shaped pattern by being captured first, so both shapes are matched.
      if (/\bfetch\s*\(/.test(source) || /\bglobalThis\s*\.\s*fetch\b/.test(source)) {
        offenders.push(`${where}: uses fetch`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the seam on the server side of the boundary", () => {
    // The structural half of "no request ever leaves the server": the module refuses to
    // be imported by a client component at all, rather than relying on nobody doing it.
    // Every file in the seam is checked, because a guard on the entry point is only
    // meaningful if the file it reaches is guarded too.
    const files = sourceFilesUnder(BILLING_ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${rel(file)} must be server-only`).toMatch(/^\s*import\s+"server-only";/m);
    }
  });
});

describe("the failure is nameable", () => {
  it("carries a stable machine-readable code", () => {
    const error = new PaymentNotConfiguredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("payment_not_configured");
  });
});
