import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { getUser } from "@/lib/supabase/server";
import { AcceptInvitationButton } from "./accept-button";

/**
 * The invitation page: the link an invited colleague opens. It lives OUTSIDE the
 * signed-in shell, because the invitee may not be signed in yet and the shell renders
 * the application for a user who already belongs to a tenant.
 *
 * WHY THE ORGANIZATION IS NOT NAMED HERE. The `invitations` table is readable only by a
 * holder of `staff.manage` in the organization that owns it, and the person opening
 * this link is not one - they are not a member yet. Naming the organization on this
 * page would need a second read path for a row that is deliberately private, and the
 * token is the credential. So the page says what is true without naming the tenant,
 * and the organization becomes visible on the dashboard the moment the invitation is
 * accepted.
 *
 * WHY THE PAGE SENDS NO REFERER. The invitation token is in the URL, and the URL is
 * what a browser sends in the `Referer` header to anywhere else this page links to.
 * `no-referrer` stops that. The token is still in the URL itself - and therefore in
 * the browser's history and in any access log - because the plan's contract is
 * `/invite/<token>`; that residual is recorded rather than papered over.
 */
export const metadata: Metadata = {
  title: "Invitation | ClinicCore",
  referrer: "no-referrer",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getUser();

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-6">
        <h1 className="font-heading text-xl font-semibold text-brand-navy">
          You have been invited to ClinicCore
        </h1>

        {user ? (
          <>
            <p className="text-sm text-muted-foreground">
              Accepting joins you to the clinic that invited you, with the role the invitation
              names. The invitation was addressed to one account, so it has to be accepted while
              signed in as that account.
            </p>
            <AcceptInvitationButton token={token} />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Sign in first, then open this link again to accept the invitation. The invitation was
              addressed to a particular account, so it has to be accepted while signed in as that
              account.
            </p>
            <Button asChild variant="outline">
              <Link href="/login">Sign in</Link>
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
