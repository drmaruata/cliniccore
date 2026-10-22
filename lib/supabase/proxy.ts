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
 * to the request refreshes nothing the browser will ever see. The ORDER is load-bearing
 * too: set the request cookie, THEN rebuild the response from the mutated request, THEN
 * set the cookies on that new response.
 *
 * WHY getClaims IS AWAITED IMMEDIATELY. Nothing refreshes unless something asks. Without
 * this call the client is lazy and `setAll` never runs, so the whole mechanism is dead
 * code that looks alive. It must also complete BEFORE the response is returned, because a
 * refresh that finishes after the response is committed cannot write its cookie and will
 * be lost until the next request.
 *
 * WHY THE COOKIES ARE ACCUMULATED. The rebuild constructs a FRESH response, so anything
 * written to the previous one is discarded. `setAll` is called once per batch, and the
 * number of batches is the LIBRARY's business, not ours: `@supabase/ssr` chunks a large
 * session across several cookies, and a future version could emit more than one batch. A
 * second call would then silently DISCARD the first batch's cookies, and the browser would
 * keep an expired token while the server believed it had been refreshed - the
 * session-dies-mid-shift symptom. MEASURED as unreachable today - `getClaims()` makes
 * exactly one refresh and emits one batch, across an expired token, an expired token with
 * a garbage access token, and an invalid refresh token - so this is defence against a
 * change we do not control.
 *
 * THE COOKIE OPTIONS, MEASURED IN `node_modules/@supabase/ssr`. The library's defaults are
 * `{ path: "/", sameSite: "lax", httpOnly: false, maxAge: 400d }`, with `secure` absent
 * entirely. `httpOnly: false` is DELIBERATE and must stay: the browser client restores its
 * session by reading document.cookie, so an HttpOnly cookie would break sign-in on a full
 * page load. Do not "harden" this one. The missing `secure` is a genuine weakness for a
 * PHI session cookie - without it a browser will also send the cookie over plain HTTP -
 * so it is set here from the request's own protocol rather than hard-coded, because a
 * hard-coded one would stop the cookie working at all during local development over
 * http://localhost.
 */
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import type { Database } from "../../types/database.types";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const isHttps = request.nextUrl.protocol === "https:";

  // Every cookie this request wants written, accumulated across calls.
  const pending = new Map<string, { value: string; options: Record<string, unknown> }>();

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            pending.set(name, { value, options: (options ?? {}) as Record<string, unknown> });
            // 1. the request the route will run with
            request.cookies.set(name, value);
          }
          // 2. rebuilt from that request, so the refresh reaches the response
          response = NextResponse.next({ request });
          // 3. and finally written to the response the browser receives - EVERY pending
          //    cookie, not just this batch's, so a second batch cannot discard the first.
          for (const [name, entry] of pending) {
            response.cookies.set(name, entry.value, { ...entry.options, secure: isHttps });
          }
        },
      },
    },
  );

  // Triggers the refresh, if one is needed. Must be awaited before returning.
  await supabase.auth.getClaims();

  return response;
}
