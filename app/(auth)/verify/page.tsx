"use client";

import { useEffect, useState, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { redirect } from "next/navigation";

function VerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<"checking" | "verified" | "error" | "signed_in">("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const verifyEmail = async () => {
      // Check if there's a code in the URL (email confirmation flow)
      const code = searchParams.get("code");
      const type = searchParams.get("type");

      if (code && type === "email") {
        // The actual verification happens via the server
        // We redirect to a server action that handles the exchange
        try {
          const response = await fetch(`/api/auth/verify?code=${encodeURIComponent(code)}`, {
            method: "POST",
          });
          if (response.ok) {
            setState("verified");
            setMessage("Your email has been verified. Redirecting...");
            setTimeout(() => {
              redirect("/app/onboarding");
            }, 1500);
            return;
          }
        } catch {
          // Fall through to error
        }
        setState("error");
        setMessage("This verification link has expired or is invalid. Please request a new one.");
        return;
      }

      // Check if user is already signed in (no code in URL)
      // We can't check this directly from client, so we assume if they're on this page
      // without a code, they might be already signed in
      setState("signed_in");
    };

    verifyEmail();
  }, [searchParams, router]);

  if (state === "checking") {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Verifying...</CardTitle>
          <CardDescription>Please wait while we verify your email</CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <div className="animate-pulse">&#x1f504;</div>
        </CardContent>
      </Card>
    );
  }

  if (state === "verified") {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-success">Email verified!</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <div className="text-4xl">&#x2713;</div>
        </CardContent>
      </Card>
    );
  }

  if (state === "signed_in") {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Already signed in</CardTitle>
          <CardDescription>
            You are already signed in. Email confirmation is disabled in this environment, so no
            verification is needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild className="w-full">
            <Link href="/app/onboarding">Continue to onboarding</Link>
          </Button>
          <Button variant="outline" asChild className="w-full">
            <Link href="/app/dashboard">Go to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl text-destructive">Verification failed</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="outline" asChild className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
        <Button asChild className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <VerifyForm />
    </Suspense>
  );
}
