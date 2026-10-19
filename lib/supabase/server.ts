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
 * Throws on a transport or auth failure rather than returning null, because "no user" and
 * "could not ask" are different answers and collapsing them would log a healthy clinic
 * out during an auth-server blip.
 */
export async function getUser(): Promise<User | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user ?? null;
}

/** The signed-in subject from the verified JWT, or null when signed out. Cheap and local. */
export async function getClaims(): Promise<{ sub: string } | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error) throw error;
  return data?.claims ?? null;
}
