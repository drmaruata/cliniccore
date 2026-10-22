"use server";

import { forgotPasswordSchema } from "@/lib/validation/auth";
import { toSafeResponse, ValidationError, type SafeResponse } from "@/lib/errors";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import { createServerClient } from "@/lib/supabase/server";

/**
 * The password-reset request.
 *
 * WHY EVERY OUTCOME IS THE SAME ANSWER. A reset request must not say whether the
 * address has an account: the answer would be a free account-existence oracle for
 * anybody with a list of addresses. So the response is IDENTICAL whether the account
 * exists, whether the address is malformed, and whether the mail provider refused the
 * request - the same 200 and the same body, every time. The error is logged on the
 * server, where the operator can see it and the requester cannot.
 *
 * WHY THE REDIRECT URL IS GUARDED. The url is built from an environment variable and
 * never from the request, so it cannot be steered by the caller. But if the variable
 * is missing the url would be the literal "undefined/reset-password", and Supabase
 * would reject the request - so the missing variable is a server-side fault to log,
 * not something to send.
 *
 * WHY THE EXCHANGE LIVES IN A ROUTE HANDLER. A Server Component cannot set cookies, and
 * the recovery session has to be established before the form can change a password.
 *
 * WHY THE FAILURE LOG CARRIES NO ADDRESS, like the login log: an address is a person's,
 * and a log is the one place a whole list of them accumulates.
 */
const GENERIC_RESPONSE: SafeResponse = {
  status: 200,
  body: { error: "", code: "success" },
};

export async function forgotPassword(
  _prev: SafeResponse | null,
  data: unknown,
): Promise<SafeResponse | null> {
  const parsed = forgotPasswordSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    // A malformed address is not a valid address: saying so reveals nothing about whether
    // the account exists, only about the input.
    return toSafeResponse(new ValidationError(fieldErrorMessage(parsed.error)));
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    console.error("forgotPassword: NEXT_PUBLIC_APP_URL is not set, so no reset mail can be sent");
    return GENERIC_RESPONSE;
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    // The exchange happens in a ROUTE HANDLER: a Server Component cannot set cookies.
    redirectTo: `${appUrl}/api/auth/verify?next=/reset-password`,
  });

  if (error) {
    // WITHOUT THE ADDRESS, like the login log.
    console.error("forgotPassword: the reset request failed", error.code ?? "unknown");
  }

  return GENERIC_RESPONSE;
}
