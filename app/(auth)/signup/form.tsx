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
import { signupSchema, type SignupInput } from "@/lib/validation/auth";
import { signup } from "./actions";

export default function SignupPage() {
  const [formState, formAction, isPending] = useActionState(signup, null);

  const form = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      email: "",
      password: "",
      fullName: "",
    },
  });

  // The dispatch is not awaited for its result: it returns nothing, so awaiting it
  // resolved at once and the loading state was dead. `isPending` is the real signal.
  const onSubmit = form.handleSubmit(async (data) => {
    await formAction(data);
  });

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          <h1>Create your account</h1>
        </CardTitle>
        <CardDescription>Start managing your clinic with ClinicCore</CardDescription>
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

          <div className="space-y-2">
            <Label htmlFor="fullName">Full name (optional)</Label>
            <Input
              id="fullName"
              type="text"
              placeholder="Dr. Jane Smith"
              {...form.register("fullName")}
              disabled={isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
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

          {formState && (
            <div className="text-sm text-destructive" role="alert">
              {formState.body.error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col space-y-3">
        <p className="text-sm text-muted-foreground text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
