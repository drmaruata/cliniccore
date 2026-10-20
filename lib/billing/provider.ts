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
 * WHY ONE FACTORY, AND WHY isPaymentConfigured ASKS THE PROVIDER. A second source of
 * truth about whether payments work is a second thing to get out of step with the
 * first. `isPaymentConfigured()` therefore asks the provider it would hand out, so a
 * provider that becomes configured - and only that - changes the answer.
 *
 * WHY THE TYPES CARRY DOMAIN FACTS. A `CheckoutSession` describes what a clinic's
 * checkout IS, not what one provider's checkout endpoint accepts, so the provider's own
 * shape stays inside the provider implementation and swapping providers does not reach
 * every caller. The one place a provider's vocabulary is deliberately kept is
 * `WebhookEvent.eventType`: a seam that translated every provider's event names would be
 * a second, lossy translation layer, and the interpretation belongs to the subscription
 * state machine that Phase 8 adds.
 *
 * WHY THE INTERFACE MEMBERS ARE PROPERTIES AND NOT METHODS. `strictFunctionTypes` does
 * not check the parameters of a METHOD declaration, so an implementation could narrow
 * `verifyWebhook(payload: string | Uint8Array, ...)` to `string` and still typecheck -
 * which is precisely the mistake the raw-body contract exists to prevent. As a property
 * of function type, the parameter is checked contravariantly and the narrowing is a
 * compile error.
 *
 * WHY MONEY IS THE HOUSE `Minor` TYPE. The standing rule for this project is money in
 * minor units as bigint, with no floating point anywhere in a money path. `Minor` is
 * that type, so the seam cannot describe an amount in anything but paise, and a provider
 * that speaks in floats is not a provider this seam can describe.
 *
 * WHY THE MODULE IS SERVER-ONLY, AND THE TRAP THAT COMES WITH IT. A configured provider
 * holds a secret key, and a client component that imported this would eventually ship
 * that key to a browser. `import "server-only"` makes that a build error rather than a
 * review comment. The trap: `verbatimModuleSyntax` is on, so `import { type X } from
 * "@/lib/billing/provider"` still EMITS a runtime import and still trips the guard - a
 * client component must use a top-level `import type { X }`.
 */

import "server-only";

import type { Minor } from "@/lib/utils/money";

import { unconfiguredProvider } from "./unconfigured";

export { PaymentNotConfiguredError, PaymentVerificationError } from "@/lib/errors";

/** A checkout request. Every field is the server's resolution, never a client-supplied one. */
export interface CheckoutInput {
  /** The tenant buying. */
  organizationId: string;
  /** The plan being bought, as the plan registry names it. */
  planCode: string;
  /** What to charge, in minor units (paise). */
  amountMinor: Minor;
  /** ISO 4217 currency code. */
  currency: string;
  /** The line item shown to the payer. */
  description: string;
  /**
   * A stable key for THIS attempt to charge, so that a retry maps to the same provider
   * order rather than creating a second one. A caller that generates a fresh key on
   * every retry gets a second charge.
   */
  idempotencyKey: string;
}

/** A checkout the payer can be sent to. */
export interface CheckoutSession {
  /** The provider's identifier for this checkout. */
  providerSessionId: string;
  /**
   * The provider's identifier for the PAYMENT behind the checkout, and the thing a
   * refund is against - a provider refunds a payment, not a checkout. It is null until
   * the payer has paid, and the webhook that says so is what carries it.
   */
  providerPaymentId: string | null;
  /** The provider's identifier for the order behind it, where the provider has one. */
  providerOrderId: string | null;
  /**
   * Where the payer is sent to complete payment. This is a HOSTED page on the provider's
   * own domain, not a client-side SDK payload: the seam is server-only, and describing
   * an in-page checkout would put provider vocabulary into the browser. A provider that
   * cannot offer a hosted page is not a provider this seam can describe.
   */
  url: string;
  /** What is being charged, in minor units. */
  amountMinor: Minor;
  /** ISO 4217 currency code. */
  currency: string;
  /** ISO 8601 instant at which the checkout expires, where the provider expires it. */
  expiresAt: string | null;
}

/** A webhook the provider has authenticated, flattened to the facts a clinic's billing means. */
export interface WebhookEvent {
  /** The provider's event id, which is what idempotency is keyed on. */
  eventId: string;
  /** The provider's own event name, verbatim. */
  eventType: string;
  /** ISO 8601 instant the event happened. */
  occurredAt: string;
  /** The checkout the event is about, where it names one. */
  providerSessionId: string | null;
  /** The payment the event is about, where it names one. */
  providerPaymentId: string | null;
  /** The amount involved, in minor units, where the event carries one. */
  amountMinor: Minor | null;
  /** ISO 4217 currency code, where the event carries one. */
  currency: string | null;
}

/** A request to refund part or all of a payment. */
export interface RefundInput {
  /** The payment being refunded. */
  providerPaymentId: string;
  /** How much to refund, in minor units. */
  amountMinor: Minor;
  /** A code for why, not a sentence. */
  reasonCode: string;
  /**
   * A stable key for THIS attempt to refund, so that a retry maps to the same provider
   * refund rather than refunding twice. See `CheckoutInput.idempotencyKey`.
   */
  idempotencyKey: string;
}

/** The outcome of a refund request. */
export interface RefundResult {
  /** The provider's identifier for this refund. */
  refundId: string;
  /** The payment the refund was against. */
  providerPaymentId: string;
  /** How much was refunded, in minor units. */
  amountMinor: Minor;
  /** ISO 4217 currency code. */
  currency: string;
  /** Where the refund has got to. */
  status: "pending" | "succeeded" | "failed";
}

/**
 * What a payment provider must be able to do.
 *
 * `configured` is a PROPERTY rather than a method on purpose. The contract is that every
 * METHOD of a provider refuses, so a method that answered "am I configured?" would have
 * to do one of two things: answer with a boolean, which breaks the contract, or refuse,
 * which answers nothing. A property cannot do either, so the boolean lives beside the
 * contract rather than inside it.
 */
export interface PaymentProvider {
  /** Whether this provider can actually take money. False for the unconfigured stub. */
  readonly configured: boolean;
  /** Start a checkout and return where the payer goes to pay. */
  createCheckout: (input: CheckoutInput) => Promise<CheckoutSession>;
  /**
   * Authenticate a webhook payload against its signature and return what it means.
   *
   * The payload is the RAW BODY, exactly as it arrived. A signature is computed over
   * bytes, so a payload that has been parsed and re-serialised is a different byte
   * sequence and will fail the check for reasons that look like a forgery. The union
   * exists because a framework may hand over either the bytes or the text.
   *
   * A signature that does not verify MUST reject with `PaymentVerificationError`, and
   * MUST NOT resolve to an event. A provider that is unreachable is a DIFFERENT failure
   * and must not be reported as a verification failure: one is an attack, the other is
   * an outage, and an operator reads them differently.
   */
  verifyWebhook: (payload: string | Uint8Array, signature: string) => Promise<WebhookEvent>;
  /** Refund a payment. */
  refund: (input: RefundInput) => Promise<RefundResult>;
}

/**
 * The provider this deployment uses. Swapping providers is a change to this function
 * and to the file that implements the new one, and to nothing else.
 */
export function getPaymentProvider(): PaymentProvider {
  return unconfiguredProvider;
}

/** Whether payments can be taken at all. False today, and true only when a real provider is wired. */
export function isPaymentConfigured(): boolean {
  return getPaymentProvider().configured;
}
