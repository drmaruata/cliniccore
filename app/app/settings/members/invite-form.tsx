"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { invitationSchema, type InvitationInput } from "@/lib/validation/invitations";
import { createInvitation } from "./actions";

/**
 * The owner-facing invite form.
 *
 * WHY THE ROLES ARE A PROP. The list of roles the caller may grant is the DATABASE's
 * answer (`public.grantable_roles`), not a constant in the client - it depends on the
 * caller's own permissions, and the grant ceiling is not something a browser can be
 * trusted to enforce.
 *
 * WHY THE LINK IS SHOWN AND NOT EMAILED. Email delivery is not implemented: this
 * release has no mail provider, and a form that says "we have emailed them" when
 * nothing was sent is worse than one that says nothing. So the link is displayed for
 * the owner to share, and the absence of delivery is recorded as BLOCKED rather than
 * described as a working notification.
 */
export function InviteForm({ roles }: { roles: { key: string; name: string }[] }) {
  const [formState, formAction, isPending] = useActionState(createInvitation, null);

  const form = useForm<InvitationInput>({
    resolver: zodResolver(invitationSchema),
    defaultValues: {
      email: "",
      roleKey: roles[0]?.key ?? "",
    },
  });

  const onSubmit = form.handleSubmit((data) => {
    startTransition(() => {
      formAction(data);
    });
  });

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">Invite a colleague</h2>
        <p className="text-sm text-muted-foreground">
          They join with the role you choose. You will get a link to share with them.
        </p>
      </div>

      <form action={formAction} onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            autoComplete="off"
            placeholder="newdoc@example.com"
            {...form.register("email")}
            disabled={isPending}
            aria-invalid={!!form.formState.errors.email}
            aria-describedby={form.formState.errors.email ? "invite-email-error" : undefined}
          />
          {form.formState.errors.email && (
            <p id="invite-email-error" className="text-sm text-destructive">
              {form.formState.errors.email.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            {...form.register("roleKey")}
            disabled={isPending}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            {roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.name}
              </option>
            ))}
          </select>
        </div>

        {formState && !formState.ok && (
          <div role="alert" className="text-sm text-destructive">
            {formState.error}
          </div>
        )}

        {formState && formState.ok && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
            <p className="text-sm text-foreground">
              Invitation created for {formState.value.email}. Share this link with them:
            </p>
            <p className="break-all font-mono text-xs text-foreground">
              {formState.value.inviteUrl}
            </p>
            <p className="text-xs text-muted-foreground">
              ClinicCore does not send invitation emails yet. Copy the link and send it yourself.
            </p>
          </div>
        )}

        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating invitation..." : "Create invitation"}
        </Button>
      </form>
    </section>
  );
}
