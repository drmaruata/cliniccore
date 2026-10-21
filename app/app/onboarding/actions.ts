"use server";

import { redirect } from "next/navigation";

import { setActiveOrg } from "@/lib/auth/active-org";
import { toActionInput, fieldErrorMessage } from "@/lib/auth/action-input";
import { ConflictError, toSafeResponse, ValidationError, type SafeResponse } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import { createOrganizationSchema } from "@/lib/validation/auth";

/**
 * The onboarding mutation: create the organization, its first clinic and the caller's
 * ownership of both.
 *
 * WHY THE UNIQUE VIOLATION IS A FRIENDLY ERROR AND NOT A 500. The slug is the tenant
 * key, and two people can want the same one; the database refuses the second with
 * SQLSTATE 23505, which PostgREST reports as a unique-violation error. Surfaced raw
 * that is an opaque database error on a form the user is looking at, and the plan
 * requires a friendly inline message with no 500. So the code is mapped to a
 * `ConflictError` - and the mapping is BY CODE, not by message, because a message can
 * be reworded and a code cannot.
 *
 * WHY THE RAW DATABASE MESSAGE NEVER REACHES THE USER. Only an `AppError` contributes
 * a message to a response, so the words on screen are the ones written here.
 */
export async function createOrganization(
  _prev: SafeResponse | null,
  data: unknown,
): Promise<SafeResponse | null> {
  const parsed = createOrganizationSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return toSafeResponse(new ValidationError(fieldErrorMessage(parsed.error)));
  }

  const supabase = await createServerClient();

  let orgId: string | null = null;
  let error: { code?: string; message?: string } | null = null;
  try {
    const response = await supabase.rpc("create_organization_with_owner", {
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      // The first clinic takes the organization's name. A separate field would be one
      // more thing to get wrong on the first screen, and the clinic can be renamed.
      p_clinic_name: parsed.data.name,
      p_timezone: parsed.data.timezone,
      // The tenant's money and locale. The currency is the unit every amount in this
      // organization will be denominated in, so it is set at creation rather than
      // left at the column default for a later settings screen to change.
      p_currency: parsed.data.currency,
      p_locale: parsed.data.locale,
    });
    orgId = response.data ?? null;
    error = response.error;
  } catch (unexpected) {
    console.error("createOrganization: the provider call threw", unexpected);
    return toSafeResponse(unexpected);
  }

  if (error) {
    if (error.code === "23505") {
      return toSafeResponse(
        new ConflictError(
          "That clinic address is already taken. Choose a different one.",
          "slug_taken",
        ),
      );
    }
    if (error.code === "53400") {
      // The creation cap: five organizations per user in any 24-hour window. It has
      // its OWN SQLSTATE (configuration_limit_exceeded), so this message is about what
      // actually happened rather than about every check violation in the database.
      return toSafeResponse(
        new ValidationError(
          "You have created five clinics in the last day. Wait a while, or contact support.",
          "creation_cap_reached",
        ),
      );
    }
    if (error.code === "23514") {
      // A check violation, which is a CLASS and not a cause: the database refused
      // these details for some reason it did not name.
      return toSafeResponse(
        new ValidationError(
          "The clinic details were refused. Check the name, the address and the time zone.",
          "invalid_clinic_details",
        ),
      );
    }
    if (error.code === "22023") {
      return toSafeResponse(
        new ValidationError(
          "The clinic details were refused. Check the time zone - it must be a canonical IANA name such as Asia/Kolkata.",
          "invalid_clinic_details",
        ),
      );
    }
    return toSafeResponse(error);
  }

  if (!orgId) {
    return toSafeResponse(
      new ValidationError("The clinic could not be created. Please try again.", "not_created"),
    );
  }

  // The new organization becomes the active one, so the user lands in the tenant they
  // just created rather than being asked to choose.
  await setActiveOrg(orgId);

  // The redirect is outside the try: `redirect()` throws a sentinel, and catching it
  // would swallow the navigation.
  redirect("/app/dashboard");
  return null;
}
