"use server";

import { signupSchema, type SignupInput } from "@/lib/validation/auth";
import { toSafeResponse } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export async function signup(
  _prev: { status: number; body: { error: string; code: string } } | null,
  data: SignupInput,
): Promise<{ status: number; body: { error: string; code: string } } | null> {
  const parsed = signupSchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors;
    const message = Object.values(errors).flat().join(", ") || "Invalid input";
    return { status: 422, body: { error: message, code: "validation_failed" } };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: {
        full_name: parsed.data.fullName ?? "",
      },
    },
  });

  if (error) {
    return toSafeResponse(error);
  }

  // Email confirmation is disabled, so the user is signed in immediately
  // Redirect to onboarding (they have no organization yet)
  redirect("/app/onboarding");
  return null;
}
