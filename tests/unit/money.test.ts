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

describe("parseMinor refuses rather than sanitises", () => {
  // The bug this section exists for: an earlier parser stripped every non-digit, so a
  // pasted date became a negative twenty-crore line item. `parseMinor("2026-10-14")`
  // returned -2026101400, because the hyphens vanished and the digits concatenated.
  it("rejects a date, a phone number and a stray slash", () => {
    expect(() => parseMinor("2026-10-14", "INR")).toThrow();
    expect(() => parseMinor("+91 98765 43210", "INR")).toThrow();
    expect(() => parseMinor("abc 12/2026", "INR")).toThrow();
  });

  it("rejects more than two decimal places instead of truncating", () => {
    expect(() => parseMinor("1234.567", "INR")).toThrow();
    expect(() => parseMinor("1234.5678", "INR")).toThrow();
  });

  it("rejects an amount formatted in one locale and read back in another", () => {
    // Previously a de-DE string under the default returned 123 - a silent 10 000x error.
    expect(() => parseMinor("1.234,56 €", "EUR")).toThrow();
    expect(() => parseMinor("1 234,56 €", "EUR")).toThrow();
  });

  it("rejects a currency that is not a three-letter ISO code", () => {
    for (const typo of ["IN", "INRR", "RUPEE", "1NR", ""]) {
      expect(() => formatMinor(100n, typo), typo).toThrow(RangeError);
    }
    // XYZ is a real ISO 4217 code meaning "no currency", so it is deliberately allowed.
    expect(formatMinor(100n, "XYZ")).toContain("1.00");
    expect(() => parseMinor("1.00", "INR")).not.toThrow();
  });
});

describe("formatMinor guards its input", () => {
  it("refuses anything that is not bigint paise", () => {
    for (const wrong of [1, 1.5, "100", null, undefined, true]) {
      expect(() => formatMinor(wrong as never, "INR"), String(wrong)).toThrow(TypeError);
    }
  });
});

describe("locales beyond the default", () => {
  // A hard-coded `{ group: ",", decimal: "." }` would pass every other test in this file,
  // so these are the assertions that make the separator lookup load-bearing.
  it("round-trips a locale that reverses the separators", () => {
    const rendered = formatMinor(123456n, "EUR", "de-DE");
    // de-DE separates the symbol with a NON-BREAKING space, so the literal string is
    // brittle to assert; the round trip is the assertion that carries the meaning.
    expect(rendered).toContain("1.234,56");
    expect(parseMinor(rendered, "EUR", "de-DE")).toBe(123456n);
  });

  it("round-trips a locale that groups with a space", () => {
    const rendered = formatMinor(123456n, "EUR", "fr-FR");
    expect(parseMinor(rendered, "EUR", "fr-FR")).toBe(123456n);
  });

  it("round-trips in the default locale too, so the locale cases are not the only guard", () => {
    const rendered = formatMinor(123456n, "INR", "en-IN");
    expect(parseMinor(rendered, "INR", "en-IN")).toBe(123456n);
  });

  it("reads accounting parentheses as negative, because Intl can emit them", () => {
    // currencyDisplay:"accounting" is one word away in numberFormat(), and parentheses
    // are what Indian accounting packages print.
    expect(parseMinor("(₹5.00)", "INR")).toBe(-500n);
    expect(parseMinor("(0.01)", "INR")).toBe(-1n);
    expect(parseMinor("₹5.00", "INR")).toBe(500n);
  });

  it("throws rather than returning a wrong amount for a non-ASCII-digit locale", () => {
    // A documented limit, not an oversight: ar-EG renders ١٢٣ and this parser will not
    // fold it. A throw is correct - the alternative is a silently wrong amount.
    const rendered = formatMinor(123456n, "INR", "ar-EG");
    expect(rendered).not.toContain("1");
    expect(() => parseMinor(rendered, "INR", "ar-EG")).toThrow();
  });
});

describe("localised currency names that contain the separator", () => {
  // N1. Keeping a SET of every character the formatter emits, and deleting matching
  // characters, is wrong when the currency's localised name contains the locale's own
  // decimal separator: "د.إ." contributes a "." indistinguishable from the decimal
  // point, so the real separator was deleted along with it and the amount came back 100x
  // too large. MEASURED before the fix, on the formatter's own output.
  it("round-trips where the currency name contains the decimal separator", () => {
    for (const [currency, locale] of [
      ["AED", "ar"],
      ["XCG", "he"],
      ["XCG", "km"],
      ["XCG", "fr-CH"],
      ["EGP", "ar-AE"],
      ["KWD", "ar"],
    ] as const) {
      expect(parseMinor(formatMinor(1n, currency, locale), currency, locale), `${locale}`).toBe(1n);
      expect(
        parseMinor(formatMinor(123456n, currency, locale), currency, locale),
        `${locale}`,
      ).toBe(123456n);
    }
  });

  it("round-trips locales whose positive rendering carries literals the negative one lacks", () => {
    // N2. The literal alphabet was sampled only from the negative form. In de-CH the
    // negative rendering has no non-breaking space and the positive one does, so the
    // formatter's own output was rejected.
    for (const locale of ["en-CH", "de-CH", "it-CH", "lo", "lo-LA"]) {
      expect(parseMinor(formatMinor(100n, "CHF", locale), "CHF", locale), locale).toBe(100n);
    }
  });

  it("rejects a misplaced separator instead of concatenating the digits", () => {
    // N3. Removing non-digits is not enough: these would each parse as a plausible but
    // wrong amount.
    expect(() => parseMinor("₹1,234,56", "INR")).toThrow();
    expect(() => parseMinor("₹1,23", "INR")).toThrow();
    expect(() => parseMinor("₹123,45", "INR")).toThrow();
    // The correctly grouped forms still parse.
    expect(parseMinor("₹1,234.56", "INR")).toBe(123456n);
    expect(parseMinor("₹12,34,567.89", "INR")).toBe(123456789n);
  });

  it("rejects an unbalanced bracket rather than silently negating", () => {
    // N5. A typo in a pasted field must not turn a charge into a credit.
    expect(() => parseMinor("₹5.00)", "INR")).toThrow();
    expect(() => parseMinor("₹(5.00)", "INR")).toThrow();
    expect(() => parseMinor("₹1,000.00)", "INR")).toThrow();
    // Balanced still means negative.
    expect(parseMinor("(₹5.00)", "INR")).toBe(-500n);
  });

  it("refuses an absurdly long input rather than building a huge BigInt", () => {
    expect(() => parseMinor("1".repeat(10_000) + ".00", "INR")).toThrow(RangeError);
  });
});
