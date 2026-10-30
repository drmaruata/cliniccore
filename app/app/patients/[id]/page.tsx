import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { userCan } from "@/lib/auth/active-org";
import { getPatientDetail } from "@/lib/patients/queries";
import { IdentifierForm } from "./identifier-form";

/**
 * One patient's record: demographics, identifiers, appointments and encounters.
 *
 * WHY THE PAGE DOES NOT FILTER BY TENANT ITSELF. `getPatientDetail` owns the explicit
 * organization filter and the parent-id filter, and RLS is the boundary behind it. A
 * page that repeated either would be a second place for the filter to be dropped.
 *
 * WHY A MISSING ID AND ANOTHER TENANT'S ID LOOK THE SAME. Both resolve to `null` from the
 * data layer, and both call `notFound()`. Distinguishing them would confirm that a record
 * exists in some other tenant, which is exactly what the tenant boundary exists to hide.
 *
 * WHY THE IDENTIFIER FORM IS GATED BY `patients.create`. `userCan` is advisory - the
 * action re-checks the permission and RLS is the real boundary - but a viewer should not
 * be offered a control the database will refuse. The gate is the patient's own clinic,
 * because that is the clinic the identifier insert policy checks.
 *
 * WHY THE ENCOUNTER LINK MAY 404. The detail route lands in Task 9; the link is rendered
 * now so the row is navigable the moment that route exists, and a 404 until then is the
 * honest behaviour of a link to a page that is not built yet.
 *
 * WHY THE MRN IS IN THE HEADER AND NOT THE URL. A record number is an identifier, not a
 * route key: the URL carries the opaque patient id, and the MRN is shown to the reader.
 */
interface PatientDetailPageProps {
  params: Promise<{ id: string }>;
}

function patientName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter(Boolean).join(" ") || "Unnamed patient";
}

function formatDay(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function formatInstant(value: string): string {
  return `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function PatientDetailPage({ params }: PatientDetailPageProps) {
  const { id } = await params;
  const detail = await getPatientDetail(id);
  if (!detail) notFound();

  const { patient, identifiers, appointments, encounters } = detail;
  const canAdd = await userCan("patients.create", patient.clinic_id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={patientName(patient.first_name, patient.last_name)}
        description={patient.mrn}
      />

      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Demographics</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Record number</dt>
            <dd className="font-mono text-xs text-foreground">{patient.mrn}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Date of birth</dt>
            <dd className="text-sm text-foreground">{patient.date_of_birth ?? "—"}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Sex</dt>
            <dd className="text-sm text-foreground">{patient.sex ?? "—"}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Phone</dt>
            <dd className="text-sm text-foreground">{patient.phone ?? "—"}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Email</dt>
            <dd className="text-sm text-foreground">{patient.email ?? "—"}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Clinic</dt>
            <dd className="font-mono text-xs text-foreground">{patient.clinic_id}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Identifiers</h2>
        {identifiers.length === 0 ? (
          <EmptyState
            title="No identifiers yet"
            description="External identifiers such as a national id appear here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identifiers.map((identifier) => (
                <TableRow key={identifier.id}>
                  <TableCell>{identifier.kind}</TableCell>
                  <TableCell className="font-mono text-xs">{identifier.value}</TableCell>
                  <TableCell>{formatDay(identifier.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <IdentifierForm patientId={patient.id} canAdd={canAdd} />
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Appointments</h2>
        {appointments.length === 0 ? (
          <EmptyState
            title="No appointments yet"
            description="Appointments booked for this patient appear here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduled start</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.map((appointment) => (
                <TableRow key={appointment.id}>
                  <TableCell>{formatInstant(appointment.scheduled_start)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{appointment.status}</Badge>
                  </TableCell>
                  <TableCell>{appointment.reason ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Encounters</h2>
        {encounters.length === 0 ? (
          <EmptyState
            title="No encounters yet"
            description="Clinical encounters for this patient appear here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started at</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Finalized at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {encounters.map((encounter) => (
                <TableRow key={encounter.id}>
                  <TableCell>
                    <Link
                      href={`/app/encounters/${encounter.id}`}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {formatInstant(encounter.started_at)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{encounter.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {encounter.finalized_at === null ? "—" : formatInstant(encounter.finalized_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
