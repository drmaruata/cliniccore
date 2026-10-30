/**
 * Appointment day view query: bounds and filters are exercised through a
 * controllable Supabase stub.
 *
 * WHY THE QUERY IS STUBBED, NOT REAL. `clinicDayBoundsForDay` already has its own
 * unit suite, so this file proves that `listDayAppointments` uses it and scopes the
 * query correctly: organization id, clinic id, the day window and the ordering.
 * Measure the arguments the query receives, then answer with a static shape that
 * matches the real row type. The RLS policies and the shape of the embedded relation
 * are validated elsewhere, in integration.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { clinicDayBoundsForDay } from "@/lib/utils/datetime";

vi.mock("@/lib/supabase/server");
vi.mock("@/lib/auth/active-org");

import { listDayAppointments } from "@/lib/clinical/queries";
import { createServerClient } from "@/lib/supabase/server";
import { getActiveOrg } from "@/lib/auth/active-org";

type QueryBuilder = {
  selectArg: string | null;
  eqArgs: Array<[string, string]>;
  gteArgs: Array<[string, string]>;
  ltArgs: Array<[string, string]>;
  orderArgs: Array<[string, Record<string, unknown>]>;
  then?: unknown;
};

function makeBuilder(): QueryBuilder {
  return {
    selectArg: null,
    eqArgs: [],
    gteArgs: [],
    ltArgs: [],
    orderArgs: [],
  };
}

describe("listDayAppointments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses clinicDayBoundsForDay and filters by org, clinic and window", async () => {
    const builder = makeBuilder();
    const fromStub = vi.fn(() => ({
      select: vi.fn((arg: string) => {
        builder.selectArg = arg;
        return {
          eq: vi.fn((col: string, val: string) => {
            builder.eqArgs.push([col, val]);
            return { eq: arguments[0], gte: arguments[0], lt: arguments[0], order: arguments[0] };
          }),
          gte: vi.fn((col: string, val: string) => {
            builder.gteArgs.push([col, val]);
            return { gte: arguments[0], lt: arguments[0], order: arguments[0] };
          }),
          lt: vi.fn((col: string, val: string) => {
            builder.ltArgs.push([col, val]);
            return { lt: arguments[0], order: arguments[0] };
          }),
          order: vi.fn((col: string, opts: Record<string, unknown>) => {
            builder.orderArgs.push([col, opts]);
            return { order: arguments[0] };
          }),
        };
      }),
    }));

    vi.mocked(createServerClient).mockResolvedValueOnce({
      from: fromStub,
    } as any);

    vi.mocked(getActiveOrg).mockResolvedValue({
      id: "org-1",
      name: "Org",
      slug: "org",
      timezone: "Asia/Kolkata",
      currency: "INR",
      locale: "en-IN",
    });

    await listDayAppointments({ clinicId: "clinic-1", day: "2026-11-01" });

    expect(builder.selectArg).toContain("patients(first_name, last_name, mrn)");
    const bounds = clinicDayBoundsForDay("2026-11-01", "Asia/Kolkata");
    expect(builder.eqArgs).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["clinic_id", "clinic-1"],
      ]),
    );
    expect(builder.gteArgs).toEqual([["scheduled_start", bounds.startIso]]);
    expect(builder.ltArgs).toEqual([["scheduled_start", bounds.endIso]]);
    expect(builder.orderArgs).toEqual([
      ["scheduled_start", { ascending: true }],
    ]);
  });

  it("handles America/Santiago 23-hour day", async () => {
    const builder = makeBuilder();
    vi.mocked(createServerClient).mockResolvedValueOnce({
      from: () => ({
        select: () => ({
          eq: (col: string, val: string) => builder.eqArgs.push([col, val]),
          gte: (col: string, val: string) => builder.gteArgs.push([col, val]),
          lt: (col: string, val: string) => builder.ltArgs.push([col, val]),
          order: (col: string, opts: Record<string, unknown>) => builder.orderArgs.push([col, opts]),
        }),
      }),
    } as any);

    vi.mocked(getActiveOrg).mockResolvedValue({
      id: "org-2",
      name: "Org",
      slug: "org",
      timezone: "America/Santiago",
      currency: "CLP",
      locale: "es-CL",
    });

    await listDayAppointments({ clinicId: "clinic-2", day: "2026-09-06" });

    const bounds = clinicDayBoundsForDay("2026-09-06", "America/Santiago");
    const start = new Date(bounds.startIso).getTime();
    const end = new Date(bounds.endIso).getTime();
    const hours = (end - start) / 3_600_000;
    expect(hours).toBeCloseTo(23, 0);
    expect(builder.gteArgs).toEqual([["scheduled_start", bounds.startIso]]);
    expect(builder.ltArgs).toEqual([["scheduled_start", bounds.endIso]]);
  });

  it("returns empty array when no active organisation", async () => {
    vi.mocked(getActiveOrg).mockResolvedValue(null);
    const result = await listDayAppointments({ clinicId: "c", day: "2026-01-01" });
    expect(result).toEqual([]);
    expect(vi.mocked(createServerClient)).not.toHaveBeenCalled();
  });
});
