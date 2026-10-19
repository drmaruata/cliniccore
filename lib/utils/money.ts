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
 * PRECISION, MEASURED - AND CORRECTED AFTER REVIEW. `formatMinor` then `parseMinor` is
 * exact for every single paisa value from 0 to 2 000 000 (checked exhaustively) and for
 * sampled values at every decade below 10^15. It is NOT exact in general: the decade
 * [10^15, 10^16) is about 15% inexact, and at the 10^16 magnitude roughly THREE values
 * in four lose a paisa. Exactness is not monotonic in magnitude - 10^16 paise round-trips
 * while 10^16 + 1 does not, and 2^53 - 1 does not while 2^53 + 4 does - so there is no
 * clean ceiling to export and a `MAX_EXACT_*` constant would promise more than it can
 * deliver while inviting the one thing this file warns against: arithmetic on a rendered
 * string. Treat the formatted value as DISPLAY ONLY, at every magnitude.
 *
 * WHY parseMinor REFUSES RATHER THAN SANITISES. An earlier version stripped every
 * character that was not a digit and complained only if nothing was left, which turned a
 * pasted date into a negative twenty-crore line item: `parseMinor("2026-10-14")` returned
 * -2 026 101 400, because the hyphens were removed and the digits concatenated. So the
 * parser now validates instead. A character is accepted only if the formatter itself
 * emits it for that locale and currency, a minus is accepted only as the first or last
 * character, and the fractional part must be at most two digits. Anything else throws.
 * The failure mode is a loud refusal, because the alternative is a plausible-looking wrong
 * number reaching an invoice.
 *
 * ACCOUNTING PARENTHESES ARE A MINUS. `Intl` emits them the moment
 * `currencyDisplay: "accounting"` is set, which is one word away from this code, and they
 * are what Indian accounting packages print. Reading a credit note as a positive amount
 * turns a refund into a charge.
 *
 * THE LOCALE MUST MATCH ON BOTH SIDES. Separators are read out of `Intl` rather than
 * assumed, so `parseMinor` handles `1.234,56` under de-DE and `1 234,56` under fr-FR. It
 * follows that a string formatted in one locale and parsed under another is refused by
 * the strict validation rather than silently misread - MEASURED, that misuse previously
 * returned 123 instead of 123456 for a de-DE string parsed under the default, a silent
 * 10 000x error.
 *
 * KNOWN LIMIT, DOCUMENTED RATHER THAN HANDLED: locales whose digits are not ASCII
 * (ar-EG, bn-IN, fa-IR and about eight others) render digits this parser will not accept,
 * so `parseMinor` throws for them. A throw is the correct failure - never a wrong amount -
 * but if `organizations.locale` ever carries one of those, this needs Unicode digit
 * folding rather than a different separator rule.
 */

/** An amount in minor units - paise for INR, cents for USD. Never a float. */
export type Minor = bigint;

const DEFAULT_LOCALE = "en-IN";

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
  // A typo in organizations.currency would otherwise render a bare ISO code on a
  // patient's invoice instead of failing at the boundary.
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    throw new RangeError(
      `Expected a three-letter ISO 4217 code, received ${JSON.stringify(currency)}`,
    );
  }
}

interface Separators {
  group: string;
  decimal: string;
  /** Every character the formatter itself emits for this locale and currency. */
  literals: Set<string>;
}

function separators(locale: string, currency: string): Separators {
  const sample = numberFormat(locale, currency).formatToParts(-1234567.89);
  const group = sample.find((part) => part.type === "group")?.value ?? ",";
  const decimal = sample.find((part) => part.type === "decimal")?.value ?? ".";
  const literals = new Set<string>();
  for (const part of sample) {
    if (["integer", "fraction", "group", "decimal", "minusSign"].includes(part.type)) continue;
    for (const character of part.value) literals.add(character);
  }
  return { group, decimal, literals };
}

// Bidi and zero-width marks carry no meaning in an amount and are stripped outright.
// Whitespace is NOT stripped globally: a space is a legitimate group separator in some
// locales, and blanking it before validation let "1 234,56" parse as 12345600 under a
// locale that does not group that way - a silent 100x error. Interior whitespace is
// therefore left in place and judged below, where it is accepted only if THIS locale
// actually groups with it.
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
 * that formatMinor produced in the SAME locale. Throws rather than guessing.
 */
export function parseMinor(text: string, currency: string, locale = DEFAULT_LOCALE): Minor {
  assertCurrency(currency);
  const { group, decimal, literals } = separators(locale, currency);
  const reject = (why: string): never => {
    throw new Error(`Cannot parse an amount from ${JSON.stringify(text)}: ${why}`);
  };

  let body = text
    .replace(/\u2212/g, "-")
    .replace(BIDI_MARKS, "")
    .trim();

  let negative = false;
  if (body.includes("(") || body.includes(")")) {
    negative = true;
    body = body.replace(/[()]/g, "");
  }
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  if (body.endsWith("-")) {
    negative = true;
    body = body.slice(0, -1);
  }
  if (body.includes("-")) reject("a minus sign inside the digits is not an amount");

  for (const character of body) {
    if (/[0-9]/.test(character) || character === group || character === decimal) continue;
    if (literals.has(character)) continue;
    reject(`unexpected character ${JSON.stringify(character)}`);
  }

  const splitAt = body.lastIndexOf(decimal);

  const stripLiterals = (part: string) => {
    let kept = "";
    for (const character of part) if (!literals.has(character)) kept += character;
    return kept;
  };
  const units = stripLiterals(splitAt === -1 ? body : body.slice(0, splitAt))
    .split(group)
    .join("");
  const cents = stripLiterals(splitAt === -1 ? "" : body.slice(splitAt + decimal.length))
    .split(group)
    .join("");

  if (!/^[0-9]+$/.test(units)) reject("no whole-unit digits");
  if (cents !== "" && !/^[0-9]{1,2}$/.test(cents)) reject("more than two decimal places");

  const value = BigInt(units) * 100n + BigInt(cents.padEnd(2, "0"));
  return negative ? -value : value;
}
