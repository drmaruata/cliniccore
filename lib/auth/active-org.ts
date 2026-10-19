import "server-only";

/**
 * Resolving which organization the user is currently acting in.
 *
 * THE ONE RULE: THE COOKIE IS NEVER TRUSTED. It says which organization the user last
 * chose; the database decides whether that is still true. A user removed from an
 * organization, or an organization that is suspended, resolves to `null` - never to
 * whatever the cookie still claims. A cookie is user-controlled: it can be edited, replayed
 * after a removal, or copied from another clinic, so anything that trusted it would hand a
 * removed clinician a different tenant's records.
 *
 * The re-validation is a single query that RLS already governs: the signed-in user can read
 * their own memberships and nothing else. So "is this still true?" is answered by the same
 * policy that answers everything else in this application, not by a check of our own.
 *
 * WHY A STALE COOKIE DOES NOT FALL BACK. With no cookie at all, a user in exactly one
 * organization resolves to it - unambiguous, and it means a fresh login lands somewhere
 * useful. With several, there is no correct answer and the result is null. But a cookie
 * that WAS present and no longer resolves never falls back: the user chose, that choice
 * died, and silently moving them into a different clinic is worse than asking them again.
 */
import type { PermissionKey } from "../permissions/registry";
import { UnauthorizedError } from "../errors";
import { readActiveOrgId, writeActiveOrgId } from "./session";
import { createServerClient } from "../supabase/server";

/** Everything the UI needs to render a tenant, and nothing it does not. */
export interface ActiveOrg {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  locale: string;
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
 * The organization the user is acting in, or null.
 *
 * Null means: signed out, or belonging to nothing, or the chosen organization is no longer
 * one they belong to, or the choice is ambiguous. All four are "do not assume a tenant", and
 * Task 17 renders that state.
 */
export async function getActiveOrg(): Promise<ActiveOrg | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const cookieOrgId = await readActiveOrgId();

  // One query answers "which orgs may this user act in", and RLS decides the rows. An
  // organization the user was removed from is simply absent from the result - which is why
  // this cannot be fooled by a stale or forged cookie.
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, organizations(id, name, slug, timezone, currency, locale, status)")
    .eq("user_id", user.id);

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

/** As `getActiveOrg`, for callers that cannot proceed without a tenant. */
export async function requireActiveOrg(): Promise<ActiveOrg> {
  const org = await getActiveOrg();
  if (!org) {
    throw new UnauthorizedError("No active organization. Choose one to continue.", "no_active_org");
  }
  return org;
}

/**
 * Record the user's organization choice.
 *
 * Writes the cookie only. Membership is re-validated on every read, so an id the user does
 * not belong to resolves to null on the next page load.
 */
export async function setActiveOrg(orgId: string): Promise<void> {
  await writeActiveOrgId(orgId);
}

/**
 * Whether the current user holds a permission in the active organization.
 *
 * DELIBERATELY NOT `hasPermission`. Task 3 already owns a pure `hasPermission(roles,
 * permission)` over an in-memory role list, and two different signatures under one name is a
 * bug waiting to happen at every call site.
 *
 * THIS IS ADVISORY, NOT ENFORCEMENT. It exists so a UI can hide a control the user cannot
 * use. It must never gate access, because it is answerable from the client side and RLS is
 * the real boundary - see the Task 5 ruling on there being no unforgeable service-role check.
 * A `false` here does not stop a request; an RLS policy does.
 *
 * Note the consequence: because the permission set comes from `role_permissions` rows the
 * user can themselves read, this reflects the DATABASE, including anything a platform admin
 * changed since the app shipped. It does not consult a compiled-in list.
 */
export async function userCan(permission: PermissionKey): Promise<boolean> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const org = await getActiveOrg();
  if (!org) return false;

  const { data: assignments, error: assignmentError } = await supabase
    .from("user_role_assignments")
    .select("role_id")
    .eq("user_id", user.id)
    .eq("organization_id", org.id);
  if (assignmentError) return false;

  const roleIds = [...new Set((assignments ?? []).map((row) => row.role_id as string))];
  if (roleIds.length === 0) return false;

  const { data: granted, error: grantError } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .in("role_id", roleIds);
  if (grantError) return false;

  return (granted ?? []).some((row) => row.permission_key === permission);
}
