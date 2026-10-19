// @vitest-environment node
/*
 * Task 12 - Supabase SSR clients, session refresh, and the root proxy.
 *
 * WHY THIS RUNS AGAINST THE REAL AUTH SERVER rather than a mock. The whole point of Task
 * 12 is cookie wiring, and the failure the brief calls out is one a mock cannot
 * reproduce: `setAll` writing to only ONE of `request.cookies` and the response
 * desynchronises the browser from the server, and the symptom is sessions that die
 * silently hours later. Every assertion here drives the real `@supabase/ssr` client over
 * a real signed session.
 *
 * WHY ONE SIGNUP PER RUN, AND WHY THAT IS A HARD CONSTRAINT. Supabase rate-limits public
 * signUp per window. MEASURED: at three signups per run this file went green, green, then
 * one failure, then three, as the window filled - the signature of a rate limit, not of a
 * logic bug, and easy to misread as flakiness in the code under test. One user is created
 * in `beforeAll` and shared by every test that only needs to READ a session.
 *
 * WHY THE SIGN-OUT TEST IS DECLARED LAST. `signOut()` defaults to scope "global" and
 * revokes EVERY refresh token for the user, including the shared session. An earlier
 * version ran it first and every later test failed with "Invalid Refresh Token: Refresh
 * Token Not Found" - a fixture destroying itself, surfacing as three unrelated failures.
 * Vitest runs a file's tests in declaration order, so placing it last is deterministic;
 * if this file is ever made concurrent, this test needs its own user.
 *
 * WHAT IS CLEANED UP. Real auth users are created in the live project on every run. They
 * are deleted in `afterAll` with the service role, and the suite FAILS if any survive.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it } from "vitest";

import { envValue } from "./helpers/database";

const SUPABASE_URL = envValue("NEXT_PUBLIC_SUPABASE_URL") ?? "";
const PUBLISHABLE_KEY = envValue("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE_ROLE_KEY = envValue("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// The client modules read process.env at CALL time, so setting it here - rather than
// relying on Vite's envPrefix - is enough, and matches how the database helper already
// refuses to depend on that detail.
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
});

const { updateSession } = await import("../../lib/supabase/proxy");
const rootProxy = await import("../../proxy");

const AUTH_COOKIE = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
const PASSWORD = "Pr0be-Passw0rd!x";

const decodeCookie = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8"));

const encodeCookie = (value: Record<string, unknown>): string =>
  `base64-${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;

const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** An SSR client over a plain in-memory cookie jar, seeded with `seed`. */
function clientOverJar(seed?: Record<string, { name: string; value: string }>) {
  const jar = new Map(seed ? Object.entries(seed) : []);
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

let sharedCookie = "";
const createdUserIds: string[] = [];

beforeAll(async () => {
  const { client } = clientOverJar();
  const email = `probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

  // The PUBLIC signup path is what this suite is here to exercise, so it is tried first.
  let session = null;
  const { data, error } = await client.auth.signUp({ email, password: PASSWORD });

  if (error) {
    if (!/rate limit/i.test(error.message)) {
      throw new Error(`signUp failed: ${error.message}`);
    }
    // Supabase rate-limits public signUp per window, and this suite is meant to be
    // re-runnable. MEASURED: repeated local runs exhaust the window and the suite then
    // fails on a rate limit rather than on anything it is testing. The admin endpoint is
    // not subject to that limit, so create the user there and sign in through the PUBLIC
    // client - the session under test is still a real one, obtained the ordinary way.
    const created = await admin().auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    createdUserIds.push(created.data.user.id);
    const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signedIn.error) throw signedIn.error;
    session = signedIn.data.session;
  } else {
    createdUserIds.push(data.user?.id ?? "");
    session = (await client.auth.getSession()).data.session;
  }

  sharedCookie = session
    ? encodeCookie({
        access_token: session.access_token,
        token_type: session.token_type,
        expires_in: session.expires_in,
        expires_at: session.expires_at,
        refresh_token: session.refresh_token,
        user: session.user,
      })
    : "";
  expect(sharedCookie, "the suite needs a real session for these tests to mean anything").not.toBe(
    "",
  );
});

afterAll(async () => {
  if (createdUserIds.length === 0) return;
  const client = admin();
  for (const id of createdUserIds) {
    const { error } = await client.auth.admin.deleteUser(id);
    if (error) throw new Error(`cleanup failed for ${id}: ${error.message}`);
  }
  // Prove the cleanup rather than trusting it.
  const { data } = await client.auth.admin.listUsers({ page: 1, perPage: 200 });
  const leftovers = (data?.users ?? []).filter((user) => user.email?.startsWith("probe-"));
  expect(leftovers.map((user) => user.email)).toEqual([]);
});

it("the root proxy exports a named `proxy` function, not `middleware`", () => {
  // Next.js 16 renamed the convention. A leftover `middleware` export is silently
  // ignored, so the session refresh would never run and users would be logged out at
  // random hours later.
  // NOT named `module` - that identifier is reserved under @next/next rules.
  const exported = rootProxy as Record<string, unknown>;
  expect(typeof exported.proxy).toBe("function");
  expect(exported.middleware).toBeUndefined();
});

it("the proxy matcher skips static assets and anything with a file extension", () => {
  // Without this the proxy runs on every CSS and image request, where an auth redirect
  // would block the page from rendering at all.
  const config = (rootProxy as { config?: { matcher?: string[] } }).config;
  expect(Array.isArray(config?.matcher)).toBe(true);
  const matcher = config?.matcher?.[0] ?? "";
  expect(matcher).toContain("_next/static");
  expect(matcher).toContain("_next/image");
  expect(matcher).toMatch(/\\\./); // the extension-avoiding alternative
});

it("updateSession refreshes a stale session into BOTH the request and the response", async () => {
  // THE INVARIANT. Writing the refreshed cookie to only one of the two desynchronises
  // the browser from the server; the brief records that this terminates sessions. Both
  // are asserted, and against the cookie that was sent, so a proxy that silently wrote
  // nothing cannot pass.
  //
  // A FRESH token is valid, so nothing calls `setAll` and the invariant is unobservable.
  // Rewinding `expires_at` inside the cookie - keeping the real refresh token - forces
  // the refresh path. MEASURED: `setAll` then fires and the cookie returns live.
  const stale = { ...decodeCookie(sharedCookie), expires_at: Math.floor(Date.now() / 1000) - 60 };
  const sent = encodeCookie(stale);

  const request = new NextRequest("https://cliniccore.test/dashboard");
  request.cookies.set(AUTH_COOKIE, sent);

  const response = await updateSession(request);
  const inResponse = response.cookies.get(AUTH_COOKIE)?.value;
  const inRequest = request.cookies.get(AUTH_COOKIE)?.value;

  expect(inResponse, "the response must carry the refreshed cookie").toBeTruthy();
  expect(inRequest, "the request must also be updated, or browser and server diverge").toBeTruthy();
  expect(inRequest, "request and response must agree exactly").toBe(inResponse);

  // And it really was refreshed: the expired cookie we sent was replaced by a live one.
  // Comparing against the ORIGINAL expiry would assert now+3600 > now+3600.
  expect(inResponse, "the expired cookie must not have been passed through").not.toBe(sent);
  expect(Number(decodeCookie(inResponse ?? "").expires_at)).toBeGreaterThan(
    Math.floor(Date.now() / 1000),
  );

  // The REBUILD, which is the half of the invariant that is easy to omit. setAll sets
  // response.cookies directly, so a proxy that skipped the rebuild still passes every
  // assertion above - while the request the ROUTE sees still carries the expired cookie,
  // so server components read a stale session. That divergence is invisible from
  // response.cookies; it surfaces in the headers Next forwards the request through.
  const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
  expect(forwarded, "the route must be forwarded a cookie header at all").not.toBe("");
  expect(
    forwarded,
    "the request forwarded to the route must carry the REFRESHED cookie, not the expired one",
  ).toContain(inRequest ?? "");
  expect(forwarded).not.toContain(sent);
});

it("updateSession leaves a request with no session alone", async () => {
  // The control for the test above. Without it, "both cookies are present and equal"
  // would also be satisfied by a proxy that invents a cookie for an anonymous visitor -
  // and by one that writes nothing at all, if it wrote the same absence to both sides.
  const request = new NextRequest("https://cliniccore.test/dashboard");
  const response = await updateSession(request);

  expect(response).toBeDefined();
  expect(response.cookies.get(AUTH_COOKIE)?.value).toBeUndefined();
  expect(request.cookies.get(AUTH_COOKIE)?.value).toBeUndefined();
});

it("keeps request and response in step when no refresh is needed", async () => {
  // A valid token needs no refresh, so nothing is re-minted and the response carries no
  // new session cookie. That asymmetry is CORRECT: the response only has to speak when
  // something changed, and demanding the two always match would be asserting that a valid
  // session is needlessly rewritten.
  //
  // What must hold unconditionally is that they never DISAGREE when a cookie IS written,
  // and that the request never loses the session it arrived with.
  const request = new NextRequest("https://cliniccore.test/dashboard");
  request.cookies.set(AUTH_COOKIE, sharedCookie);

  const response = await updateSession(request);
  const inResponse = response.cookies.get(AUTH_COOKIE)?.value;
  const inRequest = request.cookies.get(AUTH_COOKIE)?.value;

  if (inResponse !== undefined) {
    expect(inRequest, "a cookie written to the response must also be on the request").toBe(
      inResponse,
    );
  }
  expect(inRequest, "the request must never lose the session it arrived with").toBeTruthy();
});

it("sign-out clears the session", async () => {
  // LAST, and deliberately so - see the file header. Also the brief's Step 1: claims
  // present, signOut(), claims null.
  const { client } = clientOverJar({ [AUTH_COOKIE]: { name: AUTH_COOKIE, value: sharedCookie } });

  const before = await client.auth.getClaims();
  expect(before.data?.claims?.sub, "precondition: there is a session to sign out of").toBeTruthy();
  // Positive control: the claims carry more than the sub, so asserting on sub alone is
  // not just asserting that some object came back.
  expect(before.data?.claims?.role).toBe("authenticated");

  await client.auth.signOut();
  const after = await client.auth.getClaims();
  expect(after.data?.claims?.sub ?? null).toBeNull();
});
