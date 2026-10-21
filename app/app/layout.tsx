/**
 * The signed-in application shell.
 *
 * WHY THIS DIRECTORY IS NAMED `app`, INSIDE `app`. The application lives at the URL
 * PREFIX `/app/` - `/app`, `/app/dashboard`, `/app/onboarding`, `/app/settings/members` -
 * and in Next.js a ROUTE GROUP is pathless, so a group named `(app)` would produce
 * `/dashboard`, not `/app/dashboard`. The prefix therefore has to be a REAL segment,
 * which means a real directory. The design spec's route table shows `(app)/ -> /app/...`,
 * and its own `(platform)/ -> /platform/...` row proves the parenthesised names there are
 * shorthand for a URL prefix rather than literal route groups: a pathless
 * `(platform)/page.tsx` would serve `/` and collide with the marketing root page.
 *
 * So: `app/app/` is the shape that satisfies the URL contract, and `app/app/` is the
 * only one that does.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ClinicSwitcher } from "@/components/app/clinic-switcher";
import { OrgSwitcher } from "@/components/app/org-switcher";
import { SidebarNav } from "@/components/app/sidebar-nav";
import { Button } from "@/components/ui/button";
import { getActiveOrg, hasAnyMembership, listMemberOrgs, userCan } from "@/lib/auth/active-org";
import { readActiveClinicId } from "@/lib/auth/session";
import { createServerClient, getClaims } from "@/lib/supabase/server";
import { signOut } from "./actions";
import { OnboardingPanel } from "./onboarding/panel";

export const metadata: Metadata = {
  title: {
    default: "ClinicCore",
    template: "%s | ClinicCore",
  },
  description: "Your clinic",
};

/**
 * The state a member of a suspended tenant is in: they belong to an organization, and
 * the database hides it from them.
 *
 * WHY IT IS NOT THE ONBOARDING SCREEN. The onboarding screen says "you belong to
 * nothing, create your organization" - and for a member of a suspended tenant that is
 * false, and the offer is a way to create a SECOND organization while the first is
 * suspended. The shell says what is true instead, and offers the way out: sign in as
 * somebody else.
 */
function SuspendedNotice() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-6">
        <h1 className="font-heading text-xl font-semibold text-brand-navy">
          Your access is not active
        </h1>
        <p className="text-sm text-muted-foreground">
          You belong to an organization, but your access to it is suspended - or the organization
          itself is. Your administrator can restore it. Until then there is nothing here for you to
          do.
        </p>
        <form action={signOut}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
}

/**
 * The signed-in application shell.
 *
 * THREE STATES, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT.
 *
 *  1. NO MEMBERSHIP AT ALL -> the onboarding screen. The user signed up and belongs to
 *     nothing, so there is no tenant to render and no shell to render it in. This is
 *     the plan's "zero-membership path", and it is a real screen, not a redirect loop
 *     and not a crash.
 *
 *  2. A MEMBERSHIP, BUT NO ACTIVE ORGANIZATION -> the picker. `getActiveOrg` answers
 *     null in two situations that are NOT "you belong to nothing": the user belongs to
 *     several organizations and has not chosen one, and the organization the cookie
 *     names is one they have left. The house rule is explicit that a stale cookie does
 *     NOT fall back to some other organization - the choice died, and silently moving
 *     the user into a different clinic is worse than asking again. So the shell asks.
 *     Rendering ONBOARDING in this state would be wrong: the user already belongs to a
 *     tenant, and offering to create another one is not what they need.
 *
 *  3. AN ACTIVE ORGANIZATION -> the shell.
 *
 * AND A FOURTH, WHICH IS NOT A BRANCH ABOVE BUT A REFINEMENT OF THE FIRST: the user
 * has a membership the ROW-LEVEL SECURITY hides - a suspended tenant, or a suspended
 * membership of their own. Their membership list is empty for that reason and not
 * because they belong to nothing, so the shell asks the database and, if the answer is
 * that they DO have a membership, says so instead of offering to create a tenant.
 *
 * WHY THE USER ID COMES FROM THE VERIFIED CLAIM AND NOT FROM getUser(). The id is used
 * to filter the membership lookup, and the result is governed by RLS either way, so
 * this is not a gate - it is a query filter. `getClaims` verifies the JWT locally, so
 * it costs no network round trip; `getUser` re-fetches from the auth server, and the
 * layout would otherwise pay for that three times over (once here, once inside
 * `getActiveOrg`, once inside `userCan`).
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // A broken or absent token means "not signed in", not an error page.
  const claims = await getClaims().catch(() => null);
  if (!claims) redirect("/login");
  const userId = claims.sub;

  const organizations = await listMemberOrgs(userId);

  if (organizations.length === 0) {
    // EITHER NO MEMBERSHIP AT ALL, OR MEMBERSHIPS THE RLS HIDES. A member of a
    // suspended tenant, and a member whose own membership is suspended, see no rows -
    // their membership row is filtered out - so an empty list does not mean "you belong
    // to nothing". The database can answer that, because a definer sees the rows the
    // policies hide, and offering the ONBOARDING screen to a member of a suspended
    // tenant would be offering them a second organization.
    if (await hasAnyMembership()) {
      return <SuspendedNotice />;
    }
    return <OnboardingPanel />;
  }

  const org = await getActiveOrg();
  if (!org) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-6">
          <h1 className="font-heading text-xl font-semibold text-brand-navy">
            Choose an organization
          </h1>
          <p className="text-sm text-muted-foreground">
            You belong to more than one organization, or the one you were using is no longer
            available to you. Choose the one to work in.
          </p>
          <OrgSwitcher organizations={organizations} activeOrgId={null} />
        </div>
      </main>
    );
  }

  const supabase = await createServerClient();
  const [{ data: clinicRows }, activeClinicId, canManageStaff] = await Promise.all([
    supabase.from("clinics").select("id, name").eq("organization_id", org.id).order("name"),
    readActiveClinicId(),
    userCan("staff.manage"),
  ]);

  const clinics = (clinicRows ?? []).map((clinic) => ({ id: clinic.id, name: clinic.name }));
  const activeClinicName = clinics.find((clinic) => clinic.id === activeClinicId)?.name ?? null;
  const navItems = [
    { href: "/app/dashboard", label: "Dashboard" },
    ...(canManageStaff ? [{ href: "/app/settings/members", label: "Members" }] : []),
  ];

  return (
    <div className="min-h-svh bg-muted/30">
      <div className="flex">
        <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r border-border bg-sidebar p-4 md:flex">
          <Link href="/app/dashboard" className="text-lg font-semibold text-foreground">
            ClinicCore
          </Link>
          <div className="space-y-3">
            <OrgSwitcher organizations={organizations} activeOrgId={org.id} />
            <ClinicSwitcher clinics={clinics} activeClinicId={activeClinicId} />
          </div>
          <SidebarNav items={navItems} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-border bg-background px-6 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {activeClinicName ?? "All clinics"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {org.slug} &middot; {org.timezone} &middot; {org.currency}
              </p>
            </div>
            <form action={signOut}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </header>
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
