import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUser } from "@/lib/supabase/server";

import ResetPasswordForm from "./form";

export const metadata: Metadata = {
  title: "Choose a new password | ClinicCore",
  description: "Set a new password for your ClinicCore account",
};

/**
 * The new-password route.
 *
 * THE SESSION IS THE PRECONDITION, AND IT IS CHECKED HERE. The recovery session is
 * established by the code exchange in `app/api/auth/verify/route.ts` - a route handler,
 * because a Server Component cannot set cookies. If there is no session, the link was
 * expired, already used, or never valid, and the honest answer is that the link does
 * not work - not a form that submits and then fails.
 */
export default async function ResetPasswordPage() {
  const user = await getUser();

  if (!user) {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-destructive">
            <h1>Invalid or expired link</h1>
          </CardTitle>
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

  return <ResetPasswordForm />;
}
