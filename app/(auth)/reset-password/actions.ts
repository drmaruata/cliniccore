"use server";

import { resetPasswordSchema } from "@/lib/validation/auth";
import { toSafeResponse } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type ResetPasswordInput = {
  password: string;
  confirmPassword: string;
};

export async function resetPassword(
  _prev: { status: number; body: { error: string; code: string } } | null,
  data: ResetPasswordInput,
): Promise<{ status: number; body: { error: string; code: string } } | null> {
  if (data.password !== data.confirmPassword) {
    return {
      status: 422,
      body: { error: "Passwords do not match", code: "validation_failed" },
    };
  }

  const parsed = resetPasswordSchema.safeParse({ password: data.password });
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors;
    const message = Object.values(errors).flat().join(", ") || "Invalid input";
    return { status: 422, body: { error: message, code: "validation_failed" } };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    return toSafeResponse(error);
  }

  redirect("/login");
  return null;
}
