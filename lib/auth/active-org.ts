import "server-only";

/**
 * Resolving which organization the user is currently acting in.
 *
 * THE ONE RULE: THE COOKIE IS NEVER TRUSTED. It says which organization the user last
 * chose; the database decides whether that is still true. A user removed from an
 * organization, or an organization that is suspended, resolves to `null` - never to
 * whatever the cookie still claims. A cookie is attacker-controlled: it can be edited, replayed
 * after a removal, or copied from another clinic, so anything that trusted it would hand a
 * removed clinician a different tenant's records. The re-validation is a single query that
 * RLS already governs, so "is this still true?" is answered by the same policy that
 * answers everything else in this application.
 *
 * A STALE COOKIE NEVER FALLS BACK. With no cookie at all, a user in exactly one
 * organization resolves to it - unambiguous, and it means a fresh login lands somewhere
 * useful. With several, there is no correct answer and the result is null. But a cookie
 * that WAS present and no longer resolves never falls back: the user chose, that choice
 * died, and silently moving them into a different clinic is worse than asking them again.
 *
 * THE MEMBERSHIP TABLE IS THE SOURCE, NEVER THE ORGANIZATIONS TABLE. `organizations` has
 * a SELECT policy of `is_member(id) or is_platform_admin()`, so reading it directly would
 * hand a platform operator the whole tenant directory - right for the platform console,
 * wrong for a switcher. The membership table reduces to the rows the user may act in.
 *
 * WHY `hasAnyMembership` EXISTS. `organization_memberships_select`'s row filter is
 * `private.is_member(organization_id)`, and `is_member` requires an ACTIVE membership in
 * an ACTIVE organization. So a member of a suspended tenant - and a member whose own
 * membership is suspended - see NO membership rows at all. An empty membership list does
 * NOT mean "you belong to nothing": it means "you belong to nothing you can see", and the
 * shell's onboarding branch must not be offered to them. This answers about the CALLER
 * only, and answers a boolean; a definer sees the rows the policies hide.
 *
 * `userCan` IS ADVISORY, NOT ENFORCEMENT, AND THE RULE IS ASKED OF THE DATABASE. It
 * exists so a UI can hide a control the user cannot use, and it must never gate access:
 * it is answerable from the client side and RLS is the real boundary. It asks
 * `public.can`, a thin wrapper over `private.can` - the same function the RLS policies
 * call - because this function used to reimplement the rule in TypeScript, and that is
 * how it came to exist twice and drift once (the SQL refuses a `platform.`-prefixed key
 * CASE-INSENSITIVELY; the TypeScript copy did not).
 *
 * ITS CLINIC PARAMETER IS NAMED FOR WHAT IT ASKS. `assignmentClinicId` asks about a
 * GRANT's scope, not the caller's access: `private.can` does NOT consult
 * `private.clinic_ids`. MEASURED: a user whose membership is restricted to clinic CA1,
 * holding an org-wide grant, answers `true` for CA2 - a clinic they cannot read. The
 * database is still safe (the RLS policy refuses the rows), but a helper that answered
 * "may I access this clinic's data" would be answering a different question.
 */
import type { PermissionKey } from "../permissions/registry";
import { UnauthorizedError } from "../errors";
import { readActiveOrgId, writeActiveOrgId } from "./session";
import { createServerClient } from "../supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../types/database.types";

/** Everything the UI needs to render a tenant, and nothing it does not. */
export interface ActiveOrg {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  locale: string;
}

/** One of the organizations a user belongs to, as the switcher needs it. */
export interface MemberOrg {
  id: string;
  name: string;
  slug: string;
}

interface MembershipRow {
  organization_id: string;
  organizations: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    locale: string;
  } | null;
}

const toActiveOrg = (row: MembershipRow): ActiveOrg | null => {
  const org = row.organizations;
  // A membership whose organization did not embed is not something to guess about.
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    currency: org.currency,
    locale: org.locale,
  };
};

/**
 * The shared core of `getActiveOrg` and `userCan`, extracted so that `userCan` does not ask
 * the auth server WHO the user is a second time: it already knows, and each of those
 * questions is a JWT re-validation over the network. Before the extraction, `userCan` cost
 * FIVE round trips - an auth validation, another auth validation inside `getActiveOrg`, a
 * memberships query, an assignments query and a grants query.
 */
async function resolveActiveOrg(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ActiveOrg | null> {
  const cookieOrgId = await readActiveOrgId();

  // One query answers "which orgs may this user act in", and RLS decides the rows. An
  // organization the user was removed from is simply absent from the result - which is why
  // this cannot be fooled by a stale or forged cookie.
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, organizations(id, name, slug, timezone, currency, locale, status)")
    .eq("user_id", userId);

  if (error) {
    // Deliberately NOT translated into a typed error. `toSafeResponse` turns anything it
    // does not recognise into a generic 500, which is the right outcome for a PostgREST
    // failure, and inventing an AppError here would risk putting a raw database message in
    // front of a user.
    throw error;
  }

  const memberships = (data ?? []) as unknown as MembershipRow[];
  if (memberships.length === 0) return null;

  if (cookieOrgId !== null) {
    const chosen = memberships.find((row) => row.organization_id === cookieOrgId);
    // Null, never a fallback - see the header.
    return chosen ? toActiveOrg(chosen) : null;
  }

  if (memberships.length === 1) return toActiveOrg(memberships[0] as MembershipRow);
  return null;
}

/**
 * The organization the user is acting in, or null. Null means: signed out, or belonging to
 * nothing, or the chosen organization is no longer one they belong to, or the choice is
 * ambiguous. All four are "do not assume a tenant", and Task 17 renders that state.
 */
export async function getActiveOrg(): Promise<ActiveOrg | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  return resolveActiveOrg(supabase, user.id);
}

/** As `getActiveOrg`, for callers that cannot proceed without a tenant. */
export async function requireActiveOrg(): Promise<ActiveOrg> {
  const org = await getActiveOrg();
  if (!org) {
    throw new UnauthorizedError("No active organization. Choose one to continue.", "no_active_org");
  }
  return org;
}

/** Whether the user has ANY membership, in any state - see the header. */
export async function hasAnyMembership(): Promise<boolean> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("has_any_membership");
  if (error) {
    // The house pattern for an advisory helper: an unreachable answer is not an answer.
    // The shell then falls back to the onboarding screen, which is the behaviour that
    // existed before this question could be asked.
    return false;
  }
  return data === true;
}

/** The organizations the given user may act in. */
export async function listMemberOrgs(userId: string): Promise<MemberOrg[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, organizations(id, name, slug)")
    .eq("user_id", userId);

  if (error) throw error;

  return (data ?? [])
    .map((row) => {
      const org = row.organizations;
      if (!org) return null;
      return { id: org.id, name: org.name, slug: org.slug };
    })
    .filter((org): org is MemberOrg => org !== null);
}

/**
 * Record the user's organization choice. Writes the cookie only: membership is
 * re-validated on every read, so an id the user does not belong to resolves to null on the
 * next page load.
 */
export async function setActiveOrg(orgId: string): Promise<void> {
  await writeActiveOrgId(orgId);
}

/**
 * Whether the current user holds a permission in the active organization. Deliberately
 * NOT named `hasPermission`: Task 3 already owns a pure `hasPermission(roles,
 * permission)` over an in-memory role list, and two different signatures under one name is
 * a bug waiting to happen at every call site.
 */
export async function userCan(
  permission: PermissionKey,
  assignmentClinicId?: string | null,
): Promise<boolean> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const org = await resolveActiveOrg(supabase, user.id);
  if (!org) return false;

  // The clinic is OMITTED rather than passed as null. The generated type says
  // `p_clinic_id?: string`, and PostgREST matches a function on the exact set of supplied
  // parameter names - so sending a key the caller does not have a value for is how the
  // four-key-body PGRST202 happened in the first place. Omitting it is both correct and
  // what the database's own default means.
  const args: { p_org_id: string; p_permission: string; p_clinic_id?: string } = {
    p_org_id: org.id,
    p_permission: permission,
  };
  if (assignmentClinicId) args.p_clinic_id = assignmentClinicId;

  const { data, error } = await supabase.rpc("can", args);
  if (error) return false;
  return data === true;
}
