/**
 * `toSafeResponse` is the last thing between an exception and an HTTP response, so its
 * contract is that NOTHING authored by a thrower ever reaches the client.
 *
 * WHY THESE TESTS ARE ADVERSARIAL RATHER THAN EXEMPLARY. The obvious test - map one
 * AppError, check the status - passes on an implementation that also forwards a Postgres
 * connection string. Every case below is built from something that could plausibly end up
 * in an exception in this codebase: a driver error, a PostgREST error body, a thrown
 * object that lies about its own status, a getter that throws while being stringified.
 *
 * The repeated assertion is that the SECRET SUBSTRING appears nowhere in the serialised
 * response, rather than that the message "looks generic". A message can be generic and
 * still leak through a field nobody checked.
 */
import { describe, expect, it } from "vitest";

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentNotConfiguredError,
  UnauthorizedError,
  ValidationError,
  toSafeResponse,
} from "../../lib/errors";

const SECRET = "hunter2";

/** Serialise exactly as a framework would, so a leak in any field is caught. */
const wire = (error: unknown) => JSON.stringify(toSafeResponse(error));

describe("AppError subclasses", () => {
  it("carry the status and code the brief names", () => {
    expect(new UnauthorizedError("Sign in required").status).toBe(401);
    expect(new ForbiddenError("Not your org").status).toBe(403);
    expect(new NotFoundError("No such patient").status).toBe(404);
    expect(new ConflictError("Already exists").status).toBe(409);
    expect(new ValidationError("Bad input").status).toBe(422);
    // 500 and not 503: an unconfigured payment provider is a gap in this deployment
    // rather than a temporary outage, and a 503 would promise that a retry might
    // succeed. The status is pinned here because a mutation to 503 would leave every
    // other test in the repository green.
    expect(new PaymentNotConfiguredError("x").status).toBe(500);
    expect(new PaymentNotConfiguredError("x").code).toBe("payment_not_configured");
  });

  it("answer a payment that cannot be taken with our own message", () => {
    expect(toSafeResponse(new PaymentNotConfiguredError())).toEqual({
      status: 500,
      body: { error: "Payment provider is not configured.", code: "payment_not_configured" },
    });
  });

  it("return their own authored message, which is safe by construction", () => {
    // An AppError message is written by us, so it is the one message that may reach the
    // client. This is what makes the rest of the suite meaningful: if AppError messages
    // were also suppressed there would be nothing left to return.
    expect(toSafeResponse(new NotFoundError("No such patient"))).toEqual({
      status: 404,
      body: { error: "No such patient", code: "not_found" },
    });
  });

  it("default their code from the class, and allow an override", () => {
    expect(new UnauthorizedError("x").code).toBe("unauthorized");
    expect(new ForbiddenError("x", "org_not_member").code).toBe("org_not_member");
  });
});

describe("toSafeResponse does not leak", () => {
  it("a connection string in a plain Error", () => {
    const response = toSafeResponse(
      new Error(`connection string postgres://user:${SECRET}@db.internal:5432/clinic`),
    );
    expect(response.status).toBe(500);
    expect(wire(new Error(`connection string postgres://user:${SECRET}@db`))).not.toContain(SECRET);
    expect(wire(new Error(`postgres://user:${SECRET}@db`))).not.toContain("postgres://");
  });

  it("a SQL statement in a plain Error", () => {
    const response = toSafeResponse(
      new Error(`syntax error at or near "GRANT" in GRANT SELECT ON patients TO anon`),
    );
    expect(response.status).toBe(500);
    expect(response.body.error).not.toContain("GRANT");
  });

  it("a stack trace", () => {
    const error = new Error("boom");
    const serialised = wire(error);
    expect(serialised).not.toContain("at ");
    expect(serialised).not.toContain(".ts:");
    // And the body has exactly the two documented keys - nothing else rode along.
    expect(Object.keys(toSafeResponse(error).body).sort()).toEqual(["code", "error"]);
  });

  it("a PostgREST error body, including its details and hint", () => {
    const postgrest = {
      message: `duplicate key value violates unique constraint "patients_pkey"`,
      code: "23505",
      details: `Key (mrn)=(MRN-1) already exists.`,
      hint: null,
    };
    const response = toSafeResponse(postgrest);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toContain("23505");
    expect(JSON.stringify(response)).not.toContain("already exists");
  });

  it("an object that lies about its own status", () => {
    // A thrown object carrying `status: 401` must not be honoured: it is attacker-
    // influenceable shape, not our error type, and honouring it would let a thrower pick
    // both the status code and - with a `message` field - the body.
    const liar = { status: 401, message: "You are an admin", code: "forbidden" };
    const response = toSafeResponse(liar);
    expect(response.status).toBe(500);
    expect(response.body.error).not.toContain("admin");
    expect(JSON.stringify(response)).not.toContain("forbidden");
  });

  it("the cause chain", () => {
    const inner = new Error(`inner leaked ${SECRET}`);
    const outer = new Error("outer", { cause: inner });
    expect(wire(outer)).not.toContain(SECRET);
    const deeper = new Error("outer", { cause: new Error("mid", { cause: inner }) });
    expect(wire(deeper)).not.toContain(SECRET);
  });

  it("values that are not errors at all", () => {
    for (const value of ["a bare string", 42, null, undefined, Symbol("s"), [1, 2, 3], true]) {
      const response = toSafeResponse(value);
      expect(response.status).toBe(500);
      expect(typeof response.body.error).toBe("string");
      expect(response.body.error.length).toBeGreaterThan(0);
    }
  });

  it("an object that throws while being stringified", () => {
    // A hostile or lazy `toJSON`/`message` getter must not turn error handling into a
    // second error, which would surface as an unhandled rejection instead of a 500.
    const hostile = {
      get message(): string {
        throw new Error("getter exploded");
      },
      toJSON() {
        throw new Error("toJSON exploded");
      },
    };
    const response = toSafeResponse(hostile);
    expect(response.status).toBe(500);
    expect(typeof response.body.error).toBe("string");
  });
});

describe("a malformed AppError cannot produce a success", () => {
  // MEASURED, and the consequences were worse than "a bit off". A status of undefined
  // became `new Response(body, { status: undefined })`, which answers **200 OK** with
  // an empty body - a success status for a failure. A NaN status threw a RangeError from
  // INSIDE error handling, which is the one thing this module exists to prevent.
  it("refuses a status that is not an integer", () => {
    const malformed = Object.create(AppError.prototype) as AppError;
    Object.assign(malformed, { message: "something", code: "x" });
    const response = toSafeResponse(malformed);
    expect(response.status).toBe(500);
    expect(response.body.error).not.toBe("");
    expect(response.body.code).not.toBe("");
  });

  it("refuses a status that is not a number at all", () => {
    const malformed = Object.create(AppError.prototype) as AppError;
    Object.assign(malformed, { message: "something", code: "x", status: Number.NaN });
    expect(() => toSafeResponse(malformed)).not.toThrow();
    expect(toSafeResponse(malformed).status).toBe(500);
  });

  it("survives a message getter that throws", () => {
    const hostile = Object.create(AppError.prototype) as AppError;
    Object.assign(hostile, { status: 400, code: "x" });
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter exploded");
      },
    });
    let response: ReturnType<typeof toSafeResponse> | undefined;
    expect(() => {
      response = toSafeResponse(hostile);
    }).not.toThrow();
    expect(response?.status).toBe(500);
  });
});

describe("why a database error must not become an AppError", () => {
  // The rule in lib/auth/active-org.ts - a PostgREST failure is re-thrown as-is, never
  // translated into an AppError - is unpinned by any test that exercises the code, because
  // a database failure is hard to provoke. So the CONSEQUENCE is pinned here instead, and
  // this states plainly why the rule exists.
  it("an AppError built from a database message WOULD leak it", () => {
    // This is the hazard the rule prevents. If it ever stops being true - because
    // toSafeResponse starts sanitising AppError messages too - the rule becomes
    // unnecessary, and a future author may safely "helpfully" translate DB errors.
    const fromDatabase = new AppError(`select failed: ${SECRET}`, 500, "db_error");
    expect(wire(fromDatabase)).toContain(SECRET);
  });

  it("and a database error thrown as-is does not", () => {
    const fromDatabase = new Error(`select failed: ${SECRET}`);
    expect(wire(fromDatabase)).not.toContain(SECRET);
  });
});

describe("the leak assertions can themselves fail", () => {
  it("detects a leak that is present", () => {
    // A guard on a guard. If `expect(...).not.toContain(SECRET)` were vacuous, this fails.
    expect(wire(new AppError("oops", 500, "leaked_" + SECRET))).toContain(SECRET);
  });

  it("would catch toSafeResponse forwarding a raw message", () => {
    const leaky = (e: unknown) => ({
      status: e instanceof AppError ? e.status : 500,
      body: { error: e instanceof Error ? e.message : "Internal error", code: "x" },
    });
    expect(JSON.stringify(leaky(new Error(`db ${SECRET}`)))).toContain(SECRET);
  });
});
