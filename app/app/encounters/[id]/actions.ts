"use server";

import { requireActiveOrg } from "@/lib/auth/active-org";
import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

/**
 * Save draft encounter fields.
 */
export async function saveEncounterDraftAction(
  encounterId: string,
  draft: {
    chief_complaint: string;
    history: string;
    examination: string;
    assessment: string;
    plan: string;
  },
): Promise<{ success: boolean; error?: string }> {
  const org = await requireActiveOrg();
  const supabase = await createServerClient();

  const { error } = await supabase
    .from("encounters")
    .update({
      chief_complaint: draft.chief_complaint || null,
      history: draft.history || null,
      examination: draft.examination || null,
      assessment: draft.assessment || null,
      plan: draft.plan || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", encounterId)
    .eq("organization_id", org.id);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath(`/app/encounters/${encounterId}`);
  return { success: true };
}

/**
 * Finalize a draft encounter via the private RPC.
 * Validates input, calls the SECURITY DEFINER function, and revalidates the encounter page.
 */
export async function finalizeEncounterAction(
  encounterId: string,
): Promise<{ success: boolean; error?: string }> {
  await requireActiveOrg();
  const supabase = await createServerClient();

  // @ts-expect-error - RPC function not yet in generated types
  const { error } = await supabase.rpc("finalize_encounter_rpc", {
    p_encounter_id: encounterId,
  });

  if (error) {
    const msg = error.message.includes("already finalized")
      ? "Encounter is already finalized"
      : error.message.includes("not found") || error.message.includes("PGRST116")
        ? "Encounter not found"
        : "Failed to finalize encounter";
    return { success: false, error: msg };
  }

  revalidatePath(`/app/encounters/${encounterId}`);
  return { success: true };
}

/**
 * Add an addendum to a finalized encounter via the private RPC.
 * Validates input, calls the SECURITY DEFINER function, and revalidates the encounter page.
 */
export async function addEncounterAddendumAction(
  encounterId: string,
  body: string,
): Promise<{ success: boolean; error?: string }> {
  await requireActiveOrg();
  const supabase = await createServerClient();

  if (!body || body.trim().length === 0) {
    return { success: false, error: "Addendum body is required" };
  }
  if (body.length > 8000) {
    return { success: false, error: "Addendum body exceeds 8000 characters" };
  }

  // @ts-expect-error - RPC function not yet in generated types
  const { error } = await supabase.rpc("add_encounter_addendum_rpc", {
    p_encounter_id: encounterId,
    p_body: body.trim(),
  });

  if (error) {
    const msg = error.message.includes("not finalized")
      ? "Cannot add addendum to a draft encounter"
      : error.message.includes("not found") || error.message.includes("PGRST116")
        ? "Encounter not found"
        : "Failed to add addendum";
    return { success: false, error: msg };
  }

  revalidatePath(`/app/encounters/${encounterId}`);
  return { success: true };
}
