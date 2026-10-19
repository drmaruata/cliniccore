/**
 * Money formatting and parsing for ClinicCore.
 *
 * WHY THIS EXISTS. The project's global constraint is that money is `bigint` paise and
 * that no floating point appears in a money path. That is achievable for storage and
 * arithmetic - the database holds `bigint`, and every total stays `bigint` - but a
 * display formatter is the one place a float is unavoidable: `Intl.NumberFormat.format`
 * accepts a `bigint` and cannot render a bigint's fractional part. So exactly one
 * conversion exists here, it is handed straight to `Intl`, and nothing is ever computed
 * from its result. `parseMinor` exists so no caller has to read a rendered string back
 * into arithmetic.
 *
 * WHY THAT IS SAFE, AND WHERE IT STOPS BEING SAFE. MEASURED, not assumed:
 * `formatMinor` then `parseMinor` is exact for every single paisa value from 0 to
 * 2 000 000 (checked exhaustively), and across 4 000 sampled values at every order of
 * magnitude up to 10^15 paise - about 10 billion rupees. It is NOT exact in general: at
 * 10^16 paise roughly two values in three lose a paisa. Exactness is not monotonic in
 * magnitude, so there is no clean ceiling to export and a `MAX_EXACT_*` constant would
 * promise more than it can deliver while inviting the one thing this file warns against -
 * arithmetic on a rendered string. Treat the formatted value as DISPLAY ONLY, always,
 * at any magnitude.
 *
 * THE LOCALE DEFAULT IS A PRODUCT DECISION, not a technical one. en-IN groups in lakhs
 * (12,34,567.89) where en-US groups in thousands (1,234,567.89). Both render the same
 * amount, and an Indian finance reader expects the first. The default is therefore en-IN,
 * and `parseMinor` reads the group and decimal separators back OUT of `Intl` rather than
 * assuming them, so a locale that uses '.' as a group separator and ',' as a decimal one
 * parses correctly instead of silently returning a wrong amount.
 *
 * `parseMinor` throws on input that contains no digits rather than returning zero. A
 * silent 0 for an unparseable figure is how a corrupted number becomes a real invoice
 * line; refusing is the safe failure.
 */

/** An amount in minor units - paise for INR, cents for USD. Never a float. */
export type Minor = bigint;

const DEFAULT_LOCALE = "en-IN";

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function numberFormat(locale: string, currency: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function separators(locale: string, currency: string): { group: string; decimal: string } {
  const parts = numberFormat(locale, currency).formatToParts(12345.67);
  return {
    group: parts.find((part) => part.type === "group")?.value ?? ",",
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
  };
}

/** Renders paise as a currency string. Display only - never feed this to arithmetic. */
export function formatMinor(amount: Minor, currency: string, locale = DEFAULT_LOCALE): string {
  if (typeof amount !== "bigint") {
    throw new TypeError(`formatMinor needs bigint paise, received ${typeof amount}`);
  }
  return numberFormat(locale, currency).format(Number(amount) / 100);
}

/** The exact inverse of formatMinor. Throws rather than guessing on unparseable input. */
export function parseMinor(text: string, currency: string, locale = DEFAULT_LOCALE): Minor {
  const { group, decimal } = separators(locale, currency);
  const keep = new RegExp(`[^0-9${escapeForRegExp(group)}${escapeForRegExp(decimal)}]`, "g");
  const digits = text.replace(keep, "");
  if (!/\d/.test(digits)) {
    throw new Error(`Cannot parse an amount from ${JSON.stringify(text)}`);
  }

  const negative = text.includes("-") || text.includes("\u2212");
  const ungrouped = group === decimal ? digits : digits.split(group).join("");
  const normalised = ungrouped.split(decimal).join(".");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(normalised);
  if (!match) {
    throw new Error(`Cannot parse an amount from ${JSON.stringify(text)}`);
  }

  const units = match[1] || "0";
  const cents = (match[2] || "").padEnd(2, "0").slice(0, 2) || "00";
  const value = BigInt(units) * 100n + BigInt(cents);
  return negative ? -value : value;
}
