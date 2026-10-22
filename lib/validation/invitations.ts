/**
 * The request-body schema for the invitation form.
 *
 * WHY THE ROLE IS NOT ENUMERATED HERE. The roles a tenant can grant are the tenant's
 * own, they differ per organization, and which of them the CALLER may grant is a
 * privilege question that the database answers (`public.grantable_roles`, backed by
 * `private.can_assign_role`). A list of role keys baked into a schema would be a second
 * copy of that rule, and it would be a copy of the WRONG one: the registry's fifteen
 * roles are the platform's vocabulary, not a tenant's grantable set. So the schema checks
 * that a role was chosen, and the action resolves it against the database. The role the
 * form offers comes from the same database answer, so the two agree by construction.
 */
import { z } from "zod";

export const invitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  roleKey: z.string().trim().min(1, "Choose a role"),
});
export type InvitationInput = z.infer<typeof invitationSchema>;
