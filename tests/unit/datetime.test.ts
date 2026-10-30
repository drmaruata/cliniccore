/*
 * Clinic-timezone helpers. Every one of these takes an explicit IANA zone and must use
 * it. The failure this suite exists to catch is a helper that quietly falls back to the
 * server's ambient zone: on a UTC host that renders 23:30 as "today", and on a host in
 * some other zone it renders something different again. The bug is invisible until a
 * clinic's day boundary lands in the wrong place, and it is invisible in CI precisely
 * because CI is UTC and a UTC-only implementation looks correct there.
 *
 * So the assertions here are chosen so that an implementation which ignores its
 * `timezone` argument produces a DIFFERENT answer, not the same one.
 */
import { describe, expect, it } from "vitest";

import {
  clinicDayBounds,
  clinicDayBoundsForDay,
  clinicWallTimeToInstant,
  formatInClinicTz,
} from "../../lib/utils/datetime";

describe("formatInClinicTz", () => {
  it("formats the local calendar date in the clinic's zone", () => {
    // The brief's own example. It asserts 2026-10-15, which is wrong: 18:00 UTC at
    // UTC+05:30 is 23:30 on 2026-10-14, the same day. Its parenthetical - "23:30 local,
    // the next calendar day" - is self-contradictory, and its sibling assertion that
    // clinicDayBounds starts at 2026-10-13T18:30:00Z is only consistent with the same
    // day. Measured with Intl, asserted here as measured.
    expect(formatInClinicTz("2026-10-14T18:00:00Z", "Asia/Kolkata")).toBe("2026-10-14");
  });

  it("rolls the date over when the local day genuinely does", () => {
    // The case the brief appears to have meant: 19:00 UTC is 00:30 the NEXT day in
    // Kolkata. If this ever returns the input's own UTC date, the zone is being ignored.
    expect(formatInClinicTz("2026-10-14T19:00:00Z", "Asia/Kolkata")).toBe("2026-10-15");
    expect(formatInClinicTz("2026-10-13T18:30:00Z", "Asia/Kolkata")).toBe("2026-10-14");
  });

  it("honours a zone that is behind UTC as well as ahead", () => {
    // 02:00 UTC is 22:00 on the PREVIOUS day in New York. A UTC-only implementation
    // returns 2026-10-14 for both of these.
    expect(formatInClinicTz("2026-10-14T02:00:00Z", "America/New_York")).toBe("2026-10-13");
    expect(formatInClinicTz("2026-10-14T23:00:00Z", "America/New_York")).toBe("2026-10-14");
  });

  it("handles a quarter-hour offset rather than assuming 05:30", () => {
    // +05:45 against +05:30 differs by fifteen minutes, which is enough to put the two
    // zones on DIFFERENT calendar days across one narrow window. An implementation with a
    // hard-coded "add five and a half hours" answers 2026-10-13 here.
    const iso = "2026-10-13T18:20:00Z";
    expect(formatInClinicTz(iso, "Asia/Kolkata")).toBe("2026-10-13");
    expect(formatInClinicTz(iso, "Asia/Kathmandu")).toBe("2026-10-14");
  });
});

describe("clinicDayBounds", () => {
  it("returns the brief's window for a half-hour-offset zone", () => {
    const bounds = clinicDayBounds(new Date("2026-10-14T12:00:00Z"), "Asia/Kolkata");
    expect(bounds.startIso).toBe("2026-10-13T18:30:00.000Z");
    expect(bounds.endIso).toBe("2026-10-14T18:30:00.000Z");
  });

  it("returns the same window whichever instant of that day it is asked about", () => {
    // A day boundary that depends on the time of day it was queried is not a day
    // boundary. Both instants below are the SAME clinic day in Kolkata - note that
    // 2026-10-14T23:59:59Z would NOT be: that is already 05:29 on the 15th locally, and
    // belongs to a different window, which the next test pins.
    const early = clinicDayBounds(new Date("2026-10-14T00:00:01Z"), "Asia/Kolkata");
    const late = clinicDayBounds(new Date("2026-10-14T18:00:00Z"), "Asia/Kolkata");
    expect(early).toEqual(late);
  });

  it("moves to the next window once the clinic's own midnight has passed", () => {
    const before = clinicDayBounds(new Date("2026-10-13T18:29:59Z"), "Asia/Kolkata");
    const after = clinicDayBounds(new Date("2026-10-13T18:30:00Z"), "Asia/Kolkata");
    expect(before.startIso).toBe("2026-10-12T18:30:00.000Z");
    expect(after.startIso).toBe("2026-10-13T18:30:00.000Z");
    expect(before.endIso).toBe(after.startIso);
  });

  it("keeps the window inside the local calendar day it names", () => {
    for (const [instant, zone, expectedLocalDay] of [
      ["2026-10-14T12:00:00Z", "Asia/Kolkata", "2026-10-14"],
      ["2026-10-14T02:00:00Z", "America/New_York", "2026-10-13"],
      ["2026-10-14T18:00:00Z", "Asia/Kathmandu", "2026-10-14"],
    ] as const) {
      const bounds = clinicDayBounds(new Date(instant), zone);
      const start = new Date(bounds.startIso);
      const end = new Date(bounds.endIso);
      // Local midnight is the floor and the next local midnight is the ceiling.
      expect(formatInClinicTz(bounds.startIso, zone)).toBe(expectedLocalDay);
      expect(formatInClinicTz(bounds.endIso, zone)).not.toBe(expectedLocalDay);
      expect(start.getTime()).toBeLessThan(new Date(instant).getTime());
      expect(end.getTime()).toBeGreaterThan(new Date(instant).getTime());
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    }
  });

  it("spans 23 and 25 hours on a daylight-saving day rather than a fixed 24", () => {
    // New York springs forward on 2026-03-08 and falls back on 2026-11-01. A fixed
    // 24-hour window drifts an hour out of the clinic's day on both, which is the whole
    // point of computing local midnight rather than adding 86 400 000 ms. The brief only
    // ever describes the no-DST case, where the two agree.
    expect(
      new Date(
        clinicDayBounds(new Date("2026-03-08T16:00:00Z"), "America/New_York").endIso,
      ).getTime() -
        new Date(
          clinicDayBounds(new Date("2026-03-08T16:00:00Z"), "America/New_York").startIso,
        ).getTime(),
    ).toBe(23 * 60 * 60 * 1000);

    const fall = clinicDayBounds(new Date("2026-11-01T16:00:00Z"), "America/New_York");
    expect(new Date(fall.endIso).getTime() - new Date(fall.startIso).getTime()).toBe(
      25 * 60 * 60 * 1000,
    );
  });
});

describe("zones whose transition lands on local midnight", () => {
  // The failure this section exists for. America/Havana, America/Santiago,
  // America/Asuncion, Asia/Amman, Asia/Gaza, Asia/Jerusalem and America/St_Johns all
  // shift the offset AT local midnight, so there is either no instant whose wall clock
  // reads 00:00:00, or two of them. An implementation that computes local midnight and
  // subtracts the offset returned a window that did not contain its own input:
  // MEASURED over 37 zones x 1990-2031, 1 460 wrong boundaries and 97 such instants.
  // Three of those zones do it every single year.
  it("returns a window that contains the instant it was computed from", () => {
    const cases = [
      ["America/Havana", "2000-04-02T04:30:00Z"],
      ["America/Havana", "2000-04-02T04:59:59Z"],
      ["America/Santiago", "1990-09-16T03:00:00Z"],
      ["America/Asuncion", "2000-10-01T03:30:00Z"],
      ["Asia/Amman", "2022-02-25T21:00:00Z"],
      ["America/St_Johns", "2020-03-29T04:00:00Z"],
      ["Asia/Colombo", "2000-12-31T19:00:00Z"],
    ] as const;

    for (const [zone, iso] of cases) {
      const at = new Date(iso).getTime();
      const bounds = clinicDayBounds(new Date(iso), zone);
      const start = new Date(bounds.startIso).getTime();
      const end = new Date(bounds.endIso).getTime();
      expect(start, `${zone} ${iso} start must not exceed the instant`).toBeLessThanOrEqual(at);
      expect(end, `${zone} ${iso} end is exclusive and must exceed the instant`).toBeGreaterThan(
        at,
      );
      // The window names the day the instant actually falls on, not an adjacent one.
      expect(formatInClinicTz(bounds.startIso, zone)).toBe(formatInClinicTz(iso, zone));
    }
  });

  it("gives the Havana transition day its true 24 hours, not a shortened day", () => {
    // The wall clock skips 00:00-01:00 that day, but the elapsed time between two local
    // midnights is still 24 hours. The earlier version reported 23.
    const bounds = clinicDayBounds(new Date("2000-04-02T04:30:00Z"), "America/Havana");
    expect(new Date(bounds.endIso).getTime() - new Date(bounds.startIso).getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("handles a half-hour daylight-saving shift", () => {
    // Lord Howe moves by 30 minutes, not 60 - a quarter-hour DST zone is the case any
    // offset-in-minutes arithmetic tuned for whole hours gets wrong.
    const spring = clinicDayBounds(new Date("2026-04-05T13:00:00Z"), "Australia/Lord_Howe");
    expect(new Date(spring.endIso).getTime() - new Date(spring.startIso).getTime()).toBe(
      24.5 * 60 * 60 * 1000,
    );
  });

  it("handles an offset that is not a whole number of minutes", () => {
    // Asia/Kolkata was on local mean time (+05:53:28) before 1906, so even a "no-DST"
    // zone has sub-minute offsets for historical dates.
    const at = new Date("0001-06-15T12:00:00Z").getTime();
    const bounds = clinicDayBounds(new Date("0001-06-15T12:00:00Z"), "Asia/Kolkata");
    expect(new Date(bounds.startIso).getTime()).toBeLessThanOrEqual(at);
    expect(new Date(bounds.endIso).getTime()).toBeGreaterThan(at);
  });
});

describe("the date string is always four-digit padded", () => {
  // A locale's own pattern renders year 1 as "1" and year 999 as "999", which breaks a
  // caller that slices the result and breaks the lexicographic comparison the day
  // search relies on.
  it("pads years below 1000", () => {
    expect(formatInClinicTz(new Date("0001-06-15T12:00:00Z").toISOString(), "Asia/Kolkata")).toBe(
      "0001-06-15",
    );
    expect(formatInClinicTz(new Date("0999-01-01T00:00:00Z").toISOString(), "Asia/Kolkata")).toBe(
      "0999-01-01",
    );
  });

  it("never reports a day earlier than 1970 for a date that is not", () => {
    // Date.UTC maps years 0-99 onto 1900-1999, so the pre-1900 case silently became 1901.
    const bounds = clinicDayBounds(new Date("0001-06-15T12:00:00Z"), "Asia/Kolkata");
    expect(bounds.startIso.startsWith("0001-06-1")).toBe(true);
  });
});

describe("a fall-back that crosses local midnight", () => {
  // The second time this bug appeared, and the harder one. A fall-back that moves the
  // local date BACKWARDS makes one calendar day occupy two disjoint stretches of real
  // time, so "the local day" is not one interval. My first fix assumed a local date only
  // ever moves forward and binary-searched for the crossing - which converges on the
  // LAST crossing, not the first. MEASURED: 57 such events in Goose_Bay, St_Johns,
  // Moncton and Casey, each returning a window that began an hour after its own midnight.
  //
  // The rule now is the maximal CONTIGUOUS run of the local date containing the instant,
  // which is what a contiguous window can honestly represent, and which tiles exactly.
  it("returns the run containing the instant, for every split the reviewer named", () => {
    const cases = [
      ["America/Goose_Bay", "1990-10-28T03:00:00Z"],
      ["America/Goose_Bay", "1990-10-28T03:01:00Z"],
      ["America/Moncton", "1993-10-31T03:00:00Z"],
      ["America/St_Johns", "2005-10-30T02:30:00Z"],
      ["America/St_Johns", "2005-10-30T02:31:00Z"],
      ["Antarctica/Casey", "2010-03-04T15:00:00Z"],
    ] as const;
    for (const [zone, iso] of cases) {
      const at = new Date(iso).getTime();
      const bounds = clinicDayBounds(new Date(iso), zone);
      const start = new Date(bounds.startIso).getTime();
      const end = new Date(bounds.endIso).getTime();
      expect(start, `${zone} ${iso}`).toBeLessThanOrEqual(at);
      expect(end, `${zone} ${iso}`).toBeGreaterThan(at);
      expect(formatInClinicTz(bounds.startIso, zone)).toBe(formatInClinicTz(iso, zone));
    }
  });

  it("tiles a split day with no gap and no overlap", () => {
    // Adjacent distinct windows must meet exactly. A gap silently loses billable time
    // and an overlap double-counts it.
    const distinct = (zone: string, baseIso: string) => {
      const base = new Date(baseIso).getTime();
      const windows: string[] = [];
      let previous: string | null = null;
      for (let step = 0; step < 288; step += 1) {
        const bounds = clinicDayBounds(new Date(base + step * 300_000), zone);
        const signature = `${bounds.startIso}|${bounds.endIso}`;
        if (signature === previous) continue;
        if (previous !== null && windows.length > 0) {
          expect(bounds.startIso, `${zone} must meet the previous window exactly`).toBe(
            windows[windows.length - 1],
          );
        }
        windows.push(bounds.endIso);
        previous = signature;
      }
      return windows.length;
    };
    expect(distinct("America/St_Johns", "2005-10-30T00:00:00Z")).toBeGreaterThan(1);
    expect(distinct("America/Goose_Bay", "1990-10-28T00:00:00Z")).toBeGreaterThan(1);
    expect(distinct("Asia/Kolkata", "2026-10-14T00:00:00Z")).toBeGreaterThan(0);
  });

  it("is not fooled by two runs inside one clock hour", () => {
    // America/St_Johns puts 2005-10-30 into a SINGLE MINUTE at 02:30Z and then reverts
    // to 2005-10-29. Two instants in the same hour are in different runs, so a cache
    // keyed on the hour alone returns a window belonging to the other one.
    const before = clinicDayBounds(new Date("2005-10-30T02:25:00Z"), "America/St_Johns");
    const during = clinicDayBounds(new Date("2005-10-30T02:30:00Z"), "America/St_Johns");
    const after = clinicDayBounds(new Date("2005-10-30T02:31:00Z"), "America/St_Johns");
    expect(formatInClinicTz(before.startIso, "America/St_Johns")).toBe("2005-10-29");
    expect(formatInClinicTz(during.startIso, "America/St_Johns")).toBe("2005-10-30");
    expect(formatInClinicTz(after.startIso, "America/St_Johns")).toBe("2005-10-29");
    expect(during.endIso).not.toBe(after.endIso);
  });
});

describe("clinicDayBoundsForDay", () => {
  it("bounds the named day, not the UTC day the string parses as", () => {
    // `new Date("2026-11-01")` is UTC midnight, which is still 2026-10-31 in Santiago.
    // The helper must return the window of the day that was asked for.
    const bounds = clinicDayBoundsForDay("2026-11-01", "America/Santiago");
    expect(formatInClinicTz(bounds.startIso, "America/Santiago")).toBe("2026-11-01");
    expect(formatInClinicTz(bounds.endIso, "America/Santiago")).toBe("2026-11-02");
  });

  it("agrees with clinicDayBounds for an instant inside the day", () => {
    expect(clinicDayBoundsForDay("2026-11-01", "Asia/Kolkata")).toEqual(
      clinicDayBounds(new Date("2026-11-01T12:00:00Z"), "Asia/Kolkata"),
    );
  });

  it("returns a 23-hour window on a spring-forward day rather than a fixed 24", () => {
    const bounds = clinicDayBoundsForDay("2026-09-06", "America/Santiago");
    expect(new Date(bounds.endIso).getTime() - new Date(bounds.startIso).getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  it("refuses an impossible or malformed day instead of rolling it over", () => {
    expect(() => clinicDayBoundsForDay("2026-02-30", "UTC")).toThrow(RangeError);
    expect(() => clinicDayBoundsForDay("2026-13-01", "UTC")).toThrow(RangeError);
    expect(() => clinicDayBoundsForDay("2026-1-1", "UTC")).toThrow(RangeError);
  });

  it("refuses a day the zone skipped entirely", () => {
    // Pacific/Apia crossed the date line on 2011-12-30; that local date never happened.
    expect(() => clinicDayBoundsForDay("2011-12-30", "Pacific/Apia")).toThrow(RangeError);
  });
});

describe("clinicWallTimeToInstant", () => {
  it("reads a form's wall-clock value in the clinic's zone, not the server's", () => {
    expect(clinicWallTimeToInstant("2026-11-01", "09:00", "Asia/Kolkata")).toBe(
      "2026-11-01T03:30:00.000Z",
    );
    expect(clinicWallTimeToInstant("2026-11-01", "09:00", "America/Santiago")).toBe(
      "2026-11-01T12:00:00.000Z",
    );
  });

  it("corrects across a daylight-saving transition on the same day", () => {
    // Santiago springs forward at local midnight on 2026-09-06, so 09:00 is at UTC-3
    // while the day's own first instant is at UTC-4. Adding nine hours to the day start
    // would answer 13:00Z - an hour late.
    const iso = clinicWallTimeToInstant("2026-09-06", "09:00", "America/Santiago");
    expect(iso).toBe("2026-09-06T12:00:00.000Z");
    expect(formatInClinicTz(iso, "America/Santiago")).toBe("2026-09-06");
  });

  it("refuses a wall-clock time the zone skipped", () => {
    expect(() => clinicWallTimeToInstant("2026-09-06", "00:30", "America/Santiago")).toThrow(
      RangeError,
    );
  });

  it("resolves an ambiguous fall-back time to the first occurrence", () => {
    // 01:30 happens twice in New York on 2026-11-01. The first is 05:30Z (EDT).
    expect(clinicWallTimeToInstant("2026-11-01", "01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("refuses a malformed time instead of guessing", () => {
    expect(() => clinicWallTimeToInstant("2026-11-01", "9:00", "UTC")).toThrow(RangeError);
    expect(() => clinicWallTimeToInstant("2026-11-01", "24:00", "UTC")).toThrow(RangeError);
  });
});

describe("dates outside what Intl can represent", () => {
  it("refuses rather than returning a window that excludes its input", () => {
    // A date ICU will not render has no established local day, so the answer is a loud
    // refusal rather than a plausible-looking wrong window.
    expect(() => clinicDayBounds(new Date(Number.NaN), "UTC")).toThrow(RangeError);
    expect(() => clinicDayBounds(new Date("not a date"), "UTC")).toThrow(RangeError);
    expect(() => formatInClinicTz("not a date", "UTC")).toThrow(RangeError);
  });
});
