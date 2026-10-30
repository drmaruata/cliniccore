import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { readActiveClinicId } from "@/lib/auth/session";
import { listDayAppointments } from "@/lib/clinical/queries";
import { listPatients } from "@/lib/patients/queries";
import { createServerClient } from "@/lib/supabase/server";
import {
  clinicDayBoundsForDay,
  formatInClinicTz,
} from "@/lib/utils/datetime";
import {
  APPOINTMENT_STATUS_TRANSITIONS,
  type AppointmentStatus,
} from "@/lib/validation/patients";
import { AppointmentForm, AppointmentStatusForm } from "./appointment-form";

/**
 * Appointments day view: schedule for a single clinic-local calendar day.
 *
 * WHY THE DAY PARAMETER IS VALIDATED AGAINST `clinicDayBoundsForDay`. A string like
 * `?day=2026-11-31` is not a calendar date, and a day that does not exist in the clinic's
 * zone (e.g. Pacific/Apia skipping 2011-12-30) has no window. Catching `RangeError` turns
 * an invalid query string into "today", keeping the view visible.
 *
 * WHY DAY ARITHMETIC USES UTC. The `day` query parameter is a calendar label (`YYYY-MM-DD`),
 * not an instant. Adding 86 400 000 ms via `Date.UTC` computes the next calendar date on
 * the label alone, independent of the clinic or browser zone, which is what the prev/next
 * links need.
 */
interface AppointmentsPageProps {
  searchParams: Promise<{ day?: string | string[] }>;
}

function resolveDay(raw: string | string[] | undefined, timezone: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try {
      clinicDayBoundsForDay(value, timezone);
      return value;
    } catch {
      // Fall back to today below when the day string is invalid in this zone.
    }
  }
  return formatInClinicTz(new Date().toISOString(), timezone);
}

function shiftDayLabel(dayLabel: string, days: number): string {
  const [y, m, d] = dayLabel.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function formatTime(iso: string, timezone: string, locale: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function statusBadgeVariant(status: AppointmentStatus) {
  switch (status) {
    case "completed":
      return "default";
    case "confirmed":
    case "checked_in":
      return "secondary";
    case "cancelled":
    case "no_show":
      return "destructive";
    default:
      return "outline";
  }
}

export default async function AppointmentsPage({ searchParams }: AppointmentsPageProps) {
  const org = await getActiveOrg();
  if (!org) return null;

  const params = await searchParams;
  const day = resolveDay(params.day, org.timezone);
  const todayLabel = formatInClinicTz(new Date().toISOString(), org.timezone);

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
        <PageHeader
          title="Appointments"
          description="Schedule and track clinic appointments."
        />
        <EmptyState
          title="No clinic yet"
          description="Your organization needs at least one clinic before booking appointments."
        />
      </div>
    );
  }

  const activeClinicId = await readActiveClinicId();
  const selectedClinic = clinics.find((c) => c.id === activeClinicId) ?? clinics[0];
  const clinicId = selectedClinic.id;

  const canBook = await userCan("appointments.manage", clinicId);

  const [appointments, patients] = await Promise.all([
    listDayAppointments({ clinicId, day }),
    canBook ? listPatients() : Promise.resolve([]),
  ]);

  const prevDay = shiftDayLabel(day, -1);
  const nextDay = shiftDayLabel(day, 1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appointments"
        description={`Showing ${selectedClinic.name} for ${day} (${org.timezone}). View does not auto-refresh.`}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/app/appointments?day=${prevDay}`}>Previous day</Link>
          </Button>
          <Button asChild variant={day === todayLabel ? "default" : "outline"} size="sm">
            <Link href={`/app/appointments?day=${todayLabel}`}>Today</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/app/appointments?day=${nextDay}`}>Next day</Link>
          </Button>
        </div>
        <p className="text-sm font-medium text-foreground">{day}</p>
      </div>

      {appointments.length === 0 ? (
        <EmptyState
          title="No appointments on this day"
          description={`No appointments are scheduled for ${selectedClinic.name} on ${day}.`}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Patient</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reason</TableHead>
              {canBook && <TableHead>Update status</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {appointments.map(({ appointment, patient }) => {
              const timeStr = formatTime(
                appointment.scheduled_start,
                org.timezone,
                org.locale,
              );
              const patientName = patient
                ? [patient.first_name, patient.last_name].filter(Boolean).join(" ") || "Unnamed"
                : "Unknown patient";
              const currentStatus = appointment.status as AppointmentStatus;
              const transitions = APPOINTMENT_STATUS_TRANSITIONS[currentStatus] ?? [];

              return (
                <TableRow key={appointment.id}>
                  <TableCell className="font-mono text-xs">{timeStr}</TableCell>
                  <TableCell>
                    {patient ? (
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">{patientName}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {patient.mrn}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{patientName}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(currentStatus)}>
                      {currentStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>{appointment.reason ?? "—"}</TableCell>
                  {canBook && (
                    <TableCell>
                      <AppointmentStatusForm
                        appointmentId={appointment.id}
                        mrn={patient?.mrn ?? "patient"}
                        current={currentStatus}
                        transitions={transitions}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {canBook && (
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h2 className="font-heading text-lg font-semibold text-brand-navy">
            Book appointment
          </h2>
          <AppointmentForm
            clinics={clinics}
            patients={patients.map((p) => ({
              id: p.id,
              first_name: p.first_name,
              last_name: p.last_name,
              mrn: p.mrn,
            }))}
            defaultClinicId={clinicId}
            defaultDay={day}
          />
        </div>
      )}
    </div>
  );
}