/**
 * Task 14 - the payment provider seam.
 *
 * WHAT THIS PROVES. The seam exists so that a clinic's billing can be written before a
 * payment provider is chosen, and it must be PROVABLE that nothing about billing is
 * functional yet: every call refuses, no request leaves the server, and no provider SDK
 * is anywhere near the application. A seam that quietly succeeded would be worse than no
 * seam, because it would misrepresent payment capability - the design spec's own words.
 *
 * WHY THE METHOD SET IS PINNED BEFORE THE LOOP. A provider with NO methods would make
 * "every method rejects" vacuously true, which is the failure this project has been
 * bitten by repeatedly: a test that exists, says the right words, and cannot see what it
 * claims to protect. The pin is the control.
 *
 * WHY THE FETCH SPY IS PROVED ABLE TO MOVE. The same reason. A spy that cannot observe a
 * call would make "never called" vacuously true, so the test makes a call the spy CAN
 * see, clears the mock, and only then watches the provider.
 *
 * WHY THE EXPORT SURFACE IS PINNED. The brief forbids a "test mode" that returns a
 * successful fake payment, because that would misrepresent payment capability. The way to
 * prove no such thing is reachable is to pin what the module exports at runtime.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as billing from "@/lib/billing/provider";

const { getPaymentProvider, isPaymentConfigured } = billing;

/** The interface's method names, pinned so the loop below is never vacuous. */
const EXPECTED_METHODS = ["createCheckout", "refund", "verifyWebhook"];

type AnyMethod = (...args: unknown[]) => unknown;

function methodsOf(provider: object): Array<[string, AnyMethod]> {
  return Object.entries(provider).filter(
    (entry): entry is [string, AnyMethod] => typeof entry[1] === "function",
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("payment provider seam", () => {
  it("rejects every provider method with PaymentNotConfiguredError", async () => {
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
        billing.PaymentNotConfiguredError,
      );
    }
  });

  it("names the failure with a stable machine-readable code", () => {
    const error = new billing.PaymentNotConfiguredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("payment_not_configured");
  });

  it("reports the provider as unconfigured", () => {
    expect(isPaymentConfigured()).toBe(false);
    expect(getPaymentProvider().configured).toBe(false);
  });

  it("never issues an HTTP request", async () => {
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
        billing.PaymentNotConfiguredError,
      );
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports no working, fake or test provider", () => {
    // The brief forbids a "test mode" that returns a successful fake payment, because
    // that would misrepresent payment capability. Pinning the runtime exports is how
    // that is proved rather than asserted.
    expect(Object.keys(billing).sort()).toEqual([
      "PaymentNotConfiguredError",
      "getPaymentProvider",
      "isPaymentConfigured",
    ]);
  });

  it("imports no HTTP client and no payment SDK anywhere in lib/", () => {
    const libRoot = join(process.cwd(), "lib");
    const files = sourceFilesUnder(libRoot);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const where = relative(process.cwd(), file);
      for (const specifier of importSpecifiers(source)) {
        if (isForbiddenSpecifier(specifier)) offenders.push(`${where}: ${specifier}`);
      }
      // A global `fetch(...)` needs no import to be found, so the import scan alone
      // would miss it. The pattern requires an opening parenthesis, so prose about
      // fetching does not trip it.
      if (/\bfetch\s*\(/.test(source)) offenders.push(`${where}: calls fetch()`);
    }

    expect(offenders).toEqual([]);
  });

  it("adds no payment SDK to the dependency list", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((name) => /razorpay|stripe|payment|braintree|paypal/i.test(name))).toEqual(
      [],
    );
  });

  it("keeps the seam on the server side of the boundary", () => {
    // The structural half of "no request ever leaves the server": the module refuses to
    // be imported by a client component at all, rather than relying on nobody doing it.
    // Every file in the seam is checked, because a guard on the entry point is only
    // meaningful if the file it reaches is guarded too.
    const billingRoot = join(process.cwd(), "lib", "billing");
    const files = sourceFilesUnder(billingRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${relative(process.cwd(), file)} must be server-only`).toMatch(
        /^\s*import\s+"server-only";/m,
      );
    }
  });
});

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
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

function isForbiddenSpecifier(specifier: string): boolean {
  if (/razorpay|stripe|braintree|paypal/i.test(specifier)) return true;
  if (/^(node:)?(http|http2|https|net|tls)$/.test(specifier)) return true;
  return /^(axios|node-fetch|cross-fetch|undici|got|ky|superagent|request)$/.test(specifier);
}
