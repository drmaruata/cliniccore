"use server";

import { createHash, randomBytes } from "node:crypto";

import { getActiveOrg } from "@/lib/auth/active-org";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import {
  ForbiddenError,
  toActionResult,
  UnauthorizedError,
  ValidationError,
  type ActionResult,
} from "@/lib/errors";
import { createServerClient, getUser } from "@/lib/supabase/server";
import { invitationSchema } from "@/lib/validation/invitations";

/**
 * The invitation mutation: create an invitation and hand the owner the link.
 *
 * WHY THE RAW TOKEN IS GENERATED HERE AND ONLY HERE. The token is 32 random bytes,
 * hex-encoded. It exists in the link the owner copies to the invitee and in the
 * redemption request - and nowhere else. What is STORED is its SHA-256 digest, so the
 * invitations table holds no credential: a read of that table by an owner holding
 * `staff.manage` is an ordinary, legitimate read, and it must not hand out a usable
 * invitation.
 *
 * WHY THE HASH IS COMPUTED IN NODE AND NOT BY THE DATABASE. The row is written by this
 * action as the signed-in user, under the `invitations` INSERT policy - which is what
 * makes that policy the boundary that decides who may invite anybody. The acceptance
 * function hashes the token it is given with `pg_catalog.sha256`, and the two digests
 * must be the same bytes over the same input. MEASURED: node's
 * `createHash("sha256")` and postgres' `sha256(convert_to(...))` agree byte for byte,
 * and the E2E spec asserts the stored digest against an independent node digest.
 *
 * WHY THE ROLE IS RESOLVED THROUGH THE DATABASE. `grantable_roles` is the answer to
 * "which of this organization's roles may the CALLER grant", judged by
 * `private.can_assign_role` - the grant ceiling and the rule that only an existing
 * organization_owner may mint another one. The list is not computed here, because a
 * second copy of a privilege rule is how the platform-key clause came to exist twice
 * and drift once.
 */

const INVITATION_LIFETIME_DAYS = 7;

export async function createInvitation(
  _prev: ActionResult<{ inviteUrl: string; email: string }> | null,
  data: unknown,
): Promise<ActionResult<{ inviteUrl: string; email: string }>> {
  const parsed = invitationSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const supabase = await createServerClient();
  const user = await getUser();
  if (!user) {
    return toActionResult(new UnauthorizedError());
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(
      new ValidationError("Choose an organization before inviting staff.", "no_active_org"),
    );
  }

  const { data: grantable, error: grantableError } = await supabase.rpc("grantable_roles", {
    p_org_id: org.id,
  });
  if (grantableError) {
    return toActionResult(grantableError);
  }

  const role = (grantable ?? []).find((candidate) => candidate.role_key === parsed.data.roleKey);
  if (!role) {
    return toActionResult(
      new ForbiddenError("You cannot grant that role in this organization.", "role_not_grantable"),
    );
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const expiresAt = new Date(
    Date.now() + INVITATION_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { error } = await supabase.from("invitations").insert({
    organization_id: org.id,
    email: parsed.data.email,
    role_id: role.role_id,
    token_hash: tokenHash,
    expires_at: expiresAt,
    invited_by: user.id,
  });

  if (error) {
    // 42501 is the RLS refusal: the policy decided this caller may not create this
    // invitation, and the database does not say which clause said no. The message is
    // ours, and it does not leak the rule.
    if (error.code === "42501") {
      return toActionResult(
        new ForbiddenError("You cannot invite staff with that role.", "invitation_refused"),
      );
    }
    return toActionResult(error);
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return {
    ok: true,
    value: {
      email: parsed.data.email,
      inviteUrl: `${baseUrl}/invite/${token}`,
    },
  };
}
