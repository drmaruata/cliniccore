import { createServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";

/**
 * The code exchange: where a recovery or confirmation session is established.
 *
 * WHY A ROUTE HANDLER AND NOT A PAGE. The session has to be written as a COOKIE, and a
 * Server Component cannot set cookies - only a Server Action or a Route Handler can. So
 * the exchange lives here, and the pages that need a session read it back.
 *
 * WHY THE DESTINATION IS AN ALLOW-LIST. The `next` parameter chooses where the browser
 * goes after the exchange, and a value that came from the query string and was not
 * checked would be an OPEN REDIRECT - a link on this domain that bounces a signed-in
 * user to an attacker's page. Only the routes this application owns are allowed.
 */
const ALLOWED_DESTINATIONS = new Set(["/", "/reset-password", "/onboarding", "/dashboard"]);

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const requested = request.nextUrl.searchParams.get("next") ?? "/";
  const destination = ALLOWED_DESTINATIONS.has(requested) ? requested : "/";

  if (!code) {
    return NextResponse.redirect(new URL("/reset-password?error=missing_code", request.url));
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("auth verify: the code could not be exchanged", error.message);
    return NextResponse.redirect(new URL("/reset-password?error=invalid_code", request.url));
  }

  return NextResponse.redirect(new URL(destination, request.url));
}
