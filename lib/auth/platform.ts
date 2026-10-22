import "server-only";

/**
 * The platform console's data access, and the gate in front of it.
 *
 * WHY THE PREDICATE IS ASKED OF THE DATABASE. `private.is_platform_admin()` owns the
 * rule, and `public.is_platform_admin()` exposes it because PostgREST serves the `public`
 * schema only - MEASURED: a POST to `/rest/v1/rpc/<fn>` naming a `private.*` function
 * answers PGRST202 naming `public` as the schema it searched. Deciding the question in
 * TypeScript instead would put the rule in the application as well as in the database, and
 * this repository has already been bitten twice by a rule that lived in two places.
 *
 * WHY A LAYOUT CHECK IS NOT ENOUGH. Next.js's own authentication guide is explicit: a
 * layout does not control whether the rest of the route renders, and layouts do not
 * re-render on client-side navigation, so a check there is not per-navigation. The
 * layout's `notFound()` produces the 404 RESPONSE; this module is the DATA-LAYER check,
 * and it refuses to read the tenant directory for a caller who is not a platform
 * administrator - which is what makes the gate a gate rather than a hidden panel.
 *
 * WHY THE DIRECTORY IS READ BY A DEFINER. `organization_memberships_select`'s row filter
 * is `private.is_member(organization_id)`, so a platform operator - who belongs to no
 * tenant - sees NO membership rows for anybody. A member count taken from an ordinary
 * read would be zero for every tenant, including the ones the operator exists to inspect.
 * The E2E spec proves the count is the real one: the operator it signs in as is not a
 * member of the tenant it reads.
 */
import { cache } from "react";

import { createServerClient } from "../supabase/server";

/** One tenant, as the platform console shows it. */
export interface TenantEntry {
  name: string;
  status: string;
  memberCount: number;
}

/**
 * Whether the calling user is a platform administrator.
 *
 * FAIL CLOSED: an unreachable database is not an answer, and `true` would open the
 * console. Memoised with React's `cache`, so the layout's check and the page's check
 * share one round trip inside a request - and nothing is shared between requests.
 */
export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  if (error) return false;
  return data === true;
});

/**
 * The tenant directory, or null when the caller may not have it.
 *
 * The three fields are the only things the console shows, and they are the only things
 * the query can return: the RPC's signature is the boundary, so no patient record is
 * reachable from this route even by accident.
 */
export async function readTenantDirectory(): Promise<TenantEntry[] | null> {
  if (!(await isPlatformAdmin())) return null;

  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("tenant_directory");
  if (error) throw error;

  return (data ?? []).map((row) => ({
    name: row.name,
    status: row.status,
    memberCount: row.member_count,
  }));
}
