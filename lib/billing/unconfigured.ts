/**
 * The unconfigured payment provider: a stub whose every method refuses.
 *
 * WHY IT REFUSES RATHER THAN MOCKS. The design spec forbids a "test mode" that returns a
 * successful fake payment, because that would misrepresent payment capability - a
 * caller would believe a clinic had been charged. So this stub has no success path at
 * all: there is nothing to configure, no environment variable to set, and no branch
 * that returns a fake session. The only way to obtain a working provider is to write one.
 *
 * WHY IT IS FROZEN. The stub is EXPORTED, and the factory hands out that very object,
 * so a caller holding it could `Object.assign` a working `createCheckout` onto it and
 * every other caller would receive the fake. `Object.freeze` closes that: in a module,
 * which is always strict, the assignment throws instead of succeeding. A frozen object
 * is not a deep freeze, so the stub's own methods are still replaceable by nothing -
 * there is nothing to replace them with.
 *
 * WHY THE METHODS ARE ASYNC. The contract says a call REJECTS. A method that threw
 * synchronously would be a different contract, and a caller attaching a rejection
 * handler would never see it. An async function returns a rejected promise, which is
 * what the contract means.
 *
 * WHY THE ERROR LIVES ELSEWHERE. `PaymentNotConfiguredError` sits with the project's
 * other typed errors, so there is one error hierarchy and one place to look.
 *
 * WHY THIS FILE IS SERVER-ONLY TOO. The guard on the seam's entry point is only
 * meaningful if every path into it is guarded, and this file is importable on its own.
 */

import "server-only";

import { PaymentNotConfiguredError } from "@/lib/errors";

import type {
  CheckoutInput,
  CheckoutSession,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookEvent,
} from "./provider";

export const unconfiguredProvider: PaymentProvider = Object.freeze({
  configured: false,

  async createCheckout(_input: CheckoutInput): Promise<CheckoutSession> {
    throw new PaymentNotConfiguredError();
  },

  async verifyWebhook(_payload: string | Uint8Array, _signature: string): Promise<WebhookEvent> {
    throw new PaymentNotConfiguredError();
  },

  async refund(_input: RefundInput): Promise<RefundResult> {
    throw new PaymentNotConfiguredError();
  },
});
