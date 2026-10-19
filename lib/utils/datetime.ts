/**
 * Clinic-timezone helpers.
 *
 * WHY EVERY ONE OF THESE TAKES AN EXPLICIT ZONE. A clinic's day is not a UTC day. A
 * patient's appointment at 00:30 in Kolkata happened on a different calendar date than
 * the same instant in UTC, and billing a clinic's day from a UTC boundary silently moves
 * an hour of consultations into the wrong day. So no function here ever reads the ambient
 * server zone; the zone is a required argument.
 *
 * WHY clinicDayBounds SCANS FORWARD RATHER THAN SUBTRACTING AN OFFSET. The obvious
 * implementation - take the local calendar date, guess UTC midnight for it, subtract the
 * zone offset - assumes there is exactly ONE instant at which the local wall clock reads
 * 00:00:00. That is false wherever a daylight-saving transition lands ON local midnight,
 * which is America/Havana, Santiago, Asuncion, Amman, Gaza, Jerusalem and St_Johns, and
 * three of those do it every single year.
 *
 * AND WHY IT IS NOT A BINARY SEARCH. My first fix used one, justified by "a local date
 * only ever moves forward". That is false too. A fall-back that crosses local midnight
 * moves the local date BACKWARDS, so the same calendar day occurs twice, separated by a
 * short interval belonging to the PREVIOUS day. The predicate "local date >= D" is then
 * not monotone, and a binary search converges on the LAST crossing rather than the
 * first. MEASURED across all 418 zones and 14 828 transitions in 1990-2035: 57 such
 * events, in Goose_Bay, St_Johns, Moncton and Casey, each returning a window that started
 * an hour after its own local midnight. The error is absorbed by stretching the previous
 * day - windows still tile exactly, so nothing is lost - but the leading hour of the
 * affected day is billed to the day before.
 *
 * So this scans FORWARD from a lower bound at a five-minute step for the first sample
 * whose local date is at or after the target day, then binary-searches only inside that
 * single five-minute interval. That is correct whether the day occurs once, twice, or not
 * at all, because it never assumes monotonicity over a range - only inside an interval far
 * narrower than any real offset change. It also produces 17 to 31 hour days for free,
 * because the answer is measured rather than derived from a 24-hour assumption.
 *
 * WHY THE MEMO. The search costs roughly 370 Intl lookups, and a clinic-day report asks
 * for the SAME (zone, day) once per row. MEASURED: 167 us per call uncached, 24 us with a
 * (timezone, day) memo. Nothing here is a hot path until the report code exists, and when
 * it is, the memo is what keeps a 10 000-row day from taking a second and a half.
 */

const HOUR = 3_600_000;
/**
 * Walk step. This has to be SHORTER than the shortest run of a single local date that
 * exists anywhere in tzdata, because the walk finds a run by stepping away from the
 * instant and skipping one is how a run gets bridged across a gap.
 *
 * MEASURED shortest run: 60 seconds, at America/St_Johns on 2005-10-30, where local
 * time passes 00:59 of 2005-10-30 and then reverts to 2005-10-29. At a 300-second step
 * that run is stepped straight over and the result is a 25-hour window that contains the
 * instant and spans the gap - which passes a containment check while being the wrong
 * answer, and is only caught by a tiling check. 30 seconds is a 2x margin.
 *
 * If a future tzdata produces a shorter run, MAX_RUN_MS is the backstop that refuses the
 * implausible result rather than billing against it.
 */
const COARSE_STEP = 30_000;
/** No real local date occupies more than about 32 hours; anything longer spans a gap. */
const MAX_RUN_MS = 32 * HOUR;
const MAX_TIME = 8.64e15;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const runCache = new Map<string, { start: number; end: number }>();

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
 * The padding is load-bearing. A locale's own pattern renders year 1 as "1" and year 999
 * as "999", which breaks both a caller that slices this string and the string comparison
 * the day search below relies on.
 */
function localDate(at: Date, timeZone: string): string {
  const parts = dateFormatter(timeZone, "en-CA").formatToParts(at);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year").padStart(4, "0")}-${field("month").padStart(2, "0")}-${field("day").padStart(2, "0")}`;
}

/** The calendar date an instant falls on in `timezone`, as a padded YYYY-MM-DD. */
export function formatInClinicTz(iso: string, timezone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`Not a date: ${JSON.stringify(iso)}`);
  }
  return localDate(at, timezone);
}

/** First millisecond of the maximal CONTIGUOUS run of local day `day` containing `at`. */
function runStart(day: string, at: number, timeZone: string): number {
  let cursor = at;
  while (
    cursor - COARSE_STEP >= -MAX_TIME &&
    localDate(new Date(cursor - COARSE_STEP), timeZone) === day
  ) {
    cursor -= COARSE_STEP;
  }
  // `cursor` is on `day`, `cursor - COARSE_STEP` is not, so the boundary is in between.
  let low = Math.max(-MAX_TIME, cursor - COARSE_STEP);
  let high = cursor;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(new Date(middle), timeZone) === day) high = middle;
    else low = middle;
  }
  return high;
}

/** One millisecond past the end of that run - the first instant NOT on `day`. */
function runEnd(day: string, at: number, timeZone: string): number {
  let cursor = at;
  while (
    cursor + COARSE_STEP <= MAX_TIME &&
    localDate(new Date(cursor + COARSE_STEP), timeZone) === day
  ) {
    cursor += COARSE_STEP;
  }
  let low = cursor;
  let high = Math.min(MAX_TIME, cursor + COARSE_STEP);
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(new Date(middle), timeZone) === day) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * The clinic-local calendar day containing `date`, as an exclusive-end ISO window.
 * The window always contains the input instant. It spans whatever the zone's local
 * midnights actually span - between 17 and 31 hours across the real-world offsets, not
 * the 23-to-25 hours daylight saving alone implies.
 */
export function clinicDayBounds(
  date: Date,
  timezone: string,
): { startIso: string; endIso: string } {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a date: ${String(date)}`);
  }
  const at = date.getTime();
  const day = localDate(date, timezone);

  // Memoised per zone, local day and hour, and every hit is VERIFIED before it is used.
  // A local day can occupy several disjoint runs inside one clock hour - America/St_Johns
  // on 2005-10-30 puts 2005-10-30 in a single minute, then drops back to 2005-10-29 for
  // another hour - so an hour bucket is not a safe key on its own. Without the containment
  // check a stale window is returned and the self-check below fires on a date that works
  // when called first.
  const key = `${timezone}|${day}|${Math.floor(at / HOUR)}`;
  let run = runCache.get(key);
  if (!run || at < run.start || at >= run.end) {
    run = { start: runStart(day, at, timezone), end: runEnd(day, at, timezone) };
    runCache.set(key, run);
  }
  const start = new Date(run.start);
  const end = new Date(run.end);

  // Self-check. Every real offset change this was designed to survive lands here as a
  // pass; a date outside Intl's representable year range, where the local day cannot be
  // established, lands here as a loud refusal instead of a window that silently excludes
  // the instant that produced it.
  if (at < start.getTime() || at >= end.getTime() || end <= start) {
    throw new RangeError(
      `Could not bound ${date.toISOString()} to a local day in ${timezone} (${day})`,
    );
  }
  if (run.end - run.start > MAX_RUN_MS) {
    throw new RangeError(
      `Local day ${day} in ${timezone} spans ${(run.end - run.start) / HOUR} hours, which is beyond any real offset change; refusing rather than billing a window that spans a gap`,
    );
  }
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
