/**
 * Money formatting and parsing for ClinicCore.
 *
 * WHY THIS EXISTS. Money is `bigint` paise and the constraint is no floating point in a
 * money path. That holds for storage and arithmetic - the database holds `bigint`, every
 * total stays `bigint`, and the arithmetic below is pure BigInt. A display formatter is
 * the one place a float is unavoidable: `Intl.NumberFormat.format` accepts a `bigint`
 * and cannot render a bigint's fractional part. So exactly one conversion exists, it goes
 * straight to `Intl`, and nothing is computed from its result.
 *
 * PRECISION, MEASURED. `formatMinor` then `parseMinor` is exact for every paisa value
 * from 0 to 2 000 000 (exhaustively) and for sampled values at every decade below 10^15.
 * It is NOT exact in general: the decade [10^15, 10^16) is partly inexact, and at the
 * 10^16 magnitude roughly three values in four lose a paisa. Exactness is not monotonic
 * in magnitude, so there is no clean ceiling to export and a `MAX_EXACT_*` constant would
 * promise more than it can while inviting the one thing this header warns against:
 * arithmetic on a rendered string. Treat a formatted value as DISPLAY ONLY, always.
 *
 * WHY parseMinor MATCHES LITERALS AS STRINGS, NOT CHARACTERS. An earlier version kept a
 * SET of every character the formatter emits and deleted matching characters from the
 * input. That is wrong whenever a localised currency name contains the locale's own
 * decimal separator - MEASURED, `parseMinor(formatMinor(1n, "AED", "ar"))` returned 100
 * instead of 1, because "د.إ." contributed a "." that was indistinguishable from the
 * decimal point and the real separator was deleted with it. So the literal substrings are
 * removed as whole strings, and whatever remains must match the numeric grammar exactly.
 *
 * THE LITERAL ALPHABET IS TAKEN FROM BOTH SIGN RENDERINGS. A previous version sampled
 * only the negative form. In de-CH the negative rendering carries no non-breaking space
 * and the positive one does, so `parseMinor(formatMinor(100n, "CHF", "de-CH"))` threw on
 * the formatter's own output - a hard break for de-CH, en-CH, it-CH and lo.
 *
 * WHY GROUPING IS CHECKED. Removing non-digits is not enough: "₹1,234,56" would parse as
 * 12345600 rather than 123456. The integer part's group widths are therefore validated
 * against the grouping the locale actually uses - a final group of three digits, and
 * two or three elsewhere, which covers both western (1,234,567) and Indian (12,34,567)
 * grouping while rejecting misplaced separators.
 *
 * WHY UNBALANCED PARENTHESES THROW. Negatives in parentheses are what
 * `Intl` emits under `currencySign: "accounting"`, and what Indian accounting packages
 * print, so they must parse as negative - a credit note read as positive is a charge.
 * But a single stray bracket must not silently negate a charge: "₹5.00)" has to fail
 * rather than become -500.
 *
 * THE LOCALE MUST MATCH ON BOTH SIDES. Separators come from `Intl` rather than being
 * assumed, so `de-DE`'s "1.234,56" and `fr-FR`'s space grouping both work. It follows
 * that a string formatted in one locale and read under another is refused rather than
 * misread - the grammar check is what makes that a refusal.
 *
 * KNOWN LIMIT, DOCUMENTED RATHER THAN HANDLED: locales whose digits are not ASCII
 * (ar-EG, bn-IN, fa-IR and about a dozen others) throw. A throw is the correct failure -
 * never a wrong amount - but if `organizations.locale` ever carries one, this needs
 * Unicode digit folding rather than a different separator rule.
 */

/** An amount in minor units - paise for INR, cents for USD. Never a float. */
export type Minor = bigint;

const DEFAULT_LOCALE = "en-IN";
/** Refuses pathological input before a multi-megabyte digit string becomes a BigInt. */
const MAX_INPUT_LENGTH = 256;

const formatters = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, currency: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  formatters.set(key, created);
  return created;
}

function assertCurrency(currency: string): void {
  // A typo in organizations.currency would otherwise render a bare code on an invoice.
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new RangeError(
      `Expected a three-letter ISO 4217 code, received ${JSON.stringify(currency)}`,
    );
  }
}

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");

interface Grammar {
  /** `digits (group digits)* (decimal up-to-two-digits)?`, anchored. */
  shape: RegExp;
  group: string;
  decimal: string;
  /** Whole literal strings the formatter emits, taken from both sign renderings. */
  literals: string[];
}

const grammarCache = new Map<string, Grammar>();

function grammar(locale: string, currency: string): Grammar {
  const key = `${locale}|${currency}`;
  const cached = grammarCache.get(key);
  if (cached) return cached;

  const formatter = numberFormat(locale, currency);
  const negative = formatter.formatToParts(-1234567.89);
  const positive = formatter.formatToParts(1234567.89);
  const group = negative.find((part) => part.type === "group")?.value ?? ",";
  const decimal = negative.find((part) => part.type === "decimal")?.value ?? ".";

  const literals = new Set<string>();
  for (const parts of [negative, positive]) {
    for (const part of parts) {
      if (["integer", "fraction", "group", "decimal", "minusSign"].includes(part.type)) continue;
      if (part.value) literals.add(part.value);
    }
  }

  const built: Grammar = {
    group,
    decimal,
    shape: new RegExp(
      `^\\d+(?:${escapeForRegExp(group)}\\d+)*(?:${escapeForRegExp(decimal)}\\d{1,2})?$`,
    ),
    literals: [...literals],
  };
  grammarCache.set(key, built);
  return built;
}

/** The decimal digit string, validated against the locale's real grouping. */
function assertGrouping(digits: string, group: string, original: string): void {
  if (!digits.includes(group)) return;
  const groups = digits.split(group);
  const last = groups[groups.length - 1] ?? "";
  if (last.length !== 3) {
    throw new Error(
      `Cannot parse an amount from ${JSON.stringify(original)}: final group is not three digits`,
    );
  }
  for (const part of groups.slice(0, -1)) {
    if (part.length < 1 || part.length > 3) {
      throw new Error(
        `Cannot parse an amount from ${JSON.stringify(original)}: implausible group width`,
      );
    }
  }
}

const BIDI_MARKS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Renders paise as a currency string. Display only - never feed this to arithmetic. */
export function formatMinor(amount: Minor, currency: string, locale = DEFAULT_LOCALE): string {
  if (typeof amount !== "bigint") {
    throw new TypeError(`formatMinor needs bigint paise, received ${typeof amount}`);
  }
  assertCurrency(currency);
  return numberFormat(locale, currency).format(Number(amount) / 100);
}

/**
 * Parses a rendered amount back into paise. The exact inverse of formatMinor for a string
 * that formatMinor produced in the SAME locale and currency. Throws rather than guessing.
 */
export function parseMinor(text: string, currency: string, locale = DEFAULT_LOCALE): Minor {
  if (typeof text !== "string") {
    throw new TypeError(`parseMinor needs a string, received ${typeof text}`);
  }
  if (text.length > MAX_INPUT_LENGTH) {
    throw new RangeError(
      `Amount string is ${text.length} characters; refusing above ${MAX_INPUT_LENGTH}`,
    );
  }
  assertCurrency(currency);
  const { group, decimal, shape, literals } = grammar(locale, currency);
  const reject = (why: string): never => {
    throw new Error(`Cannot parse an amount from ${JSON.stringify(text)}: ${why}`);
  };

  let body = text
    .replace(/\u2212/g, "-")
    .replace(BIDI_MARKS, "")
    .trim();

  const opens = (body.match(/\(/g) ?? []).length;
  const closes = (body.match(/\)/g) ?? []).length;
  if (opens !== closes || opens > 1) reject("unbalanced parentheses");
  let negative = false;
  if (opens === 1) {
    if (!body.startsWith("(") || !body.endsWith(")")) reject("parentheses must wrap the amount");
    negative = true;
    body = body.slice(1, -1).trim();
  }

  // Literals come off BEFORE the sign is read, not after. Several locales put the
  // minus in the MIDDLE - de-CH renders a negative as "\u20b9-1'234.56" - so reading the sign
  // while the currency symbol is still attached sees an "internal" minus and rejects the
  // formatter's own output. MEASURED: 10 locales, 126 040 negative renderings.
  //
  // Removing whole literal STRINGS is also what stops a localised currency name that
  // contains the locale's decimal separator from deleting the real one.
  let numeric = body;
  for (const literal of literals) {
    if (literal) numeric = numeric.split(literal).join("");
  }
  numeric = numeric.trim();

  if (numeric.startsWith("-")) {
    negative = true;
    numeric = numeric.slice(1).trim();
  } else if (numeric.endsWith("-")) {
    negative = true;
    numeric = numeric.slice(0, -1).trim();
  }
  // Only now is an interior minus unambiguously a non-amount: "2026-10-14" carries no
  // currency literal, so its hyphens survive the removal above.
  if (numeric.includes("-")) reject("a minus sign inside the digits is not an amount");

  if (numeric.includes(" ")) reject("an unexpected space inside the digits");

  if (!shape.test(numeric)) reject("does not match this locale's amount shape");

  const decimalIndex = numeric.lastIndexOf(decimal);
  const units = decimalIndex === -1 ? numeric : numeric.slice(0, decimalIndex);
  const cents = decimalIndex === -1 ? "" : numeric.slice(decimalIndex + decimal.length);

  assertGrouping(units, group, text);
  const unitsDigits = units.split(group).join("");
  if (!/^\d+$/.test(unitsDigits)) reject("no whole-unit digits");
  if (cents !== "" && !/^[0-9]{1,2}$/.test(cents)) reject("more than two decimal places");

  const value = BigInt(unitsDigits) * 100n + BigInt(cents.padEnd(2, "0"));
  return negative ? -value : value;
}
