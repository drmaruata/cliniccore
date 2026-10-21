"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganizationSchema, type CreateOrganizationInput } from "@/lib/validation/auth";
import { createOrganization } from "./actions";

/**
 * The onboarding form: the organization, its first clinic, and the caller's ownership.
 *
 * WHY THE TIME ZONE IS A FIELD AND NOT A FIXED VALUE. A clinic's time zone decides
 * which day a record belongs to, and the billing day is computed in it, so it is the
 * tenant's to choose. It is a text field because the canonical set of IANA names is
 * long and version-dependent; the database refuses an unknown one, and the server
 * action turns that refusal into a sentence the user can act on.
 */
export function OnboardingForm() {
  const [formState, formAction, isPending] = useActionState(createOrganization, null);

  const form = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      name: "",
      slug: "",
      timezone: "Asia/Kolkata",
      currency: "INR",
      locale: "en-IN",
    },
  });

  // INSIDE A TRANSITION, WHICH IS NOT OPTIONAL: dispatched outside one, `isPending`
  // never becomes true, so the button never disables and a double click fires two
  // server actions.
  const onSubmit = form.handleSubmit((data) => {
    startTransition(() => {
      formAction(data);
    });
  });

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Organization name</Label>
        <Input
          id="name"
          autoComplete="organization"
          placeholder="Northside Family Clinic"
          {...form.register("name")}
          disabled={isPending}
          aria-invalid={!!form.formState.errors.name}
          aria-describedby={form.formState.errors.name ? "name-error" : undefined}
        />
        {form.formState.errors.name && (
          <p id="name-error" className="text-sm text-destructive">
            {form.formState.errors.name.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">Clinic address</Label>
        <Input
          id="slug"
          autoComplete="off"
          placeholder="northside-clinic"
          {...form.register("slug")}
          disabled={isPending}
          aria-invalid={!!form.formState.errors.slug}
          aria-describedby={form.formState.errors.slug ? "slug-error" : "slug-hint"}
        />
        {form.formState.errors.slug ? (
          <p id="slug-error" className="text-sm text-destructive">
            {form.formState.errors.slug.message}
          </p>
        ) : (
          <p id="slug-hint" className="text-xs text-muted-foreground">
            Lowercase letters, numbers and single hyphens. This identifies your clinic and cannot be
            changed to an existing one.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="timezone">Time zone</Label>
          <Input
            id="timezone"
            autoComplete="off"
            {...form.register("timezone")}
            disabled={isPending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Input
            id="currency"
            autoComplete="off"
            {...form.register("currency")}
            disabled={isPending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="locale">Locale</Label>
          <Input id="locale" autoComplete="off" {...form.register("locale")} disabled={isPending} />
        </div>
      </div>

      {formState && formState.body.error && (
        <div role="alert" className="text-sm text-destructive">
          {formState.body.error}
        </div>
      )}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating..." : "Create organization"}
      </Button>
    </form>
  );
}
