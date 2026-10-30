"use server";

import { revalidatePath } from "next/cache";

import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toActionResult,
  UnauthorizedError,
  ValidationError,
  type ActionResult,
} from "@/lib/errors";
import { createServerClient, getUser } from "@/lib/supabase/server";
import {
  queueInputSchema,
  QUEUE_STATUS_TRANSITIONS,
  queueStatusInputSchema,
  type QueueStatus,
} from "@/lib/validation/patients";

/**
 * Queue mutations: adding a patient to the board and transitioning queue status.
 *
 * WHY EVERY REFUSAL IS A VALUE, NOT A THROW. A thrown error inside a Server Action is a
 * 500, and a 500 is not a field message: the user loses the sentence that says what to
 * do. So the organization, the permission and the schema are all checked here and
 * returned as `ActionResult` failures. `userCan` is ADVISORY - RLS is the boundary that
 * actually decides, and a policy refusal arrives as a PostgREST error and goes through
 * `toActionResult` like any other.
 *
 * WHY A 23505 CONFLICT IS REWRITTEN. The partial unique index `queue_one_open_per_patient_idx`
 * allows at most one open queue entry per patient per clinic. A second addition raises a
 * 23505, which PostgREST renders as a raw constraint failure. Rewriting it here keeps the
 * error message user-friendly and avoids echoing database identifiers.
 *
 * WHY COMPLETED_AT IS STAMPED WHEN MOVING TO COMPLETED OR SKIPPED. The partial index
 * `queue_open_idx` and `queue_one_open_per_patient_idx` both check `completed_at IS NULL`.
 * When an entry completes or is skipped, setting `completed_at = now()` moves it out of
 * the open set so the patient can be queued again later.
 */

const NO_ACTIVE_ORG = "Choose an organization before continuing.";

function statusLabel(status: string): string {
  switch (status) {
    case "in_consultation":
      return "in consultation";
    default:
      return status;
  }
}

export async function addToQueue(
  _prev: ActionResult<{ entryId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ entryId: string }>> {
  const input = toActionInput(data);
  const parsed = queueInputSchema.safeParse({
    patientId: typeof input.patientId === "string" ? input.patientId : "",
    clinicId: typeof input.clinicId === "string" ? input.clinicId : "",
    appointmentId:
      typeof input.appointmentId === "string" && input.appointmentId.length > 0
        ? input.appointmentId
        : null,
  });

  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  if (!(await userCan("appointments.manage", parsed.data.clinicId))) {
    return toActionResult(
      new ForbiddenError("You cannot manage the queue in that clinic.", "queue_refused"),
    );
  }

  const user = await getUser();
  if (!user) {
    return toActionResult(new UnauthorizedError("You must be signed in.", "unauthorized"));
  }

  const supabase = await createServerClient();
  const { data: inserted, error } = await supabase
    .from("queue_entries")
    .insert({
      organization_id: org.id,
      clinic_id: parsed.data.clinicId,
      patient_id: parsed.data.patientId,
      appointment_id: parsed.data.appointmentId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return toActionResult(
        new ConflictError("Patient is already in the queue for this clinic.", "already_queued"),
      );
    }
    return toActionResult(error);
  }

  revalidatePath("/app/queue");
  return { ok: true, value: { entryId: inserted.id } };
}

export async function setQueueStatus(
  _prev: ActionResult<{ entryId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ entryId: string }>> {
  const parsed = queueStatusInputSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  const supabase = await createServerClient();
  const { data: entry, error: readError } = await supabase
    .from("queue_entries")
    .select("id, clinic_id, status")
    .eq("organization_id", org.id)
    .eq("id", parsed.data.entryId)
    .maybeSingle();

  if (readError) return toActionResult(readError);
  if (!entry) {
    return toActionResult(new NotFoundError("Queue entry not found.", "queue_entry_not_found"));
  }

  if (!(await userCan("appointments.manage", entry.clinic_id))) {
    return toActionResult(
      new ForbiddenError("You cannot change queue status in that clinic.", "queue_refused"),
    );
  }

  const current = entry.status as QueueStatus;
  const transitions = QUEUE_STATUS_TRANSITIONS[current] ?? [];
  if (!transitions.includes(parsed.data.status)) {
    return toActionResult(
      new ValidationError(
        `A queue entry that is ${statusLabel(current)} cannot move to ${statusLabel(parsed.data.status)}.`,
        "invalid_transition",
      ),
    );
  }

  const updates: { status: QueueStatus; called_at?: string | null; completed_at?: string | null } =
    {
      status: parsed.data.status,
    };

  const now = new Date().toISOString();
  if (parsed.data.status === "called") {
    updates.called_at = now;
  } else if (parsed.data.status === "completed" || parsed.data.status === "skipped") {
    updates.completed_at = now;
  }

  const { error } = await supabase
    .from("queue_entries")
    .update(updates)
    .eq("organization_id", org.id)
    .eq("id", parsed.data.entryId);

  if (error) {
    if (error.code === "23505") {
      return toActionResult(
        new ConflictError("Patient is already in the queue for this clinic.", "already_queued"),
      );
    }
    return toActionResult(error);
  }

  revalidatePath("/app/queue");
  return { ok: true, value: { entryId: parsed.data.entryId } };
}
