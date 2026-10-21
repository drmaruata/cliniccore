import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { getActiveOrg } from "@/lib/auth/active-org";
import { readActiveClinicId } from "@/lib/auth/session";
import { createServerClient, getClaims } from "@/lib/supabase/server";

/**
 * The dashboard: the active organization, and the caller's own role assignments.
 *
 * WHY THERE ARE NO NUMBERS ON THIS PAGE. There is no clinical data yet - no patients,
 * no appointments, no invoices - and a dashboard that shows "142 patients" is a
 * fabrication. Every figure on this page is read from the database; where there is
 * nothing to show, the page says so in an explicit empty state rather than filling the
 * space with a placeholder.
 *
 * WHY THE ROLE ASSIGNMENTS ARE THE CALLER'S OWN. The `user_role_assignments` SELECT
 * policy lets a user read their own assignments, and a staff manager read their
 * organization's. This page asks for the caller's, because "what may I do here" is the
 * question a dashboard answers.
 */
interface AssignmentRow {
  id: string;
  clinic_id: string | null;
  roles: { key: string; name: string } | null;
}

export default async function DashboardPage() {
  const org = await getActiveOrg();
  // The shell renders the onboarding screen in this state and does not render the
  // page at all, so this is only reached in a race the layout has already answered.
  if (!org) return null;

  const claims = await getClaims().catch(() => null);
  const userId = claims?.sub ?? "";

  const supabase = await createServerClient();
  const { data } = await supabase
    .from("user_role_assignments")
    .select("id, clinic_id, roles(key, name)")
    .eq("organization_id", org.id)
    .eq("user_id", userId);

  // The embed's shape is declared here rather than inferred: the generated types
  // describe the RELATIONSHIP, not the shape of the embedded row.
  const assignments = (data ?? []) as unknown as AssignmentRow[];

  const activeClinicId = await readActiveClinicId();
  let activeClinicName: string | null = null;
  if (activeClinicId) {
    const { data: clinic } = await supabase
      .from("clinics")
      .select("name")
      .eq("id", activeClinicId)
      .maybeSingle();
    activeClinicName = clinic?.name ?? null;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.name}
        description="Your clinic workspace. Clinical records arrive in a later phase."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Your roles</h2>
        {assignments.length === 0 ? (
          <EmptyState
            title="No roles assigned yet"
            description="Nobody has given you a role in this organization, so there is nothing for you to do here yet."
          />
        ) : (
          <ul className="space-y-2">
            {assignments.map((assignment) => (
              <li
                key={assignment.id}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-sm"
              >
                <span className="font-medium text-foreground">
                  {assignment.roles?.name ?? "Unknown role"}
                </span>
                <span className="text-muted-foreground">
                  {assignment.clinic_id === null ? "All clinics" : "One clinic"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Clinical records</h2>
        <EmptyState
          title="No patients yet"
          description="Patient registration, appointments and encounters are not part of this release. Nothing here is a placeholder - there is genuinely no data yet."
        />
      </section>

      <p className="text-xs text-muted-foreground">
        Working in {activeClinicName ?? "all clinics"} &middot; {org.timezone} &middot;{" "}
        {org.currency}
      </p>
    </div>
  );
}
