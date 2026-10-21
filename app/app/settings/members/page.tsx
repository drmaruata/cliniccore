import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getActiveOrg, userCan } from "@/lib/auth/active-org";
import { createServerClient } from "@/lib/supabase/server";
import { InviteForm } from "./invite-form";

/**
 * The members page: who is in this organization, what they may do, and - for a holder
 * of `staff.manage` - the form that invites somebody new.
 *
 * WHY THE NAMES ARE NOT SHOWN. `profiles` is readable only by its owner, and
 * `auth.users` is not readable by a client at all, so the roster can show a member's
 * identifier and nothing else. That is a limit of the current privacy model, not a
 * choice, and inventing a name column would mean showing a user id under a heading
 * that promises a name.
 *
 * WHY EVERY LIST HERE IS THE DATABASE'S ANSWER. The roster, the role assignments and
 * the pending invitations are each read under their own RLS policy, so this page shows
 * what the caller may see and nothing more - a member without `staff.manage` sees the
 * roster and their own roles, and no invitations at all.
 */
interface MembershipRow {
  id: string;
  user_id: string;
  status: string;
}

interface AssignmentRow {
  id: string;
  user_id: string;
  role_id: string;
  clinic_id: string | null;
}

interface InvitationRow {
  id: string;
  email: string;
  role_id: string;
  expires_at: string;
  accepted_at: string | null;
}

export default async function MembersPage() {
  const org = await getActiveOrg();
  if (!org) return null;

  const canManageStaff = await userCan("staff.manage");
  const supabase = await createServerClient();

  const [membershipsResult, assignmentsResult, rolesResult, invitationsResult, grantableResult] =
    await Promise.all([
      supabase
        .from("organization_memberships")
        .select("id, user_id, status")
        .eq("organization_id", org.id)
        .order("created_at"),
      supabase
        .from("user_role_assignments")
        .select("id, user_id, role_id, clinic_id")
        .eq("organization_id", org.id),
      supabase.from("roles").select("id, key, name").eq("organization_id", org.id),
      canManageStaff
        ? supabase
            .from("invitations")
            .select("id, email, role_id, expires_at, accepted_at")
            .eq("organization_id", org.id)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as InvitationRow[], error: null }),
      canManageStaff
        ? supabase.rpc("grantable_roles", { p_org_id: org.id })
        : Promise.resolve({
            data: [] as { role_id: string; role_key: string; role_name: string }[],
            error: null,
          }),
    ]);

  const memberships = (membershipsResult.data ?? []) as unknown as MembershipRow[];
  const assignments = (assignmentsResult.data ?? []) as unknown as AssignmentRow[];
  const roles = (rolesResult.data ?? []) as { id: string; key: string; name: string }[];
  const invitations = (invitationsResult.data ?? []) as unknown as InvitationRow[];
  const grantable = grantableResult.data ?? [];

  const roleName = new Map(roles.map((role) => [role.id, role.name]));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Members"
        description={`The people in ${org.name}, the roles they hold, and the invitations still open.`}
      />

      {canManageStaff && (
        <InviteForm
          roles={grantable.map((role) => ({ key: role.role_key, name: role.role_name }))}
        />
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Roster</h2>
        {memberships.length === 0 ? (
          <EmptyState title="No members yet" description="Nobody has joined this organization." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Roles</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memberships.map((membership) => {
                const held = assignments.filter(
                  (assignment) => assignment.user_id === membership.user_id,
                );
                return (
                  <TableRow key={membership.id}>
                    <TableCell className="font-mono text-xs">{membership.user_id}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{membership.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {held.length === 0
                        ? "—"
                        : held
                            .map(
                              (assignment) =>
                                `${roleName.get(assignment.role_id) ?? "Unknown role"}${
                                  assignment.clinic_id === null ? "" : " (one clinic)"
                                }`,
                            )
                            .join(", ")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {canManageStaff && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Invitations</h2>
          {invitations.length === 0 ? (
            <EmptyState
              title="No invitations"
              description="Nobody has been invited to this organization yet."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>{roleName.get(invitation.role_id) ?? "Unknown role"}</TableCell>
                    <TableCell>
                      {new Date(invitation.expires_at).toISOString().slice(0, 10)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={invitation.accepted_at ? "secondary" : "outline"}>
                        {invitation.accepted_at ? "Accepted" : "Pending"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
