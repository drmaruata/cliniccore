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

import { clinicDayBounds, formatInClinicTz } from "../../lib/utils/datetime";

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
