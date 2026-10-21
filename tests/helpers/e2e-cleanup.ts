import { admin } from "./auth-session-fixture";

/**
 * Removing what a probe created from the LIVE project.
 *
 * WHY THIS IS A HELPER. Two specs create tenants, staff and invitations in a real
 * clinic system, and a probe left behind is a finding - not a nuisance. The rules are
 * fiddly enough that two copies would drift: children before parents, the audit trail
 * by hand because it has no foreign keys, and the creation ledger because nothing
 * cascades it either.
 *
 * WHY THE CLEANUP VERIFIES ITSELF. A cleanup that silently fails leaves the rows
 * behind and reports success, which is the worst of both: the suite is green and the
 * database is dirty. So the last step re-counts everything this helper was asked to
 * remove and THROWS if anything survived - the failure then belongs to the test that
 * caused it.
 */

export interface ProbeCleanup {
  /** The slugs of the organizations the probe created. */
  slugs: string[];
  /** The ids of the accounts the probe created. */
  userIds: string[];
}

/** An empty tracker. Callers push to it as they create things. */
export function newProbeCleanup(): ProbeCleanup {
  return { slugs: [], userIds: [] };
}

export async function cleanupProbe(probe: ProbeCleanup): Promise<void> {
  const client = admin();
  const orgIds: string[] = [];

  for (const slug of probe.slugs) {
    const { data: orgs, error: selectError } = await client
      .from("organizations")
      .select("id")
      .eq("slug", slug);
    if (selectError) throw new Error(`cleanup could not read ${slug}: ${selectError.message}`);

    for (const org of orgs ?? []) {
      orgIds.push(org.id);
      // Children before parents: the organization is the parent of all of these.
      await client.from("user_role_assignments").delete().eq("organization_id", org.id);
      await client.from("organization_memberships").delete().eq("organization_id", org.id);
      await client.from("invitations").delete().eq("organization_id", org.id);
      await client.from("clinics").delete().eq("organization_id", org.id);
      await client.from("organizations").delete().eq("id", org.id);
      // The audit trail carries NO foreign keys, so nothing removes these for us.
      await client.from("audit_logs").delete().eq("organization_id", org.id);
    }
  }

  for (const userId of probe.userIds) {
    // The creation ledger has no foreign keys either, so it survives the account.
    const { error: ledgerError } = await client
      .from("tenant_creation_events")
      .delete()
      .eq("user_id", userId);
    if (ledgerError) {
      throw new Error(`cleanup could not clear the creation ledger: ${ledgerError.message}`);
    }
    const { error } = await client.auth.admin.deleteUser(userId);
    if (error && !/not found/i.test(error.message)) {
      throw new Error(`cleanup failed for ${userId}: ${error.message}`);
    }
  }

  // The verification. A leftover row is a finding, and it fails the test that made it.
  for (const slug of probe.slugs) {
    const { count } = await client
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("slug", slug);
    if (count !== 0) {
      throw new Error(`cleanup left ${count} organization(s) with the slug ${slug}`);
    }
  }
  for (const orgId of orgIds) {
    const { count: audits } = await client
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    if (audits !== 0) {
      throw new Error(`cleanup left ${audits} audit row(s) for the organization ${orgId}`);
    }
  }
  for (const userId of probe.userIds) {
    const { count: events } = await client
      .from("tenant_creation_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (events !== 0) {
      throw new Error(`cleanup left ${events} creation event(s) for the account ${userId}`);
    }
  }
}
