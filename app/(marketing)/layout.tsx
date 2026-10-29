import type { Metadata } from "next";

import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";

/**
 * The public shell: a header, the page, and a footer.
 *
 * WHY THE DIRECTORY IS A ROUTE GROUP. The marketing pages sit at the ROOT of the url
 * space - `/` today, and `/features`, `/pricing` and the rest in a later phase - and a
 * route group is pathless, so `(marketing)` adds no segment. The group exists so this
 * shell can own a header and a footer without the signed-in application or the operator
 * console inheriting them.
 *
 * WHY IT IS A SERVER COMPONENT AND READS NOTHING. The page is public, so it must not ask
 * who is looking: a header or a hero that changed for a signed-in visitor would disclose
 * that somebody is signed in. There is no session read anywhere in this group.
 */
export const metadata: Metadata = {
  title: {
    default: "ClinicCore - multi-tenant clinic management",
    template: "%s | ClinicCore",
  },
  description:
    "ClinicCore is a modern, secure and flexible platform for clinic teams: organisation management, role-based access and row-level tenant isolation.",
};

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
