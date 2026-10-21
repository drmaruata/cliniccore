"use server";

import { resetPasswordFormSchema } from "@/lib/validation/auth";
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
 * The password change.
 *
 * ONE SCHEMA, USED BY BOTH SIDES. The client resolver and this action must agree, or
 * the form accepts something the server refuses - and the disagreement is invisible
 * until a user hits it. The confirmation match lives in the schema for that reason.
 *
 * THE SESSION IS THE PRECONDITION, NOT A DETAIL. `updateUser` needs a signed-in user,
 * and the recovery session is established by the code exchange in
 * `app/api/auth/verify/route.ts` - a ROUTE HANDLER, because a Server Component cannot
 * set cookies. So the page checks for a session and the action may assume one.
 */
export async function resetPassword(
  _prev: SafeResponse | null,
  data: unknown,
): Promise<SafeResponse | null> {
  const parsed = resetPasswordFormSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return toSafeResponse(new ValidationError(fieldErrorMessage(parsed.error)));
  }

  const supabase = await createServerClient();

  // THE SESSION IS CHECKED HERE AS WELL AS IN THE PAGE. The page's check decides
  // whether the form is shown; this one decides what a DIRECT post is answered, and
  // "this link is no longer valid" is a far better answer than a generic 500.
  const { data: userData, error: sessionError } = await supabase.auth.getUser();
  if (sessionError || !userData.user) {
    return toSafeResponse(new UnauthorizedError("This password reset link is no longer valid."));
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    return toSafeResponse(error);
  }

  redirect("/login");
  return null;
}
