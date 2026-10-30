"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { fieldErrorMessage, toActionInput } from "@/lib/auth/action-input";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toActionResult,
  ValidationError,
  type ActionResult,
} from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import {
  archiveInputSchema,
  identifierInputSchema,
  patientInputSchema,
} from "@/lib/validation/patients";

/**
 * The patient mutations: register, archive and add an identifier.
 *
 * WHY EVERY REFUSAL IS A VALUE, NOT A THROW. A thrown error inside a Server Action is a
 * 500, and a 500 is not a field message: the user loses the sentence that says what to
 * do. So the organization, the permission and the schema are all checked here and
 * returned as `ActionResult` failures. `userCan` is ADVISORY - RLS is the boundary that
 * actually decides, and a policy refusal arrives as a PostgREST error and goes through
 * `toActionResult` like any other.
 *
 * WHY THE OPTIONAL FIELDS ARE NORMALISED BEFORE PARSING. FormData gives every field as a
 * string, so an untouched optional input arrives as `""` - which is not `null` and does
 * not satisfy the Task 4 schemas. The conversion happens here, once, instead of
 * weakening a schema to accept a value the database would store as an empty string.
 *
 * WHY `mrn` IS INSERTED AS AN EMPTY STRING. The column is NOT NULL and has no default,
 * so the generated types require a value; the `patients_assign_mrn` trigger replaces a
 * blank MRN with the clinic's next number before the row is written. A 23505 on that
 * insert is the MRN unique constraint, and its raw message names the constraint and the
 * tenant's own data - so the message is rewritten here and the database text is dropped.
 *
 * WHY ARCHIVE READS THE PATIENT FIRST. The clinic dimension is needed to ask `userCan`
 * about the row, and the row itself may belong to another organization; reading it under
 * the caller's RLS and the explicit organization filter answers both questions without
 * trusting a clinic id posted by the browser. Archiving never deletes: the clinical
 * history must outlive the patient's active status.
 */

const NO_ACTIVE_ORG = "Choose an organization before continuing.";

const OPTIONAL_FIELDS = ["dateOfBirth", "sex", "phone", "email", "reason"] as const;

function normaliseOptionalFields(data: unknown): Record<string, unknown> {
  const input = { ...toActionInput(data) };
  for (const key of OPTIONAL_FIELDS) {
    if (input[key] === "") input[key] = null;
  }
  return input;
}

export async function createPatient(
  _prev: ActionResult<{ patientId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ patientId: string }>> {
  const parsed = patientInputSchema.safeParse(normaliseOptionalFields(data));
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  if (!(await userCan("patients.create", parsed.data.clinicId))) {
    return toActionResult(
      new ForbiddenError("You cannot register patients in that clinic.", "patient_refused"),
    );
  }

  const supabase = await createServerClient();
  const { error } = await supabase.from("patients").insert({
    organization_id: org.id,
    clinic_id: parsed.data.clinicId,
    mrn: "",
    first_name: parsed.data.firstName,
    last_name: parsed.data.lastName,
    date_of_birth: parsed.data.dateOfBirth,
    sex: parsed.data.sex,
    phone: parsed.data.phone,
    email: parsed.data.email,
  });

  if (error) {
    if (error.code === "23505") {
      return toActionResult(
        new ConflictError("Could not allocate a record number. Try again.", "mrn_collision"),
      );
    }
    return toActionResult(error);
  }

  revalidatePath("/app/patients");
  redirect("/app/patients");
}

export async function archivePatient(
  _prev: ActionResult<{ patientId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ patientId: string }>> {
  const parsed = archiveInputSchema.safeParse(normaliseOptionalFields(data));
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  const supabase = await createServerClient();
  const { data: patient, error: readError } = await supabase
    .from("patients")
    .select("clinic_id")
    .eq("organization_id", org.id)
    .eq("id", parsed.data.patientId)
    .maybeSingle();

  if (readError) return toActionResult(readError);
  if (!patient) {
    return toActionResult(
      new NotFoundError("That patient is not in this organization.", "patient_not_found"),
    );
  }

  if (!(await userCan("patients.update", patient.clinic_id))) {
    return toActionResult(new ForbiddenError("You cannot change that patient.", "patient_refused"));
  }

  const { error } = await supabase
    .from("patients")
    .update({ is_archived: true, archived_at: new Date().toISOString() })
    .eq("organization_id", org.id)
    .eq("id", parsed.data.patientId);

  if (error) return toActionResult(error);

  revalidatePath("/app/patients");
  return { ok: true, value: { patientId: parsed.data.patientId } };
}

export async function addIdentifier(
  _prev: ActionResult<{ identifierId: string }> | null,
  data: unknown,
): Promise<ActionResult<{ identifierId: string }>> {
  const parsed = identifierInputSchema.safeParse(normaliseOptionalFields(data));
  if (!parsed.success) {
    return { ok: false, error: fieldErrorMessage(parsed.error), code: "validation_failed" };
  }

  const org = await getActiveOrg();
  if (!org) {
    return toActionResult(new ValidationError(NO_ACTIVE_ORG, "no_active_org"));
  }

  const supabase = await createServerClient();
  const { data: patient, error: readError } = await supabase
    .from("patients")
    .select("clinic_id")
    .eq("organization_id", org.id)
    .eq("id", parsed.data.patientId)
    .maybeSingle();

  if (readError) return toActionResult(readError);
  if (!patient) {
    return toActionResult(
      new NotFoundError("That patient is not in this organization.", "patient_not_found"),
    );
  }

  if (!(await userCan("patients.create", patient.clinic_id))) {
    return toActionResult(
      new ForbiddenError("You cannot register patients in that clinic.", "patient_refused"),
    );
  }

  const { data: identifier, error } = await supabase
    .from("patient_identifiers")
    .insert({
      organization_id: org.id,
      patient_id: parsed.data.patientId,
      kind: parsed.data.kind,
      value: parsed.data.value,
    })
    .select("id")
    .single();

  if (error) return toActionResult(error);

  revalidatePath("/app/patients");
  return { ok: true, value: { identifierId: identifier.id } };
}
