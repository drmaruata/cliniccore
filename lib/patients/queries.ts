/**
 * Server-only patient reads.
 *
 * Every query is scoped twice: the explicit `organization_id` filter keeps a user who
 * belongs to several tenants inside the one they chose, and RLS is the boundary that
 * refuses anything else. The active organization comes from the cookie re-validated
 * against membership by `getActiveOrg`; when it resolves to null the answer is empty, not
 * an unfiltered read.
 *
 * Search input is stripped of the characters PostgREST's `or` grammar treats as syntax
 * (comma, parentheses, quotes, backslash) so a name cannot add a filter of its own. `%`
 * and `_` stay because they are the wildcards the user is typing around.
 *
 * A missing patient is null, not an exception: RLS hides another tenant's row and the
 * detail page renders "not found" the same way for both cases, which is the point.
 *
 * WHY THE DETAIL READS ARE A COMPOSITE AND NOT FOUR PAGE QUERIES. The page needs the
 * patient, the identifiers, the appointments and the encounters, and every child read is
 * scoped by the same organization and parent. Keeping the reads here means the tenant
 * filter cannot be forgotten in one section, and `Promise.all` runs the three child
 * queries only after the parent exists - a missing or foreign id costs one read, not four.
 * A query error is thrown, because the detail page is a Server Component and a failed
 * section must be a 500 rather than a silently empty table.
 */
import "server-only";

import { getActiveOrg } from "@/lib/auth/active-org";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "../../types/database.types";

type PatientRow = Database["public"]["Tables"]["patients"]["Row"];
type AppointmentRow = Database["public"]["Tables"]["appointments"]["Row"];

export interface ListPatientsOptions {
  search?: string | null;
  includeArchived?: boolean;
}

export interface PatientDetail {
  patient: PatientRow;
  identifiers: Database["public"]["Tables"]["patient_identifiers"]["Row"][];
  appointments: AppointmentRow[];
  encounters: Database["public"]["Tables"]["encounters"]["Row"][];
}

function sanitizeSearch(term: string): string {
  return term.replace(/[(),"\\]/g, "").trim();
}

export async function listPatients(options: ListPatientsOptions = {}): Promise<PatientRow[]> {
  const org = await getActiveOrg();
  if (!org) return [];

  const supabase = await createServerClient();
  let query = supabase
    .from("patients")
    .select("*")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: false });

  if (!options.includeArchived) query = query.eq("is_archived", false);

  const term = options.search ? sanitizeSearch(options.search) : "";
  if (term.length > 0) {
    query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,mrn.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  return data ?? [];
}

export async function getPatientDetail(patientId: string): Promise<PatientDetail | null> {
  const org = await getActiveOrg();
  if (!org) return null;

  const supabase = await createServerClient();
  const { data: patient, error: patientError } = await supabase
    .from("patients")
    .select("*")
    .eq("organization_id", org.id)
    .eq("id", patientId)
    .maybeSingle();

  if (patientError) throw patientError;
  if (!patient) return null;

  const [identifiersResult, appointmentsResult, encountersResult] = await Promise.all([
    supabase
      .from("patient_identifiers")
      .select("*")
      .eq("organization_id", org.id)
      .eq("patient_id", patientId)
      .order("created_at"),
    supabase
      .from("appointments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("patient_id", patientId)
      .order("scheduled_start", { ascending: false }),
    supabase
      .from("encounters")
      .select("*")
      .eq("organization_id", org.id)
      .eq("patient_id", patientId)
      .order("started_at", { ascending: false }),
  ]);

  if (identifiersResult.error) throw identifiersResult.error;
  if (appointmentsResult.error) throw appointmentsResult.error;
  if (encountersResult.error) throw encountersResult.error;

  return {
    patient,
    identifiers: identifiersResult.data ?? [],
    appointments: appointmentsResult.data ?? [],
    encounters: encountersResult.data ?? [],
  };
}

export async function listPatientAppointments(patientId: string): Promise<AppointmentRow[]> {
  const org = await getActiveOrg();
  if (!org) return [];

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("organization_id", org.id)
    .eq("patient_id", patientId)
    .order("scheduled_start", { ascending: false });

  if (error) throw error;

  return data ?? [];
}
