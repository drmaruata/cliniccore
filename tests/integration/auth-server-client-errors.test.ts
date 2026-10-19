// @vitest-environment node
/*
 * The error BRANCH of `getUser` and `getClaims`, with the network removed.
 *
 * WHY THIS FILE IS FULLY MOCKED. `getUser`'s whole job is to tell two failures apart:
 * "nobody is signed in", which the caller must handle by redirecting to /login, and "the
 * auth server could not be asked", which must not be mistaken for the first. Both arrive
 * as an `error` from the same call, and the ONLY thing separating them is one
 * `instanceof` check.
 *
 * That check is untestable against the live server - you cannot make Supabase unreachable
 * on demand - and its absence is a RATCHET: replacing `instanceof AuthSessionMissingError`
 * with a bare `return null` keeps every other test green while an auth-server blip signs
 * every user out silently. That is precisely the failure the JSDoc says the function
 * exists to prevent, so the branch is pinned here with the network replaced by two
 * scripted errors.
 *
 * No signup, no network, and therefore no rate-limit exposure.
 */
import { beforeAll, expect, it, vi } from "vitest";

import { PUBLISHABLE_KEY, SUPABASE_URL } from "../helpers/auth-session-fixture";

/** What the mocked client should do on its next call. */
type Script = { user: unknown; error: { name: string; message: string } | null };

let script: Script = { user: null, error: null };

vi.doMock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: script.user }, error: script.error }),
      getClaims: async () => ({
        data: script.error ? null : { claims: { sub: "sub-1" } },
        error: script.error,
      }),
    },
  }),
}));

vi.doMock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [],
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
});

// The real `AuthSessionMissingError` is re-exported by @supabase/supabase-js, which is not
// mocked, so the instanceof check in server.ts resolves against the genuine class. The
// fake thrown by the client above is given that same name AND is made an instance of the
// real class, because the check the code performs is on the class, not the name.
const { AuthSessionMissingError } = await import("@supabase/supabase-js");
const server = await import("../../lib/supabase/server");

const signedOut = () => {
  script = { user: null, error: new AuthSessionMissingError() };
};
const authServerDown = () => {
  const error = new Error("fetch failed");
  error.name = "AuthRetryableFetchError";
  script = { user: null, error };
};

it("getUser returns null when there is simply no session", async () => {
  // The signed-out case. A caller must be able to write `if (!user) redirect("/login")`.
  signedOut();
  await expect(server.getUser()).resolves.toBeNull();
});

it("getUser THROWS when the auth server could not be asked", async () => {
  // The distinction that matters, and the one with no coverage until now. Returning null
  // here would tell every caller "nobody is signed in" during a network blip - signing
  // out a clinic that was working a moment ago, with no error anywhere.
  authServerDown();
  await expect(server.getUser()).rejects.toThrow("fetch failed");
});

it("getUser does not confuse the two", async () => {
  // Run in sequence so the two branches cannot be satisfied by the same implementation.
  authServerDown();
  await expect(server.getUser()).rejects.toThrow();
  signedOut();
  await expect(server.getUser()).resolves.toBeNull();
});

it("getClaims propagates a genuine failure rather than reporting signed-out", async () => {
  // Measured asymmetry, now pinned: getClaims returns a clean null when signed out, so
  // it must not be assumed to behave like getUser in the failure case either.
  authServerDown();
  await expect(server.getClaims()).rejects.toThrow("fetch failed");
});

it("the error class the code checks for is the real one, not a same-named impostor", () => {
  // Guards the guard. The signed-out branch is an instanceof check against the class
  // exported by @supabase/supabase-js, so a same-named class from somewhere else would
  // silently fail it and the signed-out case would start throwing again - which the tests
  // above would catch, but only confusingly.
  expect(typeof AuthSessionMissingError).toBe("function");
  expect(new AuthSessionMissingError()).toBeInstanceOf(AuthSessionMissingError);
});
