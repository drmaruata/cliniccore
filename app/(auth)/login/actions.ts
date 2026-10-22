"use server";

import { loginSchema } from "@/lib/validation/auth";
import {
  AppError,
  toSafeResponse,
  UnauthorizedError,
  ValidationError,
  type SafeResponse,
} from "@/lib/errors";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

/**
 * The sign-in mutation.
 *
 * WHY A WRONG PASSWORD IS A 401 AND NOT A GENERIC 500. `toSafeResponse` only lets an
 * `AppError` contribute a message, and a Supabase `AuthError` is not one - so a typo
 * was reported as "Something went wrong. Please try again.", which is the one message
 * that cannot help anybody. The provider answers "invalid login credentials" with the
 * code `invalid_credentials` for BOTH a wrong password and an unknown address, so
 * saying "Invalid email or password." is enumeration-safe: it says exactly the same
 * thing either way.
 *
 * WHY THE MAPPING IS BY CODE AND NOT BY MESSAGE. A code survives a wording change that
 * a message would not, and a message that changed would silently turn the two cases
 * into different answers - which is an account-existence oracle.
 *
 * WHY THE TRY IS AROUND THE PROVIDER CALL ONLY. `redirect()` throws a NEXT_REDIRECT
 * sentinel, and catching that would swallow the redirect and answer with a response
 * instead. A THROWN action, though, would leave the user with no message at all and
 * eject them to the global error page - `(auth)` has no `error.tsx`.
 */
export async function login(
  _prev: SafeResponse | null,
  data: unknown,
): Promise<SafeResponse | null> {
  const parsed = loginSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return toSafeResponse(new ValidationError(fieldErrorMessage(parsed.error)));
  }

  const supabase = await createServerClient();

  let error: { message: string; code?: string; status?: number } | null = null;
  try {
    const response = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    error = response.error;
  } catch (unexpected) {
    console.error("login: the provider call threw", unexpected);
    return toSafeResponse(unexpected);
  }

  if (error) {
    // Logged on the server, WITHOUT the address: a login attempt is worth seeing in a
    // log, and the address would put a patient or a clinician's identity in one.
    console.error("login failed", error.code ?? "unknown", error.status ?? "unknown");

    if (error.code === "invalid_credentials") {
      return toSafeResponse(new UnauthorizedError("Invalid email or password."));
    }
    if (error.status === 429) {
      return toSafeResponse(
        new AppError("Too many attempts. Please try again shortly.", 429, "rate_limited"),
      );
    }
    return toSafeResponse(error);
  }

  redirect("/app/dashboard");
  return null;
}
