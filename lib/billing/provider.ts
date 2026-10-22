/**
 * The payment provider seam: the contract a clinic's billing is written against, and the
 * one place a provider is chosen.
 *
 * WHY A SEAM AND NOT AN INTEGRATION. The design spec splits two things that are easily
 * confused. The SEAM is this file - an interface, an unconfigured stub, and a factory
 * that chooses between them. The WIRING is Razorpay against its sandbox, which arrives
 * in Phase 8 with test keys, with HMAC webhook signature verification, idempotency-key
 * storage against replayed deliveries, and test cards driving the flow. Nothing about
 * billing is functional now and the seam must not pretend otherwise: every call refuses,
 * and the refusal is loud.
 *
 * THE RULINGS THAT BIND THIS FILE.
 * - The types carry DOMAIN facts, not provider facts, so swapping providers does not
 *   reach every caller. The one exception is `WebhookEvent.eventType`, which stays the
 *   provider's own vocabulary: a seam that translated every event name would be a second,
 *   lossy translation layer.
 * - Money is the house `Minor` type - bigint paise, no floating point - so the seam cannot
 *   describe an amount in anything but minor units.
 * - `import "server-only"` guards the secret key, and it is the guard that fails at
 *   bundle time. The trap: `verbatimModuleSyntax` is on, so `import { type X }` still
 *   EMITS a runtime import and still trips it - a client component must use a top-level
 *   `import type { X }`.
 * - `isPaymentConfigured()` asks the provider it would hand out, so a second source of
 *   truth about whether payments work cannot drift from the first.
 * - The members of `PaymentProvider` are PROPERTIES, not methods, and `configured` is one
 *   of them for a second reason: the contract is that every METHOD of a provider refuses,
 *   so a method that answered "am I configured?" would have to answer with a boolean
 *   (which breaks the contract) or refuse (which answers nothing). A property cannot do
 *   either, so the boolean lives beside the contract rather than inside it. As properties
 *   of function type, the parameters are also checked contravariantly, which
 *   `strictFunctionTypes` does NOT do for a method declaration - so an implementation
 *   could narrow `verifyWebhook(payload: string | Uint8Array, ...)` to `string` and still
 *   typecheck, which is exactly the mistake the raw-body contract exists to prevent.
 */
import "server-only";

import type { Minor } from "@/lib/utils/money";

import { unconfiguredProvider } from "./unconfigured";

export { PaymentNotConfiguredError, PaymentVerificationError } from "@/lib/errors";

/** A checkout request. Every field is the server's resolution, never a client-supplied one. */
export interface CheckoutInput {
  organizationId: string;
  planCode: string;
  amountMinor: Minor;
  currency: string;
  description: string;
  /**
   * A stable key for THIS attempt to charge, so a retry maps to the same provider order
   * rather than creating a second one. A caller that generates a fresh key on every
   * retry gets a second charge.
   */
  idempotencyKey: string;
}

/** A checkout the payer can be sent to. */
export interface CheckoutSession {
  /**
   * The provider's identifier for THIS checkout. The seam names the STAGE, not the
   * provider's noun: a hosted flow may call it a payment link and an in-page flow an
   * order. It is not null - a checkout that was created has an identifier.
   */
  providerSessionId: string;
  providerOrderId: string | null;
  /**
   * Where the payer is sent to complete payment: a HOSTED page on the provider's own
   * domain, not a client-side SDK payload. A provider whose flow needs a publishable key
   * and provider parameters IN THE BROWSER cannot be described by this seam as it stands
   * - a real limit, stated here rather than discovered in Phase 8.
   */
  url: string;
  amountMinor: Minor;
  currency: string;
  /** ISO 8601 instant at which the provider expires the checkout. */
  expiresAt: string | null;
}

/** A webhook the provider has authenticated, flattened to the facts a clinic's billing means. */
export interface WebhookEvent {
  /** The provider's event id, which is what idempotency is keyed on. */
  eventId: string;
  /** The provider's own event name, verbatim. */
  eventType: string;
  occurredAt: string;
  providerSessionId: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  /**
   * The refund the event is about, where it names one. A refund is ASYNCHRONOUS, so the
   * result of asking for one is not the end of it - this is how a caller learns that the
   * refund finally succeeded or finally failed.
   */
  refundId: string | null;
  amountMinor: Minor | null;
  currency: string | null;
}

/** A request to refund part or all of a payment. */
export interface RefundInput {
  /** The tenant whose money is being refunded. The same tenant the checkout was for. */
  organizationId: string;
  /** The payment being refunded - a provider refunds a payment, not a checkout. */
  providerPaymentId: string;
  amountMinor: Minor;
  /** A code for why, not a sentence. */
  reasonCode: string;
  /** A stable key for THIS attempt to refund. See `CheckoutInput.idempotencyKey`. */
  idempotencyKey: string;
}

/** The outcome of a refund request. */
export interface RefundResult {
  refundId: string;
  providerPaymentId: string;
  amountMinor: Minor;
  currency: string;
  status: "pending" | "succeeded" | "failed";
}

/** What a payment provider must be able to do. */
export interface PaymentProvider {
  /** Whether this provider can actually take money. False for the unconfigured stub. */
  readonly configured: boolean;
  /** Start a checkout and return where the payer goes to pay. */
  createCheckout: (input: CheckoutInput) => Promise<CheckoutSession>;
  /**
   * Authenticate a webhook payload against its signature and return what it means. The
   * payload is the RAW BODY, exactly as it arrived - the union exists because a framework
   * may hand over either the bytes or the text. A signature is computed over bytes, so a
   * parsed and re-serialised payload is a different byte sequence and fails the check
   * looking like a forgery.
   *
   * A signature that does not verify MUST reject with `PaymentVerificationError`, and
   * MUST NOT resolve to an event. A provider that is unreachable is a DIFFERENT failure
   * and must not be reported as this one - one is an attack, the other an outage, and an
   * operator reads them differently.
   */
  verifyWebhook: (payload: string | Uint8Array, signature: string) => Promise<WebhookEvent>;
  /** Refund a payment. */
  refund: (input: RefundInput) => Promise<RefundResult>;
}

/**
 * The provider this deployment uses.
 *
 * Swapping providers is a change to the IMPLEMENTATION, and the implementation is one
 * file. The interface is a different matter: a provider whose flow this seam cannot
 * describe - one with no hosted checkout page, say - needs the interface to grow, and
 * that is expected rather than a failure of the seam.
 */
export function getPaymentProvider(): PaymentProvider {
  return unconfiguredProvider;
}

/** Whether payments can be taken at all. False today, and true only when a real provider is wired. */
export function isPaymentConfigured(): boolean {
  return getPaymentProvider().configured;
}
