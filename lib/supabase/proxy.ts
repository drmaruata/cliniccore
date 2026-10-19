/**
 * Session refresh for the Next.js proxy.
 *
 * WHY THIS EXISTS AT ALL. A Supabase access token is short-lived. Without a refresh on
 * every request, a user working normally is signed out mid-session - typically on the
 * click after a token expires, which reads as a random logout.
 *
 * THE INVARIANT, AND IT IS NOT OPTIONAL. `setAll` must write the refreshed cookie to
 * BOTH `request.cookies` and the response, and must rebuild `NextResponse.next({ request })`
 * every time it does. Writing only to the response refreshes the SERVER's copy but leaves
 * the REQUEST the route handlers see holding the expired token, so server components read
 * a stale session and the two sides drift apart until the session terminates. Writing only
 * to the request refreshes nothing the browser will ever see.
 *
 * THE ORDER IS LOAD-BEARENESS, NOT STYLE. `request.cookies.set` first, THEN rebuild the
 * response from the mutated request, THEN set the cookies on that new response. Rebuilding
 * last with the already-mutated request is what propagates the refresh into the response;
 * rebuilding first and mutating after would silently drop it.
 *
 * WHY getClaims IS AWAITED IMMEDIATELY. Nothing refreshes unless something asks. Without
 * this call the client is lazy and `setAll` never runs, so the whole mechanism is dead
 * code that looks alive. It must also complete BEFORE the response is returned, because a
 * refresh that finishes after the response is committed cannot write its cookie and will
 * be lost until the next request.
 */
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import type { Database } from "../../types/database.types";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // 1. the request the route will run with
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          // 2. rebuilt from that request, so the refresh reaches the response
          response = NextResponse.next({ request });
          // 3. and finally written to the response the browser receives
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Triggers the refresh, if one is needed. Must be awaited before returning.
  await supabase.auth.getClaims();

  return response;
}
