"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ChangeEvent } from "react";

import { switchClinic } from "@/app/app/actions";

/**
 * The clinic switcher: the clinics of the active organization the user can REACH.
 *
 * THE LIST IS A REACH LIST, NOT A LIST OF THE TENANT'S CLINICS. The `clinics` SELECT
 * policy is `current_org_ids()` AND `clinic_ids(organization_id)`, so a membership
 * scoped to one clinic sees one clinic here and a membership with no clinic scoping
 * sees them all. The switcher cannot widen that, because it renders what the query
 * returned and the query is the policy.
 *
 * WHY SWITCHING IS A SERVER ACTION. The action re-checks the clinic under the same
 * policy before writing the cookie, so the cookie can never come to name a clinic the
 * user cannot read - and the cookie is re-validated on every read anyway, because a
 * cookie is a hint and never evidence.
 */

export interface ClinicOption {
  id: string;
  name: string;
}

export function ClinicSwitcher({
  clinics,
  activeClinicId,
}: {
  clinics: ClinicOption[];
  /** The chosen clinic, or null when none has been chosen. */
  activeClinicId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const clinicId = event.target.value;
    if (clinicId === "") return;
    setError(null);
    startTransition(async () => {
      const result = await switchClinic(clinicId);
      if (result) {
        setError(result.body.error);
        return;
      }
      router.refresh();
    });
  }

  if (clinics.length === 0) return null;

  return (
    <div className="space-y-1">
      <label htmlFor="cc-clinic-switcher" className="text-xs font-medium text-muted-foreground">
        Clinic
      </label>
      <select
        id="cc-clinic-switcher"
        value={activeClinicId ?? ""}
        onChange={onChange}
        disabled={isPending}
        className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
      >
        <option value="">All clinics</option>
        {clinics.map((clinic) => (
          <option key={clinic.id} value={clinic.id}>
            {clinic.name}
          </option>
        ))}
      </select>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
