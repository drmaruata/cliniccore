"use server";

import { forgotPasswordSchema } from "@/lib/validation/auth";
import { toSafeResponse, type SafeResponse } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";

export async function forgotPassword(
  _prev: SafeResponse | null,
  data: { email: string },
): Promise<SafeResponse | null> {
  const parsed = forgotPasswordSchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors;
    const message = Object.values(errors).flat().join(", ") || "Invalid input";
    return { status: 422, body: { error: message, code: "validation_failed" } };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/reset-password`,
  });

  if (error) {
    return toSafeResponse(error);
  }

  // Always return success to prevent account enumeration
  return { status: 200, body: { error: "", code: "success" } };
}
