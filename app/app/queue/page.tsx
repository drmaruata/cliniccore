import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { readActiveClinicId } from "@/lib/auth/session";
import { listQueue } from "@/lib/clinical/queries";
import { listPatients } from "@/lib/patients/queries";
import { createServerClient } from "@/lib/supabase/server";
import { QUEUE_STATUS_TRANSITIONS, type QueueStatus } from "@/lib/validation/patients";
import { QueueActionForm, AddToQueueForm } from "./queue-form";

/**
 * Queue board: patient queue separated into columns by status.
 *
 * WHY THE VIEW DOES NOT AUTO-REFRESH. Real-time subscriptions are deferred to Phase 8.
 * The page description explicitly informs the user that manual page refreshes or action
 * triggers update the board.
 */
export default async function QueuePage() {
  const org = await getActiveOrg();
  if (!org) return null;

  const supabase = await createServerClient();
  const { data: clinicRows } = await supabase
    .from("clinics")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name");

  const clinics = (clinicRows ?? []).map((c) => ({ id: c.id, name: c.name }));

  if (clinics.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Queue" description="Clinic patient queue board." />
        <EmptyState
          title="No clinic yet"
          description="Your organization needs at least one clinic before using the queue."
        />
      </div>
    );
  }

  const activeClinicId = await readActiveClinicId();
  const selectedClinic = clinics.find((c) => c.id === activeClinicId) ?? clinics[0]!;
  const clinicId = selectedClinic.id;

  const canManage = await userCan("appointments.manage", clinicId);

  const [queueEntries, patients] = await Promise.all([
    listQueue(clinicId),
    canManage ? listPatients() : Promise.resolve([]),
  ]);

  const waiting = queueEntries.filter((q) => q.entry.status === "waiting");
  const called = queueEntries.filter((q) => q.entry.status === "called");
  const inConsultation = queueEntries.filter((q) => q.entry.status === "in_consultation");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Queue"
        description={`Live patient queue for ${selectedClinic.name}. View does not auto-refresh.`}
      />

      {canManage && (
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h2 className="font-heading text-lg font-semibold text-brand-navy">
            Add patient to queue
          </h2>
          <AddToQueueForm
            clinics={clinics}
            patients={patients.map((p) => ({
              id: p.id,
              first_name: p.first_name,
              last_name: p.last_name,
              mrn: p.mrn,
            }))}
            defaultClinicId={clinicId}
          />
        </div>
      )}

      {queueEntries.length === 0 ? (
        <EmptyState
          title="Queue is empty"
          description={`No patients are currently waiting or in consultation at ${selectedClinic.name}.`}
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-3">
          {/* Waiting Column */}
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-heading font-semibold text-foreground">Waiting</h3>
              <Badge variant="outline">{waiting.length}</Badge>
            </div>
            {waiting.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No patients waiting</p>
            ) : (
              <div className="space-y-3">
                {waiting.map(({ entry, patient }) => (
                  <QueueCard key={entry.id} entry={entry} patient={patient} canManage={canManage} />
                ))}
              </div>
            )}
          </div>

          {/* Called Column */}
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-heading font-semibold text-foreground">Called</h3>
              <Badge variant="secondary">{called.length}</Badge>
            </div>
            {called.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No patients called</p>
            ) : (
              <div className="space-y-3">
                {called.map(({ entry, patient }) => (
                  <QueueCard key={entry.id} entry={entry} patient={patient} canManage={canManage} />
                ))}
              </div>
            )}
          </div>

          {/* In Consultation Column */}
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-heading font-semibold text-foreground">In Consultation</h3>
              <Badge variant="default">{inConsultation.length}</Badge>
            </div>
            {inConsultation.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No active consultations
              </p>
            ) : (
              <div className="space-y-3">
                {inConsultation.map(({ entry, patient }) => (
                  <QueueCard key={entry.id} entry={entry} patient={patient} canManage={canManage} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QueueCard({
  entry,
  patient,
  canManage,
}: {
  entry: { id: string; status: string };
  patient: { first_name: string | null; last_name: string | null; mrn: string } | null;
  canManage: boolean;
}) {
  const patientName = patient
    ? [patient.first_name, patient.last_name].filter(Boolean).join(" ") || "Unnamed"
    : "Unknown patient";
  const mrn = patient?.mrn ?? "patient";
  const currentStatus = entry.status as QueueStatus;
  const transitions = QUEUE_STATUS_TRANSITIONS[currentStatus] ?? [];

  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-3 shadow-xs">
      <div>
        <p className="font-medium text-foreground">{patientName}</p>
        <p className="font-mono text-xs text-muted-foreground">{mrn}</p>
      </div>

      {canManage && transitions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
          {transitions.map((nextStatus) => (
            <QueueActionForm
              key={nextStatus}
              entryId={entry.id}
              targetStatus={nextStatus}
              mrn={mrn}
            />
          ))}
        </div>
      )}
    </div>
  );
}
