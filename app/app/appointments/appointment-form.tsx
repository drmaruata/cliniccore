"use client";

import { useActionState, startTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bookAppointment, setAppointmentStatus } from "./actions";
import type { AppointmentStatus } from "@/lib/validation/patients";

/**
 * Appointment forms: booking a new slot and moving an existing one through the status
 * graph.
 *
 * WHY THE TIME INPUT IS NOT A `datetime-local`. A `datetime-local` input posts
 * `YYYY-MM-DDTHH:MM` with no zone, which the server parser interprets in its ambient
 * time zone (typically UTC). Split inputs (`date` and `time`) keep the calendar day
 * and the clinic wall clock explicit, and `clinicWallTimeToInstant` applies the
 * clinic's configured timezone before booking.
 *
 * WHY THE STATUS LABELS ARE CAPITALISED IN TYPESCRIPT. PostgREST stores snake_case
 * identifiers (`checked_in`, `no_show`). Translating them here gives the combobox
 * natural English options without asking the database to store display copy.
 */
interface ClinicOption {
  id: string;
  name: string;
}

interface PatientOption {
  id: string;
  first_name: string | null;
  last_name: string | null;
  mrn: string;
}

export function AppointmentForm({
  clinics,
  patients,
  defaultClinicId,
  defaultDay,
}: {
  clinics: ClinicOption[];
  patients: PatientOption[];
  defaultClinicId: string;
  defaultDay: string;
}) {
  const [state, formAction, isPending] = useActionState(bookAppointment, null);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      formAction(formData);
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {state && !state.ok && (
        <div
          role="alert"
          className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {state.error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="appointment-patient">Patient</Label>
          <select
            id="appointment-patient"
            name="patientId"
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="" disabled selected>
              Select patient...
            </option>
            {patients.map((p) => {
              const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed";
              return (
                <option key={p.id} value={p.id}>
                  {name} ({p.mrn})
                </option>
              );
            })}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="appointment-clinic">Clinic</Label>
          <select
            id="appointment-clinic"
            name="clinicId"
            defaultValue={defaultClinicId}
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
          >
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="appointment-date">Date</Label>
          <Input id="appointment-date" name="date" type="date" defaultValue={defaultDay} required />
        </div>

        <div className="space-y-2">
          <Label htmlFor="appointment-time">Time</Label>
          <Input id="appointment-time" name="time" type="time" required />
        </div>

        <div className="space-y-2">
          <Label htmlFor="appointment-duration">Duration (minutes)</Label>
          <Input
            id="appointment-duration"
            name="durationMinutes"
            type="number"
            min={5}
            max={240}
            defaultValue={30}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="appointment-reason">Reason</Label>
        <Input
          id="appointment-reason"
          name="reason"
          type="text"
          placeholder="Consultation, follow-up, procedure..."
        />
      </div>

      <Button type="submit" disabled={isPending}>
        {isPending ? "Booking..." : "Book appointment"}
      </Button>
    </form>
  );
}

function statusOptionLabel(status: AppointmentStatus): string {
  switch (status) {
    case "checked_in":
      return "Checked in";
    case "no_show":
      return "No-show";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function AppointmentStatusForm({
  appointmentId,
  mrn,
  current: _current,
  transitions,
}: {
  appointmentId: string;
  mrn: string;
  current: AppointmentStatus;
  transitions: readonly AppointmentStatus[];
}) {
  const [state, formAction, isPending] = useActionState(setAppointmentStatus, null);

  if (transitions.length === 0) return null;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state && !state.ok && (
        <div role="alert" className="text-xs text-destructive">
          {state.error}
        </div>
      )}
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <div className="flex items-center gap-2">
        <select
          name="status"
          aria-label={`Status for ${mrn}`}
          defaultValue={transitions[0]}
          className="h-8 rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-xs focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
        >
          {transitions.map((status) => (
            <option key={status} value={status}>
              {statusOptionLabel(status)}
            </option>
          ))}
        </select>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={isPending}
        >
          {isPending ? "Updating..." : `Update status for ${mrn}`}
        </Button>
      </div>
    </form>
  );
}
