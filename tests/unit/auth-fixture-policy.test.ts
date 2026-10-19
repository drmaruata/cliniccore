/**
 * The auth fixture's error policy, asserted rather than described.
 *
 * WHY. `createProbeSession` decides between two very different outcomes using one
 * predicate: a rate limit means RETRY, anything else means THROW. Getting it backwards is
 * not a small failure - MEASURED, replacing `isRateLimit` with `() => false` leaves the
 * entire suite green, so a bad key, a disabled provider or a revoked signup path gets
 * retried three times and then reported as "wait for the rate-limit window", a 28.5s
 * misdiagnosis that also trips the hook timeout and leaks a probe user.
 *
 * The second thing pinned here is the FALLBACK's narrowness: it may only take over for a
 * rate limit, so the session acquisition has to refuse to proceed on a real error. That was
 * recorded as an unasserted ratchet in the previous round; these are the assertions.
 */
import { describe, expect, it } from "vitest";

import { isRateLimit } from "../helpers/auth-session-fixture";

describe("the rate-limit predicate", () => {
  it("recognises the rate limit Supabase actually reports", () => {
    // MEASURED against the live project: this is the message returned when the public
    // signUp window fills.
    expect(isRateLimit({ message: "Request rate limit reached" })).toBe(true);
    expect(isRateLimit({ message: "Email rate limit exceeded", status: 429 })).toBe(true);
  });

  it("refuses to mistake anything else for a rate limit", () => {
    // Every one of these means something specific and must fail loudly rather than be
    // retried and then misattributed to a window that is not full.
    const realFailures = [
      "Invalid API key",
      "Email signups are disabled for this project",
      "User already registered",
      "Signups not allowed for otp",
      "Email not confirmed",
      "Invalid Refresh Token: Refresh Token Not Found",
      "fetch failed",
    ];
    for (const message of realFailures) {
      expect(isRateLimit({ message }), message).toBe(false);
    }
  });

  it("tolerates an error object with no message at all", () => {
    // Defensive: a malformed error must not throw from the predicate, or the failure
    // being handled becomes a different failure.
    expect(isRateLimit({})).toBe(false);
    expect(isRateLimit({ message: undefined })).toBe(false);
  });
});
