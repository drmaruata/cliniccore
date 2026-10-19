/**
 * Clinic-timezone helpers.
 *
 * WHY EVERY ONE OF THESE TAKES AN EXPLICIT ZONE. A clinic's day is not a UTC day. A
 * patient's appointment at 00:30 in Kolkata happened on a different calendar date than
 * the same instant in UTC, and billing a clinic's day from a UTC boundary silently moves
 * an hour of consultations into the wrong day - twice a year, at daylight saving. So no
 * function here ever reads the ambient server zone; the zone is a required argument, and
 * the tests are written so that an implementation which ignores it produces a DIFFERENT
 * answer rather than accidentally agreeing.
 *
 * WHY clinicDayBounds COMPUTES LOCAL MIDNIGHT RATHER THAN ADDING 24 HOURS. Local midnight
 * is not always exactly 24 hours from the previous local midnight: on a daylight-saving
 * day it is 23 or 25. Adding a fixed 86 400 000 ms produces a window that is an hour out
 * of the clinic's day twice a year, which is precisely the bug this file exists to avoid.
 * For zones without daylight saving - India, most of Asia - the two agree, which is why a
 * test written only against Asia/Kolkata cannot tell the two implementations apart.
 *
 * THE OFFSET IS DERIVED FROM Intl, NOT FROM A TABLE. Zone offsets include quarter hours
 * (Asia/Kathmandu +05:45) and historic changes, so any hard-coded table is wrong
 * somewhere. The local-midnight search takes two passes because the offset at the guessed
 * UTC instant is not always the offset at local midnight itself.
 */

const DATE_PARTS = { year: "numeric", month: "2-digit", day: "2-digit" } as const;

/** The calendar date an instant falls on in `timezone`, as YYYY-MM-DD. */
export function formatInClinicTz(iso: string, timezone: string, locale = "en-CA"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, ...DATE_PARTS }).format(
    new Date(iso),
  );
}

/** Offset of `timeZone` at `at`, in milliseconds east of UTC. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    // Some ICU builds render midnight as hour 24 even with hour12: false.
    field("hour") % 24,
    field("minute"),
    field("second"),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function localMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const first = zoneOffsetMs(new Date(guess), timezone);
  const candidate = guess - first;
  const second = zoneOffsetMs(new Date(candidate), timezone);
  return new Date(second === first ? candidate : guess - second);
}

/**
 * The clinic-local calendar day containing `date`, as an exclusive-end ISO window.
 * Spans 23 or 25 hours on a daylight-saving day.
 */
export function clinicDayBounds(
  date: Date,
  timezone: string,
): { startIso: string; endIso: string } {
  const parts = formatInClinicTz(date.toISOString(), timezone).split("-").map(Number);
  const [year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`Could not read a calendar date for ${date.toISOString()}`);
  }
  const start = localMidnightUtc(year, month, day, timezone);
  const end = localMidnightUtc(year, month, day + 1, timezone);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
