"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { resetPasswordFormSchema } from "@/lib/validation/auth";
import { resetPassword } from "./actions";

/**
 * The new-password form.
 *
 * THE PAGE HAS ALREADY CHECKED THE SESSION. `updateUser` needs a signed-in user, and
 * the recovery session is established by the code exchange in the route handler. So the
 * page decides whether this form is shown at all, and the form does not re-check.
 *
 * THE CONFIRMATION MATCH IS IN THE SHARED SCHEMA, so the client and the server agree.
 */
export default function ResetPasswordForm() {
  const [formState, formAction, isPending] = useActionState(resetPassword, null);

  const form = useForm({
    resolver: zodResolver(resetPasswordFormSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = form.handleSubmit(async (data) => {
    await formAction(data);
  });

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          <h1>Reset your password</h1>
        </CardTitle>
        <CardDescription>Enter your new password below</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} method="post" onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...form.register("password")}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.password}
            />
            {form.formState.errors.password && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.password.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...form.register("confirmPassword")}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.confirmPassword}
            />
            {form.formState.errors.confirmPassword && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.confirmPassword.message}
              </p>
            )}
          </div>

          {formState && (
            <div className="text-sm text-destructive" role="alert">
              {formState.body.error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Resetting..." : "Reset password"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col space-y-3">
        <p className="text-sm text-muted-foreground text-center">
          <Link href="/login" className="text-primary hover:underline font-medium">
            Back to sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
