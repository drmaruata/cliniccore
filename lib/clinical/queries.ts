/**
 * Clinical reads: the appointments on a named clinic day.
 *
 * WHY THIS FILE IS SEPARATE FROM `lib/patients/queries.ts`. The patient queries own the
 * tenant filter, the archived filter and the search sanitisation for the patient table.
 * The day view is a different surface - it joins the patient name onto each appointment
 * and scopes by a clinic-local day window, so it has its own home and its own test. A
 * query that mixed the two would be a second place for the `or` grammar to leak a
 * filter.
 *
 * WHY THE DAY WINDOW COMES FROM `clinicDayBoundsForDay` AND NOT FROM `new Date(day)`.
 * `new Date("2026-11-01")` parses as UTC midnight, which is the PREVIOUS local day
 * everywhere west of Greenwich. A page that took `?day=...` from the URL and fed it to
 * that constructor would list the wrong day's appointments in every clinic outside
 * UTC. The bounds function measures the window instead, and raises for a day the zone
 * skips - the page turns that into "today".
 *
 * WHY THE EMBEDDED RELATION IS THE FIRST CHOICE AND THE TWO-QUERY FALLBACK EXISTS.
 * `select("*, patients(first_name, last_name, mrn)")` is one round trip and one tenant
 * filter. The generated types in `types/database.types.ts` may not model the embedded
 * relation, in which case the single query does not typecheck and the fallback runs
 * two queries with the same return shape. The shape is the contract; the round trip is
 * not.
 */
import "server-only";

import { getActiveOrg } from "@/lib/auth/active-org";
import { createServerClient } from "@/lib/supabase/server";
import { clinicDayBoundsForDay } from "@/lib/utils/datetime";
import type { Database } from "../../types/database.types";

type AppointmentRow = Database["public"]["Tables"]["appointments"]["Row"];
type PatientRow = Database["public"]["Tables"]["patients"]["Row"];

interface EmbeddedRow extends AppointmentRow {
  patients: PatientRow | null;
}

export interface AppointmentWithPatient {
  appointment: AppointmentRow;
  patient: { first_name: string | null; last_name: string | null; mrn: string } | null;
}

function toPatient(row: PatientRow | null) {
  if (!row) return null;
  return { first_name: row.first_name, last_name: row.last_name, mrn: row.mrn };
}

export async function listDayAppointments(input: {
  clinicId: string;
  day: string;
}): Promise<AppointmentWithPatient[]> {
  const org = await getActiveOrg();
  if (!org) return [];

  const bounds = clinicDayBoundsForDay(input.day, org.timezone);
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from("appointments")
    .select("*, patients(first_name, last_name, mrn)")
    .eq("organization_id", org.id)
    .eq("clinic_id", input.clinicId)
    .gte("scheduled_start", bounds.startIso)
    .lt("scheduled_start", bounds.endIso)
    .order("scheduled_start", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const embedded = row as unknown as EmbeddedRow;
    return { appointment: embedded, patient: toPatient(embedded.patients) };
  });
}