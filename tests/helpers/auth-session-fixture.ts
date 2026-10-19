/**
 * A real, signed Supabase session for tests, plus the cookie plumbing needed to hand one
 * to the modules under test.
 *
 * WHY A HELPER RATHER THAN DUPLICATION. Two integration suites need a live session: the
 * proxy suite (`updateSession` and the cookie invariant) and the server-client suite
 * (`getUser`, `getClaims`). Each needs a fresh user, and Supabase rate-limits public
 * signUp, so duplicating the fallback would mean two copies of the rate-limit branch to
 * keep in step and two chances to bump the per-run signup count.
 *
 * WHY THE FALLBACK EXISTS AT ALL, AND WHY IT IS NARROW. MEASURED: at three signups per
 * run the auth-session suite went green, green, then one failure, then three - a filling
 * rate-limit window, not a logic bug, and easy to misread as flakiness in the code under
 * test. When - and ONLY when - the public signup reports a rate limit, the user is created
 * through the admin endpoint, which is not subject to it, and then signed in through the
 * PUBLIC client so the session under test is still obtained the ordinary way.
 *
 * The narrowness is deliberate and is asserted: `/rate limit/i` matches Supabase's
 * "Rate limit reached" and nothing else, so every OTHER signup failure - a broken signup
 * path, a disabled provider, a bad key - still throws and fails the suite. A fallback
 * that quietly substituted for a real failure would turn this suite into a ratchet.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import { envValue } from "../integration/helpers/database";

export const SUPABASE_URL = envValue("NEXT_PUBLIC_SUPABASE_URL") ?? "";
export const PUBLISHABLE_KEY = envValue("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ?? "";
export const SERVICE_ROLE_KEY = envValue("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** The cookie name @supabase/ssr derives from the project URL. */
export const AUTH_COOKIE = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

export const PROBE_PASSWORD = "Pr0be-Passw0rd!x";

export type Jar = Map<string, { name: string; value: string }>;

export function decodeCookie(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8"));
}

export function encodeCookie(value: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** An SSR client over a plain in-memory cookie jar, optionally seeded. */
export function clientOverJar(seed?: Record<string, { name: string; value: string }>) {
  const jar: Jar = new Map(seed ? Object.entries(seed) : []);
  return {
    jar,
    client: createServerClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      cookies: {
        getAll: () => [...jar.values()],
        setAll: (list) => {
          for (const cookie of list) jar.set(cookie.name, cookie);
        },
      },
    }),
  };
}

export const sessionCookieValue = (session: {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  refresh_token: string;
  user: unknown;
}) =>
  encodeCookie({
    access_token: session.access_token,
    token_type: session.token_type,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    refresh_token: session.refresh_token,
    user: session.user,
  });

/** Register a throwaway user and return its id plus the raw session cookie value. */
export async function createProbeSession(): Promise<{ userId: string; cookie: string }> {
  const { client } = clientOverJar();
  const email = `probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

  const { data, error } = await client.auth.signUp({ email, password: PROBE_PASSWORD });
  if (error && !/rate limit/i.test(error.message)) {
    throw new Error(`signUp failed: ${error.message}`);
  }

  if (error) {
    const created = await admin().auth.admin.createUser({
      email,
      password: PROBE_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    const signedIn = await client.auth.signInWithPassword({ email, password: PROBE_PASSWORD });
    if (signedIn.error) throw signedIn.error;
    return {
      userId: created.data.user.id,
      cookie: sessionCookieValue(signedIn.data.session!),
    };
  }

  const session = (await client.auth.getSession()).data.session;
  if (!session) throw new Error("signUp returned no session");
  return { userId: data.user?.id ?? "", cookie: sessionCookieValue(session) };
}

/**
 * Delete the given probe users and PROVE those specific ones are gone, so a failed cleanup
 * is a test failure rather than a slow leak into the live project.
 *
 * SCOPED TO THE IDS PASSED IN, NOT "no probe user exists anywhere". Vitest runs test FILES
 * in parallel and two of them each create a probe user, so a global assertion makes every
 * file fail on its neighbour's - which is exactly what happened the first time. Asserting
 * only about what THIS caller created is both correct and parallel-safe.
 */
export async function deleteProbeUsers(ids: string[]): Promise<string[]> {
  const client = admin();
  for (const id of ids) {
    const { error } = await client.auth.admin.deleteUser(id);
    if (error) throw new Error(`cleanup failed for ${id}: ${error.message}`);
  }
  const { data } = await client.auth.admin.listUsers({ page: 1, perPage: 200 });
  const remaining = new Set((data?.users ?? []).map((user) => user.id));
  return ids.filter((id) => remaining.has(id));
}
