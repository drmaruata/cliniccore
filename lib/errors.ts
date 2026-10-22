/**
 * Typed application errors and the single place an exception becomes an HTTP response.
 *
 * WHY THIS FILE IS SMALL BUT LOAD-BEARING. `toSafeResponse` is the last thing between an
 * exception and a client, in an application holding PHI. Anything authored by a thrower -
 * a Postgres connection string, a SQL statement, a PostgREST error body, a stack frame -
 * reaching a browser is a disclosure, and the natural way to write this function ("if it is
 * one of ours return its message, otherwise return a generic 500") is exactly the shape
 * that gets eroded over time by one convenience exception. So the rule is one-directional
 * and has no exceptions: only an `AppError` contributes a message, and an `AppError`
 * message is written by us. Honouring a thrower's `status` field would let it pick both
 * halves of the response.
 *
 * ENFORCEMENT IS NOT HERE. These statuses describe what to tell the caller; they do not
 * grant anything. Authorization is RLS and the `private.*` helpers - see the Task 5 ruling.
 * A `ForbiddenError` thrown by a UI guard is a rendering decision, not a security control.
 *
 * THE STATUSES ARE NOT INTERCHANGEABLE. 409 is "the request was well-formed but conflicts
 * with current state"; 422 is "the body parsed but failed a domain rule the schema
 * encodes". `PaymentNotConfiguredError` is 500 and not 503: an unconfigured provider is a
 * gap in this deployment rather than a temporary outage, and a 503 would promise that a
 * retry might succeed. `PaymentVerificationError` is 401: the caller presented something
 * it could not prove - and a provider that is merely UNREACHABLE is a DIFFERENT failure
 * and must not be reported as this one, because one is an attack and the other an outage.
 *
 * THE READS ARE GUARDED, NOT JUST THE NARROWING. MEASURED: an AppError-shaped object with
 * a missing `status` produced `status: undefined`, and `new Response(body, { status:
 * undefined })` answers **200 OK** with an empty body - a success status for a failure. A
 * NaN status throws a RangeError from INSIDE error handling, which is the one thing this
 * module exists to prevent. THE RESIDUAL, RECORDED RATHER THAN FIXED: a Proxy wrapping a
 * real AppError passes `instanceof` and fully controls the response. That requires
 * in-process access to the class, and no driver, PostgREST body or cross-realm error is
 * an AppError - so the externally reachable boundary is solid, and the proxy shape is a
 * trap for whoever writes the first route handler.
 *
 * `toSafeResponse` IS THE ONLY SANCTIONED PATH from an exception to a response body, and
 * it deliberately touches nothing on an unknown value: no `String(e)`, no `e.message`, no
 * `JSON.stringify(e)`. Each of those is a way for a hostile or merely lazy getter to throw
 * inside error handling, converting a handled 500 into an unhandled rejection.
 * `ActionResult` is the shape an action returns when its SUCCESS carries a payload -
 * `SafeResponse` describes a failure and has no place to put an invitation link or a
 * created id - and its failure branch is BUILT from `toSafeResponse`, so the message
 * still comes from there and only from there.
 */

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

const GENERIC_CODE = "internal_error";

export class AppError extends Error {
  readonly status: number;

  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    // Restores the prototype chain: a no-op on this project's ES2022 target, and a guard
    // against a future downlevel to ES5, where `instanceof AppError` silently becomes false.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "You must be signed in.", code = "unauthorized") {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this.", code = "forbidden") {
    super(message, 403, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.", code = "not_found") {
    super(message, 404, code);
  }
}

export class ConflictError extends AppError {
  constructor(message = "That already exists.", code = "conflict") {
    super(message, 409, code);
  }
}

export class ValidationError extends AppError {
  constructor(message = "That input is not valid.", code = "validation_failed") {
    super(message, 422, code);
  }
}

export class PaymentNotConfiguredError extends AppError {
  constructor(message = "Payment provider is not configured.", code = "payment_not_configured") {
    super(message, 500, code);
  }
}

export class PaymentVerificationError extends AppError {
  constructor(
    message = "The payment webhook signature did not verify.",
    code = "payment_verification_failed",
  ) {
    super(message, 401, code);
  }
}

export interface SafeResponse {
  status: number;
  body: { error: string; code: string };
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string };

export function toActionResult<T>(error: unknown): ActionResult<T> {
  const safe = toSafeResponse(error);
  return { ok: false, error: safe.body.error, code: safe.body.code };
}

export function toSafeResponse(error: unknown): SafeResponse {
  if (error instanceof AppError) {
    // The field reads are GUARDED, not just the narrowing: an unvalidated `status` can
    // answer 200 OK for a failure, and a NaN status throws from inside error handling.
    try {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const code = typeof error.code === "string" && error.code !== "" ? error.code : GENERIC_CODE;
      const message =
        typeof error.message === "string" && error.message !== "" ? error.message : GENERIC_MESSAGE;
      return { status, body: { error: message, code } };
    } catch {
      return { status: 500, body: { error: GENERIC_MESSAGE, code: GENERIC_CODE } };
    }
  }
  return { status: 500, body: { error: GENERIC_MESSAGE, code: GENERIC_CODE } };
}
