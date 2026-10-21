import Link from "next/link";

import { Button } from "@/components/ui/button";
import { getUser } from "@/lib/supabase/server";
import { AcceptInvitationButton } from "./accept-button";

/**
 * The invitation page: the link an invited colleague opens.
 *
 * WHY THE ORGANIZATION IS NOT NAMED HERE. The `invitations` table is readable only by a
 * holder of `staff.manage` in the organization that owns it, and the person opening
 * this link is not one - they are not a member yet. Naming the organization on this
 * page would need a second read path for a row that is deliberately private, and the
 * token is the credential. So the page says what is true without naming the tenant,
 * and the organization becomes visible on the dashboard the moment the invitation is
 * accepted.
 *
 * WHY IT LIVES OUTSIDE THE SIGNED-IN SHELL. The invitee may not be signed in yet, and
 * the shell renders the application for a user who already belongs to a tenant.
 */
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
              names. If you already belong to that clinic, you will simply gain the role.
            </p>
            <AcceptInvitationButton token={token} />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Sign in first, then open this link again to accept the invitation.
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
