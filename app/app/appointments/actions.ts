"use server";

import { revalidatePath } from "next/cache";

import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import {
  ForbiddenError,
  NotFoundError,
  toActionResult,
  UnauthorizedError,
  ValidationError,
  type ActionResult,
} from "@/lib/errors";
import { createServerClient, getUser } from "@/lib/supabase/server";
import {
  APPOINTMENT_STATUS_TRANSITIONS,
  appointmentInputSchema,
  appointmentStatusInputSchema,
  type AppointmentStatus,
} from "@/lib/validation/patients";
import { clinicWallTimeToInstant } from "@/lib/utils/datetime";

/**
 * The appointment mutations: booking and status changes.
 *
 * WHY EVERY REFUSAL IS A VALUE, NOT A THROW. A thrown error inside a Server Action is a
 * 500, and a 500 is not a field message: the user loses the sentence that says what to
 * do. So the organization, the permission and the schema are all checked here and
 * returned as `ActionResult` failures. `userCan` is ADVISORY - RLS is the boundary that
 * actually decides, and a policy refusal arrives as a PostgREST error and goes through
 * `toActionResult` like any other.
 *
 * WHY THE START INSTANT IS MEASURED, NOT PARSED. A form posts `YYYY-MM-DD` and `HH:MM`
 * with no zone, and `new Date(...)` reads that in the SERVER's zone. `clinicWallTimeToInstant`
 * converts the pair through the clinic's own zone, so a 09:00 booking in Kolkata lands at
 * 09:00 local on any host, and a wall-clock time the zone skipped raises rather than
 * silently booking an hour later.
 *
 * WHY THE STATUS GRAPH IS VALIDATED IN TYPESCRIPT BEFORE THE UPDATE. The trigger
 * `guard_appointment_status_transition` is the authority - an UPDATE that bypasses this
 * action must not move a completed appointment back to booked - but the action answers
 * the user's question ("can I move this?") before it asks the database, so the refusal
 * carries the current and target labels. The two graphs are kept in sync deliberately.
 */
const NO_ACTIVE_ORG = "Choose an organization before continuing.";
const END_AFTER_START = "The appointment must end after it starts.";

function statusLabel(status: string): string {
  switch (status) {
    case "checked_in":
      return "checked in";
    case "no_show":
      return "a no-show";
    default:
      return status;
  }
}

export async function bookAppointment(
  _prev: ActionResult<{ appointmentId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ appointmentId: string }>> {
  const input = toActionInput(data);
  const rawDuration = input.durationMinutes;
  const clinicId = typeof input.clinicId === "string" ? input.clinicId : "";
  const patientId = typeof input.patientId === "string" ? input.patientId : "";

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  if (!(await userCan("appointments.manage", clinicId))) {
    return toActionResult(
      new ForbiddenError("You cannot book appointments in that clinic.", "appointment_refused"),
    );
  }

  const user = await getUser();
  if (!user) {
    return toActionResult(new UnauthorizedError("You must be signed in.", "unauthorized"));
  }

  let startsAt: string;
  try {
    startsAt = clinicWallTimeToInstant(
      typeof input.date === "string" ? input.date : "",
      typeof input.time === "string" ? input.time : "",
      org.timezone,
    );
  } catch {
    return toActionResult(
      new ValidationError("That time does not exist in the clinic's time zone.", "invalid_start"),
    );
  }

  const parsed = appointmentInputSchema.safeParse({
    patientId,
    clinicId,
    clinicianUserId: user.id,
    startsAt,
    durationMinutes: rawDuration === "" || rawDuration === undefined ? 30 : Number(rawDuration),
    reason: typeof input.reason === "string" ? input.reason : "",
  });
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const scheduledEnd = new Date(
    new Date(startsAt).getTime() + parsed.data.durationMinutes * 60_000,
  ).toISOString();

  const supabase = await createServerClient();
  const { data: inserted, error } = await supabase
    .from("appointments")
    .insert({
      organization_id: org.id,
      clinic_id: parsed.data.clinicId,
      patient_id: parsed.data.patientId,
      clinician_user_id: user.id,
      created_by: user.id,
      scheduled_start: startsAt,
      scheduled_end: scheduledEnd,
      reason: parsed.data.reason,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23514") {
      return toActionResult(new ValidationError(END_AFTER_START, "invalid_duration"));
    }
    return toActionResult(error);
  }

  revalidatePath("/app/appointments");
  return { ok: true, value: { appointmentId: inserted.id } };
}

export async function setAppointmentStatus(
  _prev: ActionResult<{ appointmentId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ appointmentId: string }>> {
  const parsed = appointmentStatusInputSchema.safeParse(toActionInput(data));
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  const user = await getUser();
  if (!user) {
    return toActionResult(new UnauthorizedError("You must be signed in.", "unauthorized"));
  }

  const supabase = await createServerClient();
  const { data: appointment, error: readError } = await supabase
    .from("appointments")
    .select("id, clinic_id, patient_id, status")
    .eq("organization_id", org.id)
    .eq("id", parsed.data.appointmentId)
    .maybeSingle();

  if (readError) return toActionResult(readError);
  if (!appointment) {
    return toActionResult(
      new NotFoundError("That appointment was not found.", "appointment_not_found"),
    );
  }

  if (!(await userCan("appointments.manage", appointment.clinic_id))) {
    return toActionResult(
      new ForbiddenError("You cannot change that appointment.", "appointment_refused"),
    );
  }

  const current = appointment.status as AppointmentStatus;
  const transitions = APPOINTMENT_STATUS_TRANSITIONS[current] ?? [];
  if (!transitions.includes(parsed.data.status)) {
    return toActionResult(
      new ValidationError(
        `An appointment that is ${statusLabel(current)} cannot move to ${statusLabel(parsed.data.status)}.`,
        "invalid_transition",
      ),
    );
  }

  const { error } = await supabase
    .from("appointments")
    .update({ status: parsed.data.status })
    .eq("organization_id", org.id)
    .eq("id", parsed.data.appointmentId);

  if (error) return toActionResult(error);

  // Checking in an appointment puts the patient on the clinic queue board. The entry is
  // created AFTER the status change succeeds, so a refused transition never leaves a
  // queue row behind, and the duplicate-open-entry guard is exercised by the queue action
  // rather than by this one.
  if (parsed.data.status === "checked_in") {
    const { error: queueError } = await supabase
      .from("queue_entries")
      .insert({
        organization_id: org.id,
        clinic_id: appointment.clinic_id,
        patient_id: appointment.patient_id,
        appointment_id: parsed.data.appointmentId,
        created_by: user.id,
      })
      .select("id")
      .maybeSingle();
    if (queueError && queueError.code !== "23505") {
      return toActionResult(queueError);
    }
  }

  revalidatePath("/app/appointments");
  revalidatePath("/app/queue");
  return { ok: true, value: { appointmentId: parsed.data.appointmentId } };
}
