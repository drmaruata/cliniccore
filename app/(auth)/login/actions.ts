"use server";

import { loginSchema, type LoginInput } from "@/lib/validation/auth";
import { toSafeResponse } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export async function login(
  _prev: { status: number; body: { error: string; code: string } } | null,
  data: LoginInput,
): Promise<{ status: number; body: { error: string; code: string } } | null> {
  const parsed = loginSchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors;
    const message = Object.values(errors).flat().join(", ") || "Invalid input";
    return { status: 422, body: { error: message, code: "validation_failed" } };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return toSafeResponse(error);
  }

  redirect("/app/dashboard");
  return null;
}
