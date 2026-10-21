"use client";

import { useState, useEffect, Suspense } from "react";
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
import { useSearchParams } from "next/navigation";
import { resetPasswordSchema } from "@/lib/validation/auth";
import { resetPassword } from "./actions";

type ResetPasswordInput = {
  password: string;
  confirmPassword: string;
};

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const [formState, formAction] = useActionState(resetPassword, null);
  const [isLoading, setIsLoading] = useState(false);
  const [tokenValid, setTokenValid] = useState(true);

  // Verify the token by checking if we can get the user
  useEffect(() => {
    // The actual verification happens in the server action
    // We just check if there's a code in the URL
    const code = searchParams.get("code");
    if (!code) {
      // Use a timeout to avoid calling setState synchronously in the effect
      setTimeout(() => setTokenValid(false), 0);
    }
  }, [searchParams]);

  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(
      resetPasswordSchema.extend({
        confirmPassword: resetPasswordSchema.shape.password,
      }),
    ),
    defaultValues: {
      password: "",
      confirmPassword: "",
    },
  });

  const onSubmit = form.handleSubmit(async (data) => {
    setIsLoading(true);
    await formAction(data);
    setIsLoading(false);
  });

  if (!tokenValid) {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-destructive">Invalid or expired link</CardTitle>
          <CardDescription>
            This password reset link has expired or has already been used.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <Button variant="outline" asChild>
            <Link href="/forgot-password">Request a new reset link</Link>
          </Button>
          <Button asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Reset your password</CardTitle>
        <CardDescription>Enter your new password below</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
              {...form.register("password")}
              disabled={isLoading}
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
              placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
              {...form.register("confirmPassword")}
              disabled={isLoading}
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

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Resetting..." : "Reset password"}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
