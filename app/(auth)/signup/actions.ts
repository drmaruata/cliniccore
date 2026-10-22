"use server";

import { signupSchema } from "@/lib/validation/auth";
import { toSafeResponse, ValidationError, type SafeResponse } from "@/lib/errors";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

/**
 * The sign-up mutation.
 *
 * WHY THE SESSION IS CHECKED. `signUp` answers with a session only when the user is
 * signed in immediately. If the deployment has "Confirm email" switched on there is no
 * session, and redirecting as though there were would report a success that did not
 * happen - the user would be sent to onboarding and then bounced to a login page they
 * cannot yet pass. So the absence of a session is reported, not redirected past.
 *
 * WHY THE TRY IS AROUND THE PROVIDER CALL ONLY. `redirect()` throws a NEXT_REDIRECT
 * sentinel, and catching that would swallow the redirect and answer with a response
 * instead. A THROWN action, though, would leave the user with no message at all and
 * eject them to the global error page - `(auth)` has no `error.tsx` - so the provider
 * call is guarded and its failure is turned into a response.
 */
export async function signup(
  _prev: SafeResponse | null,
  data: unknown,
): Promise<SafeResponse | null> {
  const parsed = signupSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return toSafeResponse(new ValidationError(fieldErrorMessage(parsed.error)));
  }

  const supabase = await createServerClient();

  let result: { session: unknown } | null = null;
  let error: { message: string; code?: string; status?: number } | null = null;
  try {
    const response = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        // The key the profiles trigger reads: `raw_user_meta_data ->> 'full_name'`. An
        // EMPTY name is absent rather than an empty string, so the profile column is
        // null instead of "".
        data: { full_name: parsed.data.fullName || undefined },
      },
    });
    result = response.data;
    error = response.error;
  } catch (unexpected) {
    console.error("signup: the provider call threw", unexpected);
    return toSafeResponse(unexpected);
  }

  if (error) {
    return toSafeResponse(error);
  }

  if (!result?.session) {
    return toSafeResponse(
      new ValidationError(
        "Check your email to confirm your address, then sign in.",
        "confirmation_required",
      ),
    );
  }

  redirect("/app/onboarding");
  return null;
}
