// @vitest-environment node
/*\n * Task 12 - the server-side client and its two session helpers.
 *
 * WHY THIS FILE EXISTS AT ALL. `lib/supabase/server.ts` exports three of the five
 * interfaces the brief names and carries the repository's hardest boundary obligation
 * (`import "server-only"` as its first line), and it had ZERO test coverage - because
 * `server-only` throws on import outside a React Server Component bundler, which makes the
 * module unimportable from a test. A live contract violation shipped inside it for exactly
 * that reason: `getUser()` threw on every anonymous page render where its own declared
 * `Promise<User | null>` promised `null`. The `server-only` alias in `vitest.config.ts` is
 * what makes this file possible; the production boundary is untouched.
 *
 * `next/headers` is mocked over an in-memory jar because `cookies()` needs a request scope
 * that does not exist here. What is NOT mocked is Supabase itself: the assertions run
 * against the live auth server with a real signed session, because the behaviour under
 * test - how `getUser` reports "signed out" - is a library behaviour, not a local one.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE,
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  createProbeSession,
  deleteProbeUsers,
} from "../helpers/auth-session-fixture";

type CookieEntry = { name: string; value: string } & Record<string, unknown>;

/** The jar `next/headers` is mocked over; the tests seed and clear it directly. */
const jar = new Map<string, CookieEntry>();

/**
 * When set, the mocked `cookieStore.set` throws, which is what really happens inside a
 * Server Component: `cookies()` can be WRITTEN from a Server Action or Route Handler and
 * can only be READ from a Server Component, so a refresh during a read-only render lands in
 * a `set()` that throws.
 */
let cookieWritesThrow = false;

vi.doMock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.values()],
    get: (name: string) => jar.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (cookieWritesThrow)
        throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      jar.set(name, { name, value, ...options });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
});

const server = await import("../../lib/supabase/server");

let userId = "";
let cookie = "";
const createdIds: string[] = [];

beforeAll(async () => {
  const probe = await createProbeSession();
  userId = probe.userId;
  cookie = probe.cookie;
  createdIds.push(userId);
});

afterAll(async () => {
  const leftovers = await deleteProbeUsers(createdIds);
  expect(leftovers).toEqual([]);
});

const seed = (value: string) => {
  jar.clear();
  if (value) jar.set(AUTH_COOKIE, { name: AUTH_COOKIE, value });
};
const clear = () => {
  jar.clear();
};

it("createServerClient returns a usable Supabase client", async () => {
  const supabase = await server.createServerClient();
  expect(typeof supabase.auth.getClaims).toBe("function");
  expect(typeof supabase.auth.getUser).toBe("function");
});

it("getClaims returns null when signed out", async () => {
  // MEASURED on this library: `getClaims` reports the signed-out case as a clean null
  // rather than raising, which is NOT symmetric with `getUser`. The asymmetry is pinned
  // here so a library change cannot make the two disagree silently.
  clear();
  await expect(server.getClaims()).resolves.toBeNull();
});

it("getUser returns null when signed out, rather than throwing", async () => {
  // THE REGRESSION THIS FILE WAS WRITTEN FOR.
  //
  // supabase-js delivers "there is no session" as an `AuthSessionMissingError` WITH
  // `data.user` null. An implementation that throws on any error therefore never reaches
  // its own `data.user ?? null`, and contradicts its declared `Promise<User | null>`.
  //
  // The consequence was concrete: a caller writing the obvious
  // `if (!user) redirect("/login")` got an uncaught AuthSessionMissingError on every
  // anonymous page render - a crash where the interface promised a redirect. And the
  // stated intent, that a signed-out visitor and an auth-server blip stay distinguishable,
  // was not delivered either, because both threw the same thing.
  clear();
  await expect(server.getUser()).resolves.toBeNull();
});

it("getClaims names the signed-in subject", async () => {
  seed(cookie);
  const claims = await server.getClaims();
  // Pinned to the actual user id, not merely "something came back".
  expect(claims?.sub).toBe(userId);
});

it("getUser returns the signed-in user", async () => {
  seed(cookie);
  const user = await server.getUser();
  expect(user?.id).toBe(userId);
  expect(user?.email).toContain("@");
});

it("survives a cookie write that throws, which is what a Server Component does", async () => {
  // Found by mutation: removing the `catch` in server.ts leaves the suite green, because
  // the mocked `cookieStore.set` was a plain Map write that could never throw. So the one
  // thing standing between a token refresh and a 500 on every read-only render - the
  // swallowed write - was never exercised. In production `cookieStore.set` DOES throw
  // inside a Server Component, and the proxy has already refreshed and written the cookie,
  // so swallowing is correct here rather than merely convenient.
  seed(cookie);
  cookieWritesThrow = true;
  try {
    await expect(server.getUser()).resolves.not.toBeNull();
    await expect(server.getClaims()).resolves.not.toBeNull();
  } finally {
    cookieWritesThrow = false;
  }
});

it("the two helpers agree about who is signed in", async () => {
  // A cheap cross-check: the local, cheap path and the authoritative network path must
  // not disagree, or a caller choosing between them gets a different answer for free.
  seed(cookie);
  const [claims, user] = await Promise.all([server.getClaims(), server.getUser()]);
  expect(claims?.sub).toBe(user?.id);

  clear();
  const [noneClaims, noneUser] = await Promise.all([server.getClaims(), server.getUser()]);
  expect(noneClaims).toBeNull();
  expect(noneUser).toBeNull();
});
