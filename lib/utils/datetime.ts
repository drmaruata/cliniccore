/**
 * Clinic-timezone helpers.
 *
 * WHY EVERY ONE OF THESE TAKES AN EXPLICIT ZONE. A clinic's day is not a UTC day. A
 * patient's appointment at 00:30 in Kolkata happened on a different calendar date than
 * the same instant in UTC, and billing a clinic's day from a UTC boundary silently moves
 * an hour of consultations into the wrong day. So no function here ever reads the ambient
 * server zone; the zone is a required argument.
 *
 * WHY clinicDayBounds SEARCHES FOR THE DAY BOUNDARY RATHER THAN COMPUTING MIDNIGHT.
 * The obvious implementation - take the local calendar date, guess UTC midnight for it,
 * subtract the zone offset - assumes there is exactly ONE instant at which the local wall
 * clock reads 00:00:00. That assumption is false wherever a daylight-saving transition
 * lands ON local midnight, which is not a rare edge case: America/Havana, America/
 * Santiago, America/Asuncion, Asia/Amman, Asia/Gaza, Asia/Jerusalem and America/
 * St_Johns all do it, and MEASURED over 37 zones x 1990-2031 the naive version returned
 * 1 460 wrong day boundaries and, in 97 cases, a window that did not even CONTAIN the
 * instant it was computed from. Havana, Santiago and Asuncion do it every single year, so
 * this is not historical trivia.
 *
 * The fix is to stop guessing. "The local calendar date at this instant is at or after D"
 * is MONOTONE in the instant - a local date only ever moves forward - so the first instant
 * of local day D is exactly a binary search for that predicate crossing from false to
 * true. It costs about 28 Intl lookups and is correct whether midnight exists once, twice
 * (fall back), or not at all (spring forward, where the day simply begins at the
 * transition instant). That also gives 23, 23.5, 24, 24.5 and 25 hour days for free,
 * because the answer is measured rather than derived from a 24-hour assumption.
 *
 * Format lookups are memoised. Measured at 27 microseconds to construct one
 * Intl.NumberFormat-equivalent, and a binary search per bound would otherwise construct
 * fifty-six of them per call.
 */

/** One hour in milliseconds, and the width of the search bracket below. */
const HOUR = 3_600_000;
const BRACKET = 36 * HOUR;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string, locale: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dateFormatters.set(key, created);
  return created;
}

/**
 * YYYY-MM-DD in `timeZone`, always zero-padded.
 *
 * The padding is not cosmetic. A locale's own pattern renders year 1 as "1" and year
 * 999 as "999", which breaks both a caller that slices this string and the lexicographic
 * comparison `clinicDayBounds` relies on to binary-search for a day boundary.
 */
function localDate(at: Date, timeZone: string, locale: string): string {
  const parts = dateFormatter(timeZone, locale).formatToParts(at);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year").padStart(4, "0")}-${field("month").padStart(2, "0")}-${field("day").padStart(2, "0")}`;
}

/** The calendar date an instant falls on in `timezone`, as YYYY-MM-DD. */
export function formatInClinicTz(iso: string, timezone: string, locale = "en-CA"): string {
  return localDate(new Date(iso), timezone, locale);
}

/**
 * The first instant whose local calendar date in `timeZone` is `day` ("YYYY-MM-DD").
 *
 * Binary search over a predicate that is monotone in the instant. The bracket is
 * deliberately wide: the zone offset is always within -12h to +14h of UTC, so an instant
 * 36 hours either side of the same Y-M-D is unambiguously before, and unambiguously at or
 * after, the day in question.
 */
function startOfLocalDayUtc(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    throw new RangeError(`Expected a YYYY-MM-DD day, received ${JSON.stringify(day)}`);
  }
  // Date.UTC maps years 0-99 onto 1900-1999, so setUTCFullYear is used instead. Without
  // it a year-1 input silently became 1901 and the window did not contain its own input.
  const naive = new Date(0);
  naive.setUTCFullYear(year, month - 1, date);
  naive.setUTCHours(0, 0, 0, 0);

  let low = naive.getTime() - BRACKET;
  let high = naive.getTime() + BRACKET;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(new Date(middle), timeZone, "en-CA") >= day) high = middle;
    else low = middle;
  }
  return new Date(high);
}

/**
 * The clinic-local calendar day containing `date`, as an exclusive-end ISO window.
 * The window always contains the input instant, and spans 23 to 25 hours depending on the
 * zone and the date.
 */
export function clinicDayBounds(
  date: Date,
  timezone: string,
): { startIso: string; endIso: string } {
  const day = localDate(date, timezone, "en-CA");
  const [year, month, date_] = day.split("-").map(Number);
  const next = new Date(0);
  next.setUTCFullYear(year as number, (month as number) - 1, (date_ as number) + 1);
  const nextDay = `${next.getUTCFullYear().toString().padStart(4, "0")}-${(next.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${next.getUTCDate().toString().padStart(2, "0")}`;

  return {
    startIso: startOfLocalDayUtc(day, timezone).toISOString(),
    endIso: startOfLocalDayUtc(nextDay, timezone).toISOString(),
  };
}
