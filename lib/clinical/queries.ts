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
type QueueRow = Database["public"]["Tables"]["queue_entries"]["Row"];
type EncounterRow = Database["public"]["Tables"]["encounters"]["Row"];
type EncounterAddendumRow = Database["public"]["Tables"]["encounter_addenda"]["Row"];

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

/**
 * The open queue for a clinic, ordered by the time each patient was added.
 *
 * WHY `completed_at IS NULL` AND NOT A STATUS FILTER. `completed` and `skipped`
 * both close an entry, and the partial index `queue_open_idx` is built on that
 * predicate, so filtering on it serves the board query from the index. Filtering
 * on `status != 'completed'` would read `skipped` rows onto a board that has no
 * action for them and would not use the index.
 */
export interface QueueWithPatient {
  entry: QueueRow;
  patient: { first_name: string | null; last_name: string | null; mrn: string } | null;
}

export interface EncounterWithDetails {
  encounter: EncounterRow;
  patient: { first_name: string | null; last_name: string | null; mrn: string } | null;
  addenda: (EncounterAddendumRow & { author_name: string | null })[];
}

export async function listQueue(clinicId: string): Promise<QueueWithPatient[]> {
  const org = await getActiveOrg();
  if (!org) return [];

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("queue_entries")
    .select("*, patients(first_name, last_name, mrn)")
    .eq("organization_id", org.id)
    .eq("clinic_id", clinicId)
    .is("completed_at", null)
    .order("queued_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const embedded = row as unknown as EmbeddedRow & { patients: PatientRow | null };
    return { entry: embedded as unknown as QueueRow, patient: toPatient(embedded.patients) };
  });
}

/**
 * Get a single encounter with patient details and addenda.
 * Scoped to the active organization via RLS.
 */
export async function getEncounter(encounterId: string): Promise<EncounterWithDetails | null> {
  const org = await getActiveOrg();
  if (!org) return null;

  const supabase = await createServerClient();

  const { data: encounter, error: encError } = await supabase
    .from("encounters")
    .select("*, patients(first_name, last_name, mrn)")
    .eq("id", encounterId)
    .eq("organization_id", org.id)
    .single();

  if (encError) {
    if (encError.code === "PGRST116") return null;
    throw encError;
  }

  const { data: addenda, error: addError } = await supabase
    .from("encounter_addenda")
    .select("*, profiles:author_user_id(first_name, last_name)")
    .eq("encounter_id", encounterId)
    .eq("organization_id", org.id)
    .order("created_at", { ascending: true });

  if (addError) throw addError;

  const embedded = encounter as unknown as EncounterRow & { patients: PatientRow | null };
  const addendaWithNames = (addenda ?? []).map((a) => {
    const p = a as unknown as EncounterAddendumRow & {
      profiles: { first_name: string | null; last_name: string | null } | null;
    };
    return {
      ...a,
      author_name: p.profiles
        ? `${p.profiles.first_name ?? ""} ${p.profiles.last_name ?? ""}`.trim() || null
        : null,
    };
  });

  return {
    encounter: embedded,
    patient: toPatient(embedded.patients),
    addenda: addendaWithNames,
  };
}
