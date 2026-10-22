import "server-only";

/*
 * Server-side Supabase client and the two session helpers built on it.
 *
 * `import "server-only"` is the FIRST LINE for a reason. `check-no-secrets` flags a
 * "use client" file importing from `lib/supabase/`, but that rule is a backstop: the
 * `server-only` import is what actually fails at bundle time, so a Client Component that
 * reaches for this module breaks the build instead of shipping the service role key to a
 * browser. Do not move it below the imports.
 *
 * WHY setAll SWALLOWS ITS OWN FAILURE. `cookies()` from `next/headers` can be WRITTEN
 * from a Server Action or Route Handler and can only be READ from a Server Component.
 * A Server Component that triggers a token refresh therefore lands in a `set()` that
 * throws. That is expected, not exceptional: `proxy.ts` runs on every request and has
 * already refreshed the session and written the cookie to the response, so swallowing
 * here is what stops a read-only render from crashing. It is NOT a hole - the write
 * happens in the proxy, which is the only place it must happen.
 *
 * WHY getClaims AND NOT getSession FOR AUTHORISATION. `getClaims()` verifies the JWT
 * locally and answers from it; `getUser()` re-fetches from the auth server. Only
 * `getUser()` is authoritative, and this repository's Task 5 ruling is that no
 * database-layer check can identify the service role, so anything gating on identity
 * should use `getUser()`. `getClaims()` is for the cheap read - "is there a subject, and
 * what is it" - and is what `proxy.ts` calls to trigger the refresh.
 */
import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { AuthSessionMissingError } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

import type { Database } from "../../types/database.types";

/** A Supabase client bound to this request's cookies, for Server Components and Actions. */
export async function createServerClient() {
  const cookieStore = await cookies();

  return createSsrServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // A Server Component may only read cookies; the proxy has already refreshed
            // the session and written it to the response.
          }
        },
      },
    },
  );
}

/**
 * The authenticated user, re-fetched from the auth server, or null when signed out.
 *
 * WHY SIGNED-OUT IS NOT AN ERROR HERE, DESPITE BEING ONE IN THE LIBRARY. supabase-js
 * delivers "there is no session" as an `AuthSessionMissingError` with `data.user` null.
 * MEASURED. An earlier version of this function threw on any error, which made the
 * `data.user ?? null` line below unreachable AND contradicted the declared
 * `Promise<User | null>`: a caller writing the obvious `if (!user) redirect("/login")`
 * got an uncaught throw on every anonymous page render instead of a redirect.
 *
 * So the signed-out case maps to null, and only a genuine failure - the auth server
 * unreachable, a token rejected for a real reason - propagates. Those two must stay
 * distinguishable: collapsing them turns an auth-server blip into "nobody is signed in",
 * which is what this function exists to prevent.
 */
export async function getUser(): Promise<User | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (error instanceof AuthSessionMissingError) return null;
    throw error;
  }
  return data.user ?? null;
}

/**
 * The signed-in subject from the verified JWT, or null when signed out. Cheap and local.
 * MEASURED: unlike `getUser`, this returns a clean null when signed out rather than
 * raising, so it needs no error-class handling - but the symmetry is worth knowing if the
 * library ever changes, so the behaviour is pinned by a test.
 */
export async function getClaims(): Promise<{ sub: string } | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error) throw error;
  return data?.claims ?? null;
}
