// @vitest-environment node
/*
 * Task 12 - session refresh and the root proxy.
 *
 * WHY THIS RUNS AGAINST THE REAL AUTH SERVER rather than a mock. The whole point of Task
 * 12 is cookie wiring, and the failure the brief calls out is one a mock cannot reproduce:
 * `setAll` writing to only ONE of `request.cookies` and the response desynchronises the
 * browser from the server, and the symptom is sessions that die silently hours later.
 * Every assertion here drives the real `@supabase/ssr` client over a real signed session.
 *
 * WHY ONE SIGNUP PER RUN. Supabase rate-limits public signUp per window. MEASURED: at
 * three signups per run this file went green, green, then one failure, then three as the
 * window filled - the signature of a rate limit, not of a logic bug, and easy to misread
 * as flakiness in the code under test. See tests/helpers/auth-session-fixture.ts, which
 * also carries the narrow admin fallback for when the window IS full.
 *
 * WHY THE SIGN-OUT TEST IS DECLARED LAST - and the reason is NOT "global scope revokes
 * every refresh token", which is what an earlier version of this comment claimed and
 * which MEASUREMENT contradicts. The token IS revoked server-side, but a live client
 * session survives that anyway: `getClaims()` verifies the cached access token locally and
 * never reaches for the refresh token. The real dependency is the test above - it drives a
 * cookie whose `expires_at` is in the past, which DOES force a network refresh, which DOES
 * fail once the token is gone. Vitest runs a file's tests in declaration order, so placing
 * this last is deterministic; if this file is ever made concurrent it needs its own user.
 */
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  AUTH_COOKIE,
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  clientOverJar,
  createdProbeUserIds,
  createProbeSession,
  decodeCookie,
  deleteProbeUsers,
  encodeCookie,
} from "../helpers/auth-session-fixture";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
});

const { updateSession } = await import("../../lib/supabase/proxy");
const rootProxy = await import("../../proxy");

let sharedCookie = "";

beforeAll(async () => {
  const probe = await createProbeSession();
  sharedCookie = probe.cookie;
});

afterAll(async () => {
  // Prove the cleanup rather than trusting it: an accumulating pile of probe users is
  // the residue problem this repository has been bitten by more than once.
  expect(await deleteProbeUsers(createdProbeUserIds)).toEqual([]);
});

const requestCarrying = (value?: string) => {
  const request = new NextRequest("https://cliniccore.test/dashboard");
  if (value !== undefined) request.cookies.set(AUTH_COOKIE, value);
  return request;
};

it("the root proxy exports a named `proxy` function, not `middleware`", () => {
  // Next.js 16 renamed the convention. A leftover `middleware` export is silently
  // ignored, so the session refresh would never run and users would be logged out at
  // random hours later.
  const exported = rootProxy as Record<string, unknown>;
  expect(typeof exported.proxy).toBe("function");
  expect(exported.middleware).toBeUndefined();
});

it("the root proxy actually delivers the refreshed cookie to the browser", async () => {
  // Found by mutation, twice. Asserting only `resolves.toBeInstanceOf(NextResponse)` is
  // defeated by
  //     void updateSession(request); return NextResponse.next();
  // which passes every assertion in this file with eslint 0 and tsc 0. That proxy still
  // mutates `request.cookies` in place, so the route sees a live token, but the response
  // carrying `Set-Cookie` is thrown away - the browser never receives a refreshed token
  // and the user is signed out mid-session. That is verbatim the failure this file exists
  // to prevent, and asserting the RETURN TYPE cannot see it.
  //
  // So the refreshed Set-Cookie is asserted on the root proxy's OWN response, which is the
  // only thing the browser actually receives.
  const stale = encodeCookie({
    ...decodeCookie(sharedCookie),
    expires_at: Math.floor(Date.now() / 1000) - 60,
  });
  const request = requestCarrying(stale);
  const proxy = (rootProxy as { proxy: (r: NextRequest) => Promise<NextResponse> }).proxy;

  const response = await proxy(request);

  expect(response).toBeInstanceOf(NextResponse);
  const setCookie = response.headers.getSetCookie().join(";");
  expect(setCookie, "the browser must actually receive the refreshed session cookie").not.toBe("");
  expect(setCookie).toContain(AUTH_COOKIE);
  // And what it received is the REFRESHED cookie, not the expired one that was sent.
  const refreshed = request.cookies.get(AUTH_COOKIE)?.value ?? "";
  expect(refreshed).not.toBe("");
  expect(refreshed).not.toBe(stale);
  expect(setCookie).toContain(refreshed);
  expect(Number(decodeCookie(refreshed).expires_at)).toBeGreaterThan(Math.floor(Date.now() / 1000));
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
  const stale = {
    ...decodeCookie(sharedCookie),
    expires_at: Math.floor(Date.now() / 1000) - 60,
  };
  const sent = encodeCookie(stale);
  const request = requestCarrying(sent);

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

it("the refreshed cookie keeps its security attributes", async () => {
  // Found by mutation: `response.cookies.set(name, value)` without the `options` argument
  // keeps the suite green while SILENTLY dropping `SameSite=lax` and `Max-Age=0` - a CSRF
  // posture change on the session cookie of a PHI system. Every other assertion in this
  // file reads `response.cookies.get(name)?.value`, which is the value and never the
  // attributes, so nothing else could have caught it.
  const request = requestCarrying(
    encodeCookie({ ...decodeCookie(sharedCookie), expires_at: Math.floor(Date.now() / 1000) - 60 }),
  );
  const response = await updateSession(request);
  const setCookie = response.headers.getSetCookie().join(";");

  expect(setCookie, "SameSite must survive - this is the CSRF control").toContain("SameSite=lax");
  expect(setCookie).toContain("Path=/");
  // The library sets no `secure` at all; updateSession adds it from the request protocol,
  // and this request is https, so the cookie must not be sendable over plain HTTP.
  expect(setCookie, "an https request must not produce a cookie that travels over http").toContain(
    "Secure",
  );

  // Deliberately NOT HttpOnly, and asserted as such so a library bump that flips it is
  // visible rather than silent. MEASURED: @supabase/ssr sets httpOnly:false on purpose,
  // because the browser client restores its session by reading document.cookie. Making it
  // HttpOnly would break sign-in on a full page load.
  expect(setCookie).not.toContain("HttpOnly");
});

it("a plain-http request gets a cookie that is not Secure, so local dev still works", async () => {
  // The counterpart to the assertion above, and the reason `secure` is derived from the
  // request rather than hard-coded: hard-coding it would stop the cookie working at all
  // over http://localhost, which looks exactly like a broken session.
  const request = new NextRequest("http://localhost:3000/dashboard");
  request.cookies.set(
    AUTH_COOKIE,
    encodeCookie({ ...decodeCookie(sharedCookie), expires_at: Math.floor(Date.now() / 1000) - 60 }),
  );
  const response = await updateSession(request);
  expect(response.headers.getSetCookie().join(";")).not.toContain("Secure");
});

it("updateSession leaves a request with no session alone", async () => {
  // The control for the refresh test. Without it, "both cookies are present and equal"
  // would also be satisfied by a proxy that invents a cookie for an anonymous visitor -
  // and by one that writes nothing at all, if it wrote the same absence to both sides.
  const request = requestCarrying();
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
  const request = requestCarrying(sharedCookie);
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
  // LAST, deliberately - see the file header for the measured reason.
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
