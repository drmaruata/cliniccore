"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getActiveOrg, listMemberOrgs, setActiveOrg } from "@/lib/auth/active-org";
import { writeActiveClinicId } from "@/lib/auth/session";
import {
  ForbiddenError,
  toSafeResponse,
  UnauthorizedError,
  ValidationError,
  type SafeResponse,
} from "@/lib/errors";
import { createServerClient, getUser } from "@/lib/supabase/server";

/**
 * The shell's mutations: switching organization, switching clinic, signing out.
 *
 * WHY EVERY ONE OF THEM VALIDATES BEFORE IT WRITES. The active-organization cookie is
 * a hint, and a hint that names a tenant the user does not belong to is a hole in
 * every page that reads it. The membership is therefore checked HERE, at the moment
 * the user asks, and the cookie is written only after the check passes. The read path
 * re-validates anyway - that is the design of `lib/auth/active-org.ts` - so this check
 * buys an earlier and clearer refusal, not the security.
 *
 * WHY A REFUSAL IS A RESPONSE AND NOT A THROW. A thrown action leaves the user with no
 * message and ejects them to the global error page; `(app)` has no `error.tsx`. So the
 * failures are turned into `SafeResponse`s by the one sanctioned path.
 */

/**
 * Point the session at another organization the user belongs to.
 *
 * THE MEMBERSHIP CHECK IS NOT A LOOKUP THE CLIENT CAN SKIP. The organization id
 * arrives from the browser, so it is untrusted input: the list of organizations the
 * user actually belongs to is fetched from the database and the id has to be in it.
 */
export async function switchOrganization(orgId: string): Promise<SafeResponse | null> {
  const parsed = z.uuid().safeParse(orgId);
  if (!parsed.success) {
    return toSafeResponse(new ValidationError("That organization is not valid."));
  }

  const user = await getUser();
  if (!user) {
    return toSafeResponse(new UnauthorizedError());
  }

  const organizations = await listMemberOrgs(user.id);
  if (!organizations.some((org) => org.id === parsed.data)) {
    return toSafeResponse(
      new ForbiddenError("You are not a member of that organization.", "not_a_member"),
    );
  }

  await setActiveOrg(parsed.data);
  revalidatePath("/", "layout");
  return null;
}

/**
 * Point the session at another clinic the user can reach.
 *
 * THE CLINIC MUST BELONG TO THE ACTIVE ORGANIZATION. The `clinics` SELECT policy spans
 * every organization the user is a member of, so a lookup by id alone would accept the
 * other tenant's clinic - and a cookie naming it is a cross-tenant filter the moment a
 * clinical screen reads it. The active organization is resolved first and the clinic
 * has to be in it.
 *
 * THE REACH CHECK IS THE POLICY. The same SELECT policy is the organization's clinics
 * AND the ones the user can reach, so a query for one clinic id answers only for a
 * clinic the user may read. A clinic that comes back empty is a clinic the user
 * cannot reach.
 */
export async function switchClinic(clinicId: string): Promise<SafeResponse | null> {
  const parsed = z.uuid().safeParse(clinicId);
  if (!parsed.success) {
    return toSafeResponse(new ValidationError("That clinic is not valid."));
  }

  const org = await getActiveOrg();
  if (!org) {
    return toSafeResponse(
      new ValidationError("Choose an organization before choosing a clinic.", "no_active_org"),
    );
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("clinics")
    .select("id")
    .eq("id", parsed.data)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (error) {
    return toSafeResponse(error);
  }
  if (!data) {
    return toSafeResponse(
      new ForbiddenError("You cannot reach that clinic.", "clinic_not_reachable"),
    );
  }

  await writeActiveClinicId(data.id);
  revalidatePath("/", "layout");
  return null;
}

/**
 * Sign out, and go to the sign-in page.
 *
 * WHY THE REDIRECT IS OUTSIDE THE TRY. `redirect()` throws a sentinel, and catching it
 * would swallow the redirect and leave the user on a page they are no longer signed in
 * to. The sign-out call itself is guarded, because a failure there must not leave the
 * user stuck in the application with a session they asked to end.
 */
export async function signOut(): Promise<void> {
  const supabase = await createServerClient();
  try {
    await supabase.auth.signOut();
  } catch (unexpected) {
    console.error("signOut: the provider call threw", unexpected);
  }
  redirect("/login");
}
