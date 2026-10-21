"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { useActionState } from "react";
import { forgotPasswordSchema } from "@/lib/validation/auth";
import { forgotPassword } from "./actions";

export default function ForgotPasswordPage() {
  const [formState, formAction, isPending] = useActionState(forgotPassword, null);

  const form = useForm<{ email: string }>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: {
      email: "",
    },
  });

  // The dispatch is not awaited for its result: it returns nothing, so awaiting it
  // resolved at once and the loading state was dead. `isPending` is the real signal.
  const onSubmit = form.handleSubmit(async (data) => {
    await formAction(data);
  });

  // Show success state when formState has status 200
  const isSuccess = formState?.status === 200;

  if (isSuccess) {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>Check your email</h1>
          </CardTitle>
          <CardDescription>
            If an account exists for that email, you will receive a password reset link shortly.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-sm text-muted-foreground mb-4">
            Didn&apos;t receive an email? Check your spam folder or{" "}
            <Link href="/forgot-password" className="text-primary hover:underline">
              try again
            </Link>
          </p>
          <Button variant="ghost" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          <h1>Forgot password?</h1>
        </CardTitle>
        <CardDescription>Enter your email and we&apos;ll send you a reset link</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} method="post" onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@clinic.com"
              {...form.register("email")}
              disabled={isPending}
              aria-invalid={!!form.formState.errors.email}
            />
            {form.formState.errors.email && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.email.message}
              </p>
            )}
          </div>

          {formState && formState.status !== 200 && (
            <div className="text-sm text-destructive" role="alert">
              {formState.body.error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Sending..." : "Send reset link"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col space-y-3">
        <p className="text-sm text-muted-foreground text-center">
          Remember your password?{" "}
          <Link href="/login" className="text-primary hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
