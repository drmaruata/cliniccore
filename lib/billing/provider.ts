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
 *   lossy translation layer. Money is the house `Minor` type - bigint paise, no floating
 *   point - so the seam cannot describe an amount in anything but minor units.
 * - `import "server-only"` guards the secret key, and it is the guard that fails at
 *   bundle time. The trap: `verbatimModuleSyntax` is on, so `import { type X }` still
 *   EMITS a runtime import and still trips it - a client component must use a top-level
 *   `import type { X }`.
 * - `isPaymentConfigured()` asks the provider it would hand out, so a second source of
 *   truth about whether payments work cannot drift from the first. It is false today, and
 *   true only when a real provider is wired.
 * - The members of `PaymentProvider` are PROPERTIES, not methods, and `configured` is one
 *   of them for a second reason: the contract is that every METHOD of a provider refuses,
 *   so a method that answered "am I configured?" would have to answer with a boolean
 *   (which breaks the contract) or refuse (which answers nothing). A property cannot do
 *   either, so the boolean lives beside the contract rather than inside it. As properties
 *   of function type, the parameters are also checked contravariantly, which
 *   `strictFunctionTypes` does NOT do for a method declaration - so an implementation
 *   could narrow `verifyWebhook(payload: string | Uint8Array, ...)` to `string` and still
 *   typecheck, which is exactly the mistake the raw-body contract exists to prevent.
 * - `CheckoutInput.idempotencyKey` and `RefundInput.idempotencyKey` are keys for THIS
 *   attempt: a caller that generates a fresh key on every retry gets a second charge.
 * - `CheckoutSession.providerSessionId` names the STAGE, not the provider's noun - a
 *   hosted flow may call it a payment link and an in-page flow an order - and it is not
 *   null, because a checkout that was created has an identifier. `CheckoutSession.url` is
 *   a HOSTED page on the provider's own domain, not a client-side SDK payload: a provider
 *   whose flow needs a publishable key and provider parameters IN THE BROWSER cannot be
 *   described by this seam as it stands - a real limit, stated here rather than
 *   discovered in Phase 8.
 * - A refund is against a PAYMENT, not a checkout: `RefundInput.providerPaymentId` names
 *   the payment being refunded, `RefundResult.providerPaymentId` names it back, and
 *   `RefundInput.organizationId` names the tenant whose money it is.
 *   `WebhookEvent.refundId` is how a caller learns that an ASYNCHRONOUS refund finally
 *   succeeded or failed, which no return value can tell it. `WebhookEvent.eventId` is
 *   what idempotency is keyed on, and `RefundInput.reasonCode` is a code, not a sentence -
 *   a CONVENTION, and nothing in the seam screens it.
 * - Swapping providers is a change to the IMPLEMENTATION, and the implementation is one
 *   file. The interface is a different matter: a provider whose flow this seam cannot
 *   describe - one with no hosted checkout page, say - needs the interface to grow, and
 *   that is expected rather than a failure of the seam.
 */
import "server-only";

import type { Minor } from "@/lib/utils/money";

import { unconfiguredProvider } from "./unconfigured";

export { PaymentNotConfiguredError, PaymentVerificationError } from "@/lib/errors";

export interface CheckoutInput {
  organizationId: string;
  planCode: string;
  amountMinor: Minor;
  currency: string;
  description: string;
  /** A stable key for THIS attempt to charge: a retry with a fresh key gets a second charge. */
  idempotencyKey: string;
}

export interface CheckoutSession {
  providerSessionId: string;
  providerOrderId: string | null;
  /** A HOSTED page on the provider's own domain, not a client-side SDK payload. */
  url: string;
  amountMinor: Minor;
  currency: string;
  expiresAt: string | null;
}

export interface WebhookEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  providerSessionId: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  refundId: string | null;
  amountMinor: Minor | null;
  currency: string | null;
}

export interface RefundInput {
  organizationId: string;
  providerPaymentId: string;
  amountMinor: Minor;
  reasonCode: string;
  /** A stable key for THIS attempt to refund. See `CheckoutInput.idempotencyKey`. */
  idempotencyKey: string;
}

export interface RefundResult {
  refundId: string;
  providerPaymentId: string;
  amountMinor: Minor;
  currency: string;
  status: "pending" | "succeeded" | "failed";
}

export interface PaymentProvider {
  readonly configured: boolean;
  createCheckout: (input: CheckoutInput) => Promise<CheckoutSession>;
  /**
   * Authenticate a webhook payload against its signature and return what it means. The
   * payload is the RAW BODY, exactly as it arrived. A signature that does not verify MUST
   * reject with `PaymentVerificationError` and MUST NOT resolve to an event; a provider
   * that is unreachable is a DIFFERENT failure and must not be reported as this one.
   */
  verifyWebhook: (payload: string | Uint8Array, signature: string) => Promise<WebhookEvent>;
  refund: (input: RefundInput) => Promise<RefundResult>;
}

export function getPaymentProvider(): PaymentProvider {
  return unconfiguredProvider;
}

export function isPaymentConfigured(): boolean {
  return getPaymentProvider().configured;
}
