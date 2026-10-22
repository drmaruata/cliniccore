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
 * has been mutation-checked - eighteen mutations, each caught.
 *
 * WHY THE HTTP-CLIENT RULE IS A WHITELIST. A deny-list of known-bad packages can only
 * catch the packages somebody thought of. The rule here is that `lib/` may import
 * NOTHING that is not on a short, explicit list, so a new HTTP client is a test failure
 * rather than a review comment.
 *
 * WHY THE TYPES ARE PINNED AT THE TYPE LEVEL. The five input/output types are invisible
 * at run time - `Object.keys` cannot see a type - so no runtime assertion can hold them
 * still. A mutation that turned `amountMinor` from `bigint` into `number` would leave
 * every test in this file green, because the tests never see the type. The pins below
 * are therefore COMPILE-TIME, and `npm run typecheck` is the gate that enforces them.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as providerModule from "@/lib/billing/provider";
import * as unconfiguredModule from "@/lib/billing/unconfigured";
import { stripComments } from "@/scripts/check-no-secrets";
import type { Minor } from "@/lib/utils/money";
import type {
  CheckoutInput,
  CheckoutSession,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookEvent,
} from "@/lib/billing/provider";

const { PaymentNotConfiguredError, getPaymentProvider, isPaymentConfigured } = providerModule;

const REPO_ROOT = process.cwd();
const LIB_ROOT = join(REPO_ROOT, "lib");
const BILLING_ROOT = join(LIB_ROOT, "billing");

/** The interface's method names, pinned so the loop below is never vacuous. */
const EXPECTED_METHODS = ["createCheckout", "refund", "verifyWebhook"];

/**
 * The modules of the seam, and what each may export.
 *
 * ONE map drives three things: which files may exist in the seam, what each of them may
 * export, and which of them are scanned for a provider that could take money. A module
 * added to the seam therefore cannot escape the provider scan - the previous version
 * listed the two modules in the scan itself, so a module added later would have been
 * scanned by nobody.
 *
 * PHASE 8 EXTENDS THIS MAP. The guarantee that survives is "no fake can be added
 * without a test failing" - and extending the map is how a REAL provider is added,
 * deliberately, rather than a fake slipping in unnoticed.
 */
const SEAM_MODULES: Record<string, Record<string, unknown>> = {
  "lib/billing/provider.ts": providerModule as unknown as Record<string, unknown>,
  "lib/billing/unconfigured.ts": unconfiguredModule as unknown as Record<string, unknown>,
};

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
 *
 * `react` joined the list in Task 17, for `lib/auth/platform.ts`'s `cache()` - React's
 * per-request memoisation, which is how a layout and a page share one database round
 * trip inside a request. It is a framework runtime and not a way to reach the
 * network, which is what this list is about.
 *
 * PHASE 8 EXTENDS THIS LIST, to admit the provider's SDK.
 */
const SANCTIONED_LIB_PACKAGES = new Set([
  "@supabase/ssr",
  "@supabase/supabase-js",
  "clsx",
  "next/headers",
  "next/server",
  "react",
  "server-only",
  "tailwind-merge",
  "zod",
]);

/**
 * The directories a file under `lib/` may reach with a relative import.
 *
 * `lib/` and `types/` - the latter holds the GENERATED database types, which four
 * modules import and which are not in `lib/`. Anything else - a vendored copy of a
 * client, say - is outside what this application sanctions, and a relative import is
 * exactly how it would be reached.
 */
const ALLOWED_LIB_CONTAINERS = [LIB_ROOT, join(REPO_ROOT, "types")];

/** The source extensions the scans read. A `.md` file in the seam is not a module. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

type AnyMethod = (...args: unknown[]) => unknown;

/**
 * COMPILE-TIME PINS ON THE FIVE TYPES.
 *
 * These are the assertions that hold the type surface still, and `npm run typecheck` is
 * the gate that runs them. A runtime test cannot do this job: a type is invisible to
 * `Object.keys`, so a mutation that turned `amountMinor` from `bigint` into `number`
 * would leave every runtime test in the repository green.
 */
/**
 * Whether A is assignable to B.
 *
 * WRAPPED IN A TUPLE so the conditional is NOT distributive, and deliberately free of
 * function types. Prettier 3.9.10 REMOVES the parentheses around a function type in a
 * conditional type's `extends` clause - `(<T>() => T extends Y ? 1 : 2)` becomes
 * `<T>() => T extends Y ? 1 : 2` - and that CHANGES the meaning: the canonical
 * `Equal<X, Y>` type silently becomes `true` for every pair, which is the worst kind
 * of control, because it reads like a working one. MEASURED: with the paren-stripped
 * form, a mutation that turned `amountMinor` into `number` passed typecheck.
 */
type Extends<A, B> = [A] extends [B] ? true : false;

/**
 * Every member must be `true`.
 *
 * NOT an intersection of `Equal`s. `true & false` is still ASSIGNABLE to `true`, so a
 * constraint of `extends true` is satisfied by an intersection containing a `false` -
 * and the first version of these pins, which intersected them, caught nothing. MEASURED:
 * the same mutation passed typecheck with the intersection, and fails with a tuple. A
 * tuple reports WHICH position failed.
 */
type AllTrue<T extends readonly true[]> = T;

/**
 * Two types that are the same type for our purposes: mutually assignable.
 *
 * A DEFERRED conditional rather than `AllTrue<[...]>`, because a constraint is checked
 * eagerly and the members are not known to be `true` while X and Y are still type
 * parameters. The check happens at the instantiation, which is where it belongs.
 */
/** A type's keys are exactly these, in both directions - nothing missing, nothing extra. */
type KeysAre<X, K extends string> = [Extends<K, keyof X>] extends [true]
  ? [Extends<keyof X, K>] extends [true]
    ? true
    : false
  : false;

type Same<X, Y> = [Extends<X, Y>] extends [true]
  ? [Extends<Y, X>] extends [true]
    ? true
    : false
  : false;

type Expect<T extends true> = T;

type _EveryAmountIsPaise = AllTrue<
  [
    Same<CheckoutInput["amountMinor"], Minor>,
    Same<CheckoutSession["amountMinor"], Minor>,
    Same<RefundInput["amountMinor"], Minor>,
    Same<RefundResult["amountMinor"], Minor>,
    Same<WebhookEvent["amountMinor"], Minor | null>,
  ]
>;

type _TheProviderHasTheThreeMethods = AllTrue<
  [
    Extends<"configured", keyof PaymentProvider>,
    Extends<"createCheckout", keyof PaymentProvider>,
    Extends<"refund", keyof PaymentProvider>,
    Extends<"verifyWebhook", keyof PaymentProvider>,
    Extends<keyof PaymentProvider, "configured" | "createCheckout" | "refund" | "verifyWebhook">,
  ]
>;

type _TheFactoryReturnsTheProvider = Expect<
  Same<ReturnType<typeof getPaymentProvider>, PaymentProvider>
>;

type _AProviderRefuses = AllTrue<
  [
    Extends<ReturnType<PaymentProvider["createCheckout"]>, Promise<CheckoutSession>>,
    Extends<ReturnType<PaymentProvider["verifyWebhook"]>, Promise<WebhookEvent>>,
    Extends<ReturnType<PaymentProvider["refund"]>, Promise<RefundResult>>,
  ]
>;

/**
 * The KEY SETS of the five types, pinned.
 *
 * A field that silently disappears is as much a hole as a field that changes type: a
 * `WebhookEvent` without `refundId` cannot report how an ASYNCHRONOUS refund ended, and
 * a `RefundInput` without `organizationId` cannot say whose money is being refunded.
 *
 * PHASE 8 EXTENDS THESE, and a deliberate extension is a diff in this file.
 */
type _TheCheckoutNamesTheTenant = Expect<
  KeysAre<
    CheckoutInput,
    "amountMinor" | "currency" | "description" | "idempotencyKey" | "organizationId" | "planCode"
  >
>;

type _TheCheckoutNamesTheOrder = Expect<
  KeysAre<
    CheckoutSession,
    "amountMinor" | "currency" | "expiresAt" | "providerOrderId" | "providerSessionId" | "url"
  >
>;

type _TheEventNamesTheOrderAndTheRefund = Expect<
  KeysAre<
    WebhookEvent,
    | "amountMinor"
    | "currency"
    | "eventId"
    | "eventType"
    | "occurredAt"
    | "providerOrderId"
    | "providerPaymentId"
    | "providerSessionId"
    | "refundId"
  >
>;

type _TheRefundNamesTheTenant = Expect<
  KeysAre<
    RefundInput,
    "amountMinor" | "idempotencyKey" | "organizationId" | "providerPaymentId" | "reasonCode"
  >
>;

type _TheRefundResultNamesThePayment = Expect<
  KeysAre<RefundResult, "amountMinor" | "currency" | "providerPaymentId" | "refundId" | "status">
>;

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

/**
 * Every source file under a directory.
 *
 * Symlinks are FOLLOWED, because a scanner that silently skips a file is the failure
 * this project has been bitten by repeatedly - and a symlink out of the directory is
 * exactly how a file would go missing. The visited set stops a symlink loop.
 */
function sourceFilesUnder(dir: string, seen = new Set<string>()): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const isDirectory =
      entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory());
    if (isDirectory) {
      const real = realpathOrSelf(full);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push(...sourceFilesUnder(full, seen));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found;
}

function realpathOrSelf(file: string): string {
  try {
    return statSync(file).isDirectory() ? join(file, ".") : file;
  } catch {
    return file;
  }
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

/**
 * The module specifiers a file names, with COMMENTS REMOVED.
 *
 * Without the strip, a line of prose inside a block comment that happens to look like
 * an import would be reported as a dependency that does not exist. A rule that fires on
 * English is a rule that gets switched off.
 */
function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
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
 * environment" is deliberately NOT a match.
 */
const ENV_ACCESS_PATTERNS = [
  /process\s*\.\s*env\b/,
  /process\s*\[\s*['"`]env['"`]\s*\]/,
  /\b(?:const|let|var)\s*\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/,
  /from\s*['"]node:process['"]/,
];

/** Whether a resolved path is inside a directory. */
function isInside(path: string, directory: string): boolean {
  const normalised = path.split(/[\\/]/).join("/");
  const root = directory.split(/[\\/]/).join("/");
  return normalised === root || normalised.startsWith(root + "/");
}

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

  it("hands out the very stub it exported, frozen", () => {
    // The stub is EXPORTED and the factory hands out that object, so a caller holding
    // it could `Object.assign` a working createCheckout onto it and every other caller
    // would receive the fake. Frozen, the assignment throws instead of succeeding.
    expect(getPaymentProvider()).toBe(unconfiguredModule.unconfiguredProvider);
    expect(Object.isFrozen(unconfiguredModule.unconfiguredProvider)).toBe(true);
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
    // the export pin below cannot see a module it does not know about. The same map
    // drives the file list and the provider scan, so a module added here cannot escape
    // either.
    expect(sourceFilesUnder(BILLING_ROOT).map(rel).sort()).toEqual(
      Object.keys(SEAM_MODULES).sort(),
    );
  });

  it("exports nothing new from the modules that exist", () => {
    // The brief forbids a "test mode" that returns a successful fake payment, because
    // that would misrepresent payment capability. Pinning the runtime exports is how
    // that is proved rather than asserted.
    for (const [file, module] of Object.entries(SEAM_MODULES)) {
      expect(Object.keys(module).sort(), `${file} exports`).toEqual(EXPECTED_EXPORTS[file] ?? []);
    }
  });

  it("exports no provider that could take money", async () => {
    // Whichever module a provider-like object appears in, and whichever SHAPE it has,
    // it must be unconfigured and must refuse. This is the check that survives a fake
    // being added to any module of the seam, as an object or as a class.
    for (const [file, module] of Object.entries(SEAM_MODULES)) {
      for (const [name, value] of Object.entries(module)) {
        if (!isProviderLike(value)) continue;
        if (typeof value === "object" && value !== null) {
          expect(
            (value as { configured?: unknown }).configured,
            `${file}:${name} must not be configured`,
          ).toBe(false);
        }
        const methods = providerMethodsOf(value);
        expect(
          methods.map(([method]) => method).sort(),
          `${file}:${name} must have the provider's methods`,
        ).toEqual(EXPECTED_METHODS);
        for (const [method, fn] of methods) {
          await expect(
            Promise.resolve().then(() => fn.call(value)),
            `${file}:${name}.${method} must reject`,
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
          expect(
            isInside(target, BILLING_ROOT),
            `${rel(file)} imports ${specifier}, which is outside the seam`,
          ).toBe(true);
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
        if (specifier.startsWith(".")) {
          // A relative import must reach a sanctioned container, for the same reason
          // the seam's own relative imports must stay inside the seam.
          const target = resolve(dirname(file), specifier);
          expect(
            ALLOWED_LIB_CONTAINERS.some((container) => isInside(target, container)),
            `${where}: ${specifier} (leaves the sanctioned containers)`,
          ).toBe(true);
          continue;
        }
        if (specifier.startsWith("@/")) {
          const target = resolve(REPO_ROOT, specifier.slice(2));
          expect(isInside(target, LIB_ROOT), `${where}: ${specifier} (leaves lib/)`).toBe(true);
          continue;
        }
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
