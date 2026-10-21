"use server";

import { loginSchema } from "@/lib/validation/auth";
import {
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
    const invalidCredentials = /invalid login credentials/i.test(error.message);
    return toSafeResponse(
      invalidCredentials ? new UnauthorizedError("Invalid email or password.") : error,
    );
  }

  // The route is `/dashboard`, not `/app/dashboard`: `(app)` is a ROUTE GROUP, and a
  // parenthesised group adds no url segment. The plan's own file tree is
  // `app/(app)/dashboard/page.tsx`.
  redirect("/dashboard");
  return null;
}
