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
 * that cannot help anybody. Supabase answers "Invalid login credentials" for BOTH a
 * wrong password and an unknown address, so saying "Invalid email or password." is
 * enumeration-safe: it says exactly the same thing either way.
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
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // Logged on the server, WITHOUT the address: a login attempt is worth seeing in a
    // log, and the address would put a patient or a clinician's identity in one.
    console.error("login failed", error.code ?? "unknown", error.status ?? "unknown");
    // BY THE ERROR CODE, NOT THE MESSAGE. MEASURED: the provider answers
    // "invalid login credentials" with the code "invalid_credentials" for BOTH a wrong
    // password and an unknown address, so the two are indistinguishable - and a code
    // survives a wording change that a message would not. A rate limit is its own
    // case, and it is the same for every account. Everything else is an outage, and
    // the generic 500 says so without distinguishing anybody.
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

  // The signed-in application lives under `/app`. Task 16 creates the routes; this
  // task only decides where a successful sign-in goes.
  redirect("/app/dashboard");
  return null;
}
