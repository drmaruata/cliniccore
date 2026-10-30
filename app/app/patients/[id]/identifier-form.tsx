"use client";

import { startTransition, useActionState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addIdentifier } from "../actions";

/**
 * The add-identifier form on the patient detail page.
 *
 * WHY THIS IS A CLIENT COMPONENT AND STILL DOES NOT TOUCH SUPABASE. `useActionState` and
 * `startTransition` are client hooks, but the insert happens inside the Server Action in
 * `../actions`; importing `lib/supabase/` here would ship the server client into the
 * browser bundle. The only server code this module names is the action reference.
 *
 * WHY THE SUBMIT IS WRAPPED IN `startTransition`. The registration form does the same: the
 * action call is a transition, so `isPending` covers the whole round trip instead of the
 * click being treated as an urgent update that settles before the server answers.
 *
 * WHY `canAdd === false` RENDERS NOTHING. The page decides who sees the control; the
 * action re-checks `patients.create` and RLS is the boundary. Hiding the form keeps a
 * viewer from being offered an action the database would refuse, and it is not itself a
 * security control.
 *
 * WHY THE PATIENT ID IS A HIDDEN FIELD. The action needs the parent row, and the id comes
 * from the server-rendered page rather than from the URL the browser could edit. The
 * action still verifies that the patient is in the active organization before inserting.
 */
interface IdentifierFormProps {
  patientId: string;
  canAdd: boolean;
}

export function IdentifierForm({ patientId, canAdd }: IdentifierFormProps) {
  const [state, formAction, isPending] = useActionState(addIdentifier, null);

  if (!canAdd) return null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      formAction(formData);
    });
  };

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="patientId" value={patientId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="identifier-kind">Kind</Label>
          <Input id="identifier-kind" name="kind" required disabled={isPending} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="identifier-value">Value</Label>
          <Input id="identifier-value" name="value" required disabled={isPending} />
        </div>
      </div>

      {state && !state.ok && (
        <div role="alert" className="text-sm text-destructive">
          {state.error}
        </div>
      )}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Adding identifier..." : "Add identifier"}
      </Button>
    </form>
  );
}
