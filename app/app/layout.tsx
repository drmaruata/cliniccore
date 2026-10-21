import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ClinicSwitcher } from "@/components/app/clinic-switcher";
import { OrgSwitcher } from "@/components/app/org-switcher";
import { SidebarNav } from "@/components/app/sidebar-nav";
import { Button } from "@/components/ui/button";
import { getActiveOrg, listMemberOrgs, userCan } from "@/lib/auth/active-org";
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
