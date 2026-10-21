import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUser } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Verify your email | ClinicCore",
  description: "Check the status of your ClinicCore account",
};

/**
 * The verification route.
 *
 * WHY IT DETECTS THE SESSION INSTEAD OF GUESSING. The brief asks for the
 * already-signed-in case to be detected, and a "use client" page cannot: it has no
 * session. A previous version of this file said so in a comment and then showed
 * "Already signed in" to EVERYONE - a signed-out visitor was told they were signed in.
 * So the page is a Server Component and asks.
 *
 * WHY THERE IS NO EXCHANGE UI HERE. Email confirmation is DISABLED in this
 * environment, so no confirmation link is ever sent and there is nothing to exchange.
 * The exchange itself lives in `app/api/auth/verify/route.ts` for the deployments that
 * do have confirmation switched on.
 */
export default async function VerifyPage() {
  // `getUser()` is a call to the auth server, so it can fail - and a failure
  // there is not the same as "signed out". A blip answers the third thing, and the user
  // is told to try again rather than being shown a page that claims they are a
  // stranger.
  let session: "signed_in" | "signed_out" | "unavailable" = "signed_out";
  try {
    session = (await getUser()) ? "signed_in" : "signed_out";
  } catch {
    session = "unavailable";
  }

  if (session === "unavailable") {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>We could not check your session</h1>
          </CardTitle>
          <CardDescription>Please try again in a moment.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild className="w-full">
            <Link href="/verify">Try again</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (session === "signed_in") {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>Already signed in</h1>
          </CardTitle>
          <CardDescription>
            Email confirmation is disabled in this environment, so no verification is needed.
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
        <CardTitle className="text-2xl">
          <h1>Email confirmation is disabled</h1>
        </CardTitle>
        <CardDescription>
          This environment does not send confirmation emails, so there is nothing to verify. Sign in
          to continue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
