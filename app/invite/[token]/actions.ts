"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { setActiveOrg } from "@/lib/auth/active-org";
import {
  ForbiddenError,
  NotFoundError,
  toSafeResponse,
  ValidationError,
  type SafeResponse,
} from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Redeem an invitation.
 *
 * WHY THE DATABASE DECIDES AND NOT THIS ACTION. The token is a capability: whoever
 * holds it may join. The rules that decide whether it still works - has it expired, has
 * it been used, is the organization still active, is the role one of that tenant's -
 * all live in `private.accept_invitation`, and this action only translates the
 * database's answer into something a person can read.
 *
 * WHY THE CODES ARE MAPPED AND NOT THE MESSAGES. The database raises
 * `P0002` for a token that matches nothing, `22023` for one that is expired or already
 * used, and `42501` for a caller who is not signed in. A code survives a reworded
 * message; a message does not. The wording the user sees is written here, never
 * forwarded from the database.
 */
export async function acceptInvitation(token: string): Promise<SafeResponse | null> {
  const parsed = z.string().min(32).safeParse(token);
  if (!parsed.success) {
    return toSafeResponse(
      new ValidationError("That invitation link is not valid.", "invalid_invitation"),
    );
  }

  const supabase = await createServerClient();

  let membershipId: string | null = null;
  let error: { code?: string; message?: string } | null = null;
  try {
    const response = await supabase.rpc("accept_invitation", { p_token: parsed.data });
    membershipId = response.data ?? null;
    error = response.error;
  } catch (unexpected) {
    console.error("acceptInvitation: the provider call threw", unexpected);
    return toSafeResponse(unexpected);
  }

  if (error) {
    if (error.code === "P0002") {
      return toSafeResponse(
        new NotFoundError("That invitation link is not valid.", "unknown_invitation"),
      );
    }
    if (error.code === "22023") {
      return toSafeResponse(
        new ValidationError(
          "That invitation has expired, or has already been used.",
          "invitation_not_usable",
        ),
      );
    }
    if (error.code === "42501") {
      return toSafeResponse(
        new ForbiddenError("Sign in to accept an invitation.", "not_signed_in"),
      );
    }
    return toSafeResponse(error);
  }

  if (!membershipId) {
    return toSafeResponse(
      new ValidationError("That invitation could not be accepted.", "not_accepted"),
    );
  }

  // The membership names the organization, and the new member is dropped straight into
  // the clinic they just joined.
  const { data: membership } = await supabase
    .from("organization_memberships")
    .select("organization_id")
    .eq("id", membershipId)
    .maybeSingle();
  if (membership) {
    await setActiveOrg(membership.organization_id);
  }

  // The redirect is outside the try: `redirect()` throws a sentinel, and catching it
  // would swallow the navigation.
  redirect("/app/dashboard");
  return null;
}
