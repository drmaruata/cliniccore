"use client";

import { useActionState, startTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { addToQueue, setQueueStatus } from "./actions";
import type { QueueStatus } from "@/lib/validation/patients";

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

export function AddToQueueForm({
  clinics,
  patients,
  defaultClinicId,
}: {
  clinics: ClinicOption[];
  patients: PatientOption[];
  defaultClinicId: string;
}) {
  const [state, formAction, isPending] = useActionState(addToQueue, null);

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
          <Label htmlFor="queue-patient">Patient</Label>
          <select
            id="queue-patient"
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
          <Label htmlFor="queue-clinic">Clinic</Label>
          <select
            id="queue-clinic"
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

      <Button type="submit" disabled={isPending}>
        {isPending ? "Adding..." : "Add to queue"}
      </Button>
    </form>
  );
}

function statusActionLabel(status: QueueStatus): string {
  switch (status) {
    case "called":
      return "Call";
    case "in_consultation":
      return "Start Consultation";
    case "completed":
      return "Complete";
    case "skipped":
      return "Skip";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function QueueActionForm({
  entryId,
  targetStatus,
  mrn,
}: {
  entryId: string;
  targetStatus: QueueStatus;
  mrn: string;
}) {
  const [state, formAction, isPending] = useActionState(setQueueStatus, null);

  return (
    <form action={formAction}>
      {state && !state.ok && (
        <div role="alert" className="text-xs text-destructive mt-1">
          {state.error}
        </div>
      )}
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="status" value={targetStatus} />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        className="h-8 text-xs"
        disabled={isPending}
        aria-label={`${statusActionLabel(targetStatus)} for ${mrn}`}
      >
        {isPending ? "..." : statusActionLabel(targetStatus)}
      </Button>
    </form>
  );
}
