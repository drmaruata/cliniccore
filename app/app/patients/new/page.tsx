import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getActiveOrg } from "@/lib/auth/active-org";
import { createServerClient } from "@/lib/supabase/server";
import { PatientForm } from "./patient-form";

/**
 * The registration screen: the organization's reachable clinics and the form.
 *
 * WHY THE CLINICS ARE READ HERE AND PASSED AS PROPS. A patient belongs to a clinic, and
 * the insert policy checks reach for that clinic. The list is the database's answer under
 * the caller's RLS, scoped to the active organization so a clinic from a second tenant
 * cannot appear in the picker.
 *
 * WHY THERE IS AN EMPTY STATE INSTEAD OF A FORM WITH NO CLINICS. `patientInputSchema`
 * requires a clinic id, and a form with an empty picker can only fail after the user has
 * filled every other field. The honest answer is that the organization needs a clinic
 * first.
 */
export default async function NewPatientPage() {
  const org = await getActiveOrg();
  if (!org) return null;

  const supabase = await createServerClient();
  const { data } = await supabase
    .from("clinics")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name");

  const clinics = (data ?? []).map((clinic) => ({ id: clinic.id, name: clinic.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Register patient"
        description={`Create a record in ${org.name}. The record number is assigned by the clinic.`}
      />

      {clinics.length === 0 ? (
        <EmptyState
          title="No clinics yet"
          description="A patient belongs to a clinic. Add a clinic to this organization before registering a patient."
        />
      ) : (
        <PatientForm clinics={clinics} />
      )}
    </div>
  );
}
