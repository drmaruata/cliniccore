/*
 * Money helpers. The project's global constraint is that money is `bigint` paise and no
 * floating point appears in a money path, so most of what follows is about proving that
 * constraint rather than about formatting.
 *
 * Three things this suite exists to catch, in the order they are easy to get wrong:
 *
 *  1. A float sneaking in through the formatter. `Intl.NumberFormat.format` accepts a
 *     bigint but cannot render a bigint's FRACTIONAL part, so a display formatter has to
 *     convert somewhere. That conversion is the single exception in the module, and
 *     `parseMinor` exists so nothing downstream ever has to read the float back. The
 *     round-trip assertions below are what make the exception safe: if the conversion
 *     ever loses a paisa, the round-trip stops holding.
 *  2. Locale-dependent digit grouping. en-IN groups in lakhs (12,34,567.89) and en-US in
 *     thousands (1,234,567.89). A parser that strips the wrong separator, or assumes the
 *     wrong one, silently returns a wrong amount - and a wrong amount in a clinic billing
 *     system is worse than a crash.
 *  3. Sign handling. Bigint `%` keeps the sign of the dividend, so -1500n % 100n is -0n,
 *     not 50n. Getting that wrong turns a refund into a charge.
 */
import { describe, expect, it } from "vitest";

import { formatMinor, parseMinor } from "../../lib/utils/money";

describe("formatMinor", () => {
  it("renders the brief's three examples", () => {
    expect(formatMinor(123456n, "INR")).toContain("1,234.56");
    expect(formatMinor(0n, "INR")).toBe("₹0.00");
    expect(formatMinor(-500n, "INR")).toBe("-₹5.00");
  });

  it("defaults to en-IN lakh grouping, and honours an explicit locale", () => {
    // Same amount, two renderings. If the default silently changes, a receipt saved last
    // month no longer matches one rendered today.
    expect(formatMinor(123456789n, "INR")).toBe("₹12,34,567.89");
    // en-IN and en-US differ only in grouping here; the rupee symbol is the currency's
    // own, so it does not change with the locale.
    expect(formatMinor(123456789n, "INR", "en-US")).toBe("₹1,234,567.89");
  });

  it("always shows exactly two decimal places", () => {
    expect(formatMinor(1n, "INR")).toBe("₹0.01");
    expect(formatMinor(99n, "INR")).toBe("₹0.99");
    expect(formatMinor(100n, "INR")).toBe("₹1.00");
    expect(formatMinor(101n, "INR")).toBe("₹1.01");
  });

  it("formats a non-INR currency without changing the amount", () => {
    expect(formatMinor(123456n, "USD")).toContain("1,234.56");
    expect(formatMinor(123456n, "USD")).toContain("$");
  });
});

describe("the round trip", () => {
  // The brief's spread, plus the sign, the boundaries and a magnitude.
  const SPREAD = [0n, 1n, 99n, 100n, 101n, 999n, 1000n, 123456n, -500n, -1n, -123456n, 123456789n];

  it("recovers the exact paise value from its own output", () => {
    for (const amount of SPREAD) {
      expect(parseMinor(formatMinor(amount, "INR"), "INR"), `${amount}n`).toBe(amount);
    }
  });

  it("recovers the exact value under an explicit locale too", () => {
    for (const amount of SPREAD) {
      expect(parseMinor(formatMinor(amount, "INR", "en-US"), "INR", "en-US"), `${amount}n`).toBe(
        amount,
      );
    }
  });

  it("holds across the whole realistic magnitude range", () => {
    // Exhaustive below 2 000 001 paise and sampled to 10^15 by the measurements recorded
    // in lib/utils/money.ts. Past ~10^16 paise the conversion starts losing a paisa, which
    // is why a formatted amount is display-only at every magnitude rather than merely
    // above some exported cutoff.
    expect(parseMinor(formatMinor(2000000n, "INR"), "INR")).toBe(2000000n);
    for (const ceiling of [10n ** 9n, 10n ** 12n, 10n ** 15n]) {
      expect(parseMinor(formatMinor(ceiling, "INR"), "INR")).toBe(ceiling);
      expect(parseMinor(formatMinor(-ceiling, "INR"), "INR")).toBe(-ceiling);
    }
  });
});

describe("parseMinor", () => {
  it("is tolerant of the shapes a user might paste or a locale might render", () => {
    expect(parseMinor("₹1,234.56", "INR")).toBe(123456n);
    expect(parseMinor("₹12,34,567.89", "INR")).toBe(123456789n);
    expect(parseMinor("-₹5.00", "INR")).toBe(-500n);
    expect(parseMinor("1234.56", "INR")).toBe(123456n);
    expect(parseMinor("  ₹1,234.56  ", "INR")).toBe(123456n);
  });

  it("rejects something that is not an amount rather than returning zero", () => {
    // A silent 0 for unparseable input is how a corrupted figure becomes a real invoice
    // line. Throwing is the safe failure.
    expect(() => parseMinor("not an amount", "INR")).toThrow();
    expect(() => parseMinor("", "INR")).toThrow();
    expect(() => parseMinor("₹", "INR")).toThrow();
  });
});
