/**
 * The active-organization and active-clinic cookies: their names, their attributes, and
 * how they are read and written.
 *
 * WHY A COOKIE IS ONLY A HINT. It records which organization - or clinic - a user last
 * chose. It is NOT evidence that they still belong there - that is re-checked against
 * `organization_memberships` on every read, in `lib/auth/active-org.ts`. A cookie is
 * attacker-controlled: the user can edit it, replay it after being removed, or paste an id
 * from another clinic. Anything that trusted it would hand a removed clinician another
 * tenant's records. The clinic cookie follows the same rule, and a clinic id in it is not
 * evidence of anything either.
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
 *
 * WHY A WRITE IS SERVER-ONLY, AND WHY ITS THROW IS NOT CAUGHT. `cookies()` throws in a
 * Server Component, the same boundary `lib/supabase/server.ts` swallows. A caller who tries
 * to switch organizations during a render has a control-flow bug, and failing loudly beats
 * silently doing nothing. A WRITE ALSO DOES NOT CHECK MEMBERSHIP: every read re-validates,
 * so an id that is not the user's resolves to null on the very next page - and checking
 * here would duplicate the membership query on a rare user action to buy an earlier, less
 * useful error.
 */
import { cookies } from "next/headers";

export const ACTIVE_ORG_COOKIE = "cc_active_org";

export const ACTIVE_CLINIC_COOKIE = "cc_active_clinic";

/** Thirty days: long enough to survive a weekend, short enough to be re-validated anyway. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** The raw id from the cookie, or null. Whether it still means anything is the database's call. */
export async function readActiveOrgId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;
}

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

export async function readActiveClinicId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ACTIVE_CLINIC_COOKIE)?.value ?? null;
}

export async function writeActiveClinicId(clinicId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_CLINIC_COOKIE, clinicId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
  });
}
