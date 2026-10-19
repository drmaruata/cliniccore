/**
 * The active-organization cookie: its name, its attributes, and how it is read and written.
 *
 * WHY THE COOKIE IS ONLY A HINT. It records which organization a user last chose. It is NOT
 * evidence that they still belong there - that is re-checked against `organization_memberships`
 * on every read, in `lib/auth/active-org.ts`. A cookie is attacker-controlled: the user can
 * edit it, replay it after being removed, or paste an id from another clinic. Anything that
 * trusted it would hand a removed clinician another tenant's records.
 *
 * WHY HTTP-ONLY. A JavaScript-readable cookie can be rewritten by any script on the page, so
 * an XSS could point the whole session at a different clinic. That is the one thing the flag
 * is for, and it is free here because nothing in the browser needs to read this value.
 *
 * WHY `secure` IS AN ENV CHECK AND NOT A PROTOCOL CHECK, unlike the auth cookie in
 * `lib/supabase/proxy.ts`. Those two answer different questions. The session cookie must be
 * Secure whenever the request that produced it was HTTPS, or it would not have arrived. This
 * one is written from a Server Action where the protocol of the originating request is not
 * in scope, and a hard-coded `true` would stop it being set at all during local development.
 */
import { cookies } from "next/headers";

/** Cookie name for the chosen organization. */
export const ACTIVE_ORG_COOKIE = "cc_active_org";

/** Thirty days: long enough to survive a weekend, short enough to be re-validated anyway. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * The organization id from the cookie, or null.
 *
 * Returns the raw string. Whether that id still means anything is decided against the
 * database, never here - this function deliberately has no opinion about validity.
 */
export async function readActiveOrgId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;
}

/**
 * Write the chosen organization.
 *
 * Writable only from a Server Action or Route Handler - `cookies()` throws in a Server
 * Component, the same boundary `lib/supabase/server.ts` swallows. That throw is NOT caught
 * here: a caller who tries to switch organizations during a render has a control-flow bug,
 * and failing loudly beats silently doing nothing.
 *
 * Deliberately does NOT check membership. Every read re-validates, so an id that is not the
 * user's resolves to null on the very next page - and checking here would duplicate the
 * membership query on a rare user action to buy an earlier, less useful error.
 */
export async function writeActiveOrgId(orgId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
  });
}
