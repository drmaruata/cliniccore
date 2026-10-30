"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { startTransition, useActionState, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { patientInputSchema } from "@/lib/validation/patients";
import { archivePatient, createPatient } from "../actions";

/**
 * The registration form and the per-row archive control.
 *
 * WHY THE OPTIONAL FIELDS ARE TRANSFORMED IN THE FORM TOO. The server normalises `""` to
 * `null` for a native FormData submit, but this form validates through the Task 4 schema
 * before it calls the action. `setValueAs` converts an untouched optional input to
 * `null` at the field boundary, so the schema stays strict rather than growing an
 * `or("")` branch that would then reach the database as an empty string.
 *
 * WHY THE ARCHIVE CONTROL LIVES HERE. It is the only other interactive control Task 5
 * adds, and a separate client module would be a fifth file for one button. The confirm
 * dialog is required because archiving changes what the active list shows, and the
 * button submits the form only after the dialog's confirm is pressed - the row's own
 * button opens the dialog and never submits on its own.
 *
 * WHY THE ARCHIVE FORM POSTS `reasonCode: "OTHER"`. `archiveInputSchema` requires one of
 * the five recorded reasons; the list has no room for a reason picker, and the row is
 * archived as an explicit "other" rather than inventing a clinical cause.
 */
const emptyToNull = (value: unknown): unknown => (value === "" ? null : value);

type PatientFormValues = z.input<typeof patientInputSchema>;

export function PatientForm({ clinics }: { clinics: { id: string; name: string }[] }) {
  const [formState, formAction, isPending] = useActionState(createPatient, null);

  const form = useForm<PatientFormValues>({
    resolver: zodResolver(patientInputSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      dateOfBirth: null,
      sex: null,
      phone: null,
      email: null,
      clinicId: clinics[0]?.id ?? "",
      identifiers: [],
    },
  });

  const onSubmit = form.handleSubmit((data) => {
    startTransition(() => {
      formAction(data);
    });
  });

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <form action={formAction} onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="patient-first-name">First name</Label>
            <Input
              id="patient-first-name"
              autoComplete="given-name"
              {...form.register("firstName")}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.firstName}
              aria-describedby={
                form.formState.errors.firstName ? "patient-first-name-error" : undefined
              }
            />
            {form.formState.errors.firstName && (
              <p id="patient-first-name-error" className="text-sm text-destructive">
                {form.formState.errors.firstName.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="patient-last-name">Last name</Label>
            <Input
              id="patient-last-name"
              autoComplete="family-name"
              {...form.register("lastName")}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.lastName}
              aria-describedby={
                form.formState.errors.lastName ? "patient-last-name-error" : undefined
              }
            />
            {form.formState.errors.lastName && (
              <p id="patient-last-name-error" className="text-sm text-destructive">
                {form.formState.errors.lastName.message}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="patient-date-of-birth">Date of birth</Label>
            <Input
              id="patient-date-of-birth"
              type="date"
              {...form.register("dateOfBirth", { setValueAs: emptyToNull })}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.dateOfBirth}
            />
            {form.formState.errors.dateOfBirth && (
              <p className="text-sm text-destructive">
                {form.formState.errors.dateOfBirth.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="patient-sex">Sex</Label>
            <select
              id="patient-sex"
              {...form.register("sex", { setValueAs: emptyToNull })}
              disabled={isPending}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="">Not recorded</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="patient-phone">Phone</Label>
            <Input
              id="patient-phone"
              type="tel"
              autoComplete="tel"
              {...form.register("phone", { setValueAs: emptyToNull })}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.phone}
            />
            {form.formState.errors.phone && (
              <p className="text-sm text-destructive">{form.formState.errors.phone.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="patient-email">Email</Label>
            <Input
              id="patient-email"
              type="email"
              autoComplete="email"
              {...form.register("email", { setValueAs: emptyToNull })}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.email}
              aria-describedby={form.formState.errors.email ? "patient-email-error" : undefined}
            />
            {form.formState.errors.email && (
              <p id="patient-email-error" className="text-sm text-destructive">
                {form.formState.errors.email.message}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="patient-clinic">Clinic</Label>
          <select
            id="patient-clinic"
            {...form.register("clinicId")}
            disabled={isPending}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            {clinics.map((clinic) => (
              <option key={clinic.id} value={clinic.id}>
                {clinic.name}
              </option>
            ))}
          </select>
          {form.formState.errors.clinicId && (
            <p className="text-sm text-destructive">{form.formState.errors.clinicId.message}</p>
          )}
        </div>

        {formState && !formState.ok && (
          <div role="alert" className="text-sm text-destructive">
            {formState.error}
          </div>
        )}

        <Button type="submit" disabled={isPending}>
          {isPending ? "Registering patient..." : "Register patient"}
        </Button>
      </form>
    </section>
  );
}

export function ArchivePatientButton({ patientId, mrn }: { patientId: string; mrn: string }) {
  const [open, setOpen] = useState(false);
  const [formState, formAction, isPending] = useActionState(archivePatient, null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);

  return (
    <div>
      <form
        ref={formRef}
        action={formAction}
        onSubmit={(event) => {
          if (!confirmed.current) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <input type="hidden" name="patientId" value={patientId} />
        <input type="hidden" name="reasonCode" value="OTHER" />
        <Button type="submit" variant="outline" size="sm" disabled={isPending}>
          Archive {mrn}
        </Button>
      </form>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) confirmed.current = false;
          setOpen(next);
        }}
        title={`Archive ${mrn}?`}
        description={
          <>
            The patient leaves the active list. The record and its history are kept, and remain
            available under archived patients.
            {formState && !formState.ok && (
              <span role="alert" className="mt-2 block text-sm text-destructive">
                {formState.error}
              </span>
            )}
          </>
        }
        confirmLabel="Confirm archive"
        tone="destructive"
        onConfirm={() => {
          confirmed.current = true;
          formRef.current?.requestSubmit();
        }}
      />
    </div>
  );
}
