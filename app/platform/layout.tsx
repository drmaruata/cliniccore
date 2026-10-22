import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isPlatformAdmin } from "@/lib/auth/platform";

/**
 * The platform console's gate.
 *
 * WHY THIS DIRECTORY IS A REAL SEGMENT. The console lives at the URL PREFIX `/platform/`,
 * and in Next.js a ROUTE GROUP is pathless, so a group named `(platform)` would produce
 * `/` and collide with the marketing root page. The design spec's own route table says
 * the same thing in the same words for the application shell, and Task 16 already
 * implemented `/app/...` as `app/app/`. So the console is `app/platform/`.
 *
 * WHY A 404 AND NOT A REDIRECT. The console's existence is not something to advertise to
 * a caller who may not have it: a redirect would say "there is something here", and a
 * signed-in clinic owner has no business learning the shape of the operator's console.
 * `notFound()` also makes Next.js emit a `noindex` robots tag for the response.
 *
 * WHY THE CHECK IS REPEATED IN THE PAGE. A layout does not control whether the rest of
 * the route renders, and it does not re-render on client-side navigation, so the check
 * here is what produces the 404 RESPONSE - and the page's own data access refuses to
 * read the directory for an unauthorised caller, which is the boundary that matters.
 */
export const metadata: Metadata = {
  title: "Platform console",
  description: "ClinicCore operator console",
  robots: { index: false, follow: false },
};

export default async function PlatformLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (!(await isPlatformAdmin())) notFound();

  return (
    <div className="min-h-svh bg-muted/30">
      <header className="border-b border-border bg-background px-6 py-3">
        <p className="text-sm font-semibold text-foreground">ClinicCore platform console</p>
      </header>
      <main className="px-6 py-6">{children}</main>
    </div>
  );
}
