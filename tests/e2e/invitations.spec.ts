import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

import { admin } from "../helpers/auth-session-fixture";
import { cleanupProbe, newProbeCleanup } from "../helpers/e2e-cleanup";
import { signIn } from "../helpers/e2e-sign-in";

/**
 * The invitation flow, end to end: an owner invites a colleague, the raw token is
 * never stored, the colleague accepts and gains the membership and the role, and the
 * two ways an invitation can be refused are both refused.
 *
 * WHY THE FIXTURES ARE SEEDED THROUGH THE SERVICE ROLE. The refusal scenarios need an
 * invitation that is already EXPIRED, which the product will not create - the owner
 * creates a live one. The service role writes it directly, and the acceptance path
 * under test is the product's own.
 *
 * WHY THE DIGEST IS COMPUTED HERE, IN THE TEST. The owner hashes the token in node and
 * the database hashes it again in `pg_catalog.sha256`, and the two must agree or every
 * invitation is unredeemable. The test computes the digest a THIRD time, independently,
 * and asserts the stored column against it - so a change to either side that broke the
 * agreement fails here rather than making the product quietly broken.
 */

const PASSWORD = "Pr0be-Passw0rd!x";

/** What this worker created. The suite runs its tests in parallel, so it is per worker. */
const probe = newProbeCleanup();

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function createProbeUser(prefix: string): Promise<{ id: string; email: string }> {
  const email = `e2e-${prefix}-${Date.now()}-${process.pid}-${Math.floor(
    Math.random() * 1e6,
  )}@example.com`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`could not create the probe account: ${error?.message}`);
  }
  probe.userIds.push(data.user.id);
  return { id: data.user.id, email };
}

test.afterEach(async () => {
  await cleanupProbe(probe);
  probe.slugs.length = 0;
  probe.userIds.length = 0;
});

test.describe("Invitations", () => {
  test("an owner invites a colleague, the raw token is never stored, and the invitee gains the membership and the role", async ({
    page,
  }) => {
    const owner = await createProbeUser("invite-owner");
    expect(await signIn(page, owner.email, PASSWORD)).toBe("signed_in");

    // The colleague being invited. The invitation is addressed to an ACCOUNT, and the
    // acceptance compares that address with the acceptor's verified claim - so the
    // invitee's own address is the one the invitation has to name.
    const invitee = await createProbeUser("invite-invitee");

    const slug = `probe-invite-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);

    // The owner's own organization, created through the onboarding screen, so the
    // owner really is the owner.
    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', "Probe Inviting Clinic");
    await page.fill('input[id="slug"]', slug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // The invitation. The button is named rather than matched by `type="submit"`,
    // because the SHELL has a submit button too - the sign-out control - and it comes
    // first in the DOM.
    await page.goto("/app/settings/members");
    await page.fill('input[id="invite-email"]', invitee.email);
    await page.selectOption('select[id="invite-role"]', "doctor");
    await page.getByRole("button", { name: "Create invitation" }).click();

    // The link is DISPLAYED, because email delivery is not implemented.
    const link = page.getByText(/^https?:\/\/.*\/invite\/[0-9a-f]{64}$/);
    await expect(link).toBeVisible();
    const inviteUrl = (await link.innerText()).trim();
    const token = inviteUrl.slice(inviteUrl.indexOf("/invite/") + "/invite/".length);

    const { data: org } = await admin()
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .single();
    if (!org) throw new Error("the organization was not created");

    // THE RAW TOKEN IS NOT IN ANY COLUMN. The digest is in `token_hash`, and nothing
    // else holds the token itself.
    const { data: invitations, error: invitationsError } = await admin()
      .from("invitations")
      .select("*")
      .eq("organization_id", org.id);
    if (invitationsError) throw new Error(invitationsError.message);
    expect(invitations).toHaveLength(1);
    const invitation = invitations?.[0];
    expect(invitation?.token_hash).toBe(sha256(token));
    expect(invitation?.email).toBe(invitee.email);
    for (const [column, value] of Object.entries(invitation ?? {})) {
      expect(String(value), `the raw token must not appear in ${column}`).not.toContain(token);
    }

    // The invitee, signed in as a DIFFERENT user, redeems the link.
    expect(await signIn(page, invitee.email, PASSWORD)).toBe("signed_in");
    await page.goto(`/invite/${token}`);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // The membership, and the role assignment holding `doctor`.
    const { data: memberships } = await admin()
      .from("organization_memberships")
      .select("id")
      .eq("organization_id", org.id)
      .eq("user_id", invitee.id);
    expect(memberships).toHaveLength(1);

    const { data: assignments } = await admin()
      .from("user_role_assignments")
      .select("role_id")
      .eq("organization_id", org.id)
      .eq("user_id", invitee.id);
    expect(assignments).toHaveLength(1);

    const { data: role } = await admin()
      .from("roles")
      .select("key")
      .eq("id", assignments?.[0]?.role_id ?? "")
      .single();
    expect(role?.key).toBe("doctor");
  });

  test("an expired invitation is refused, and an accepted one cannot be used twice", async ({
    page,
  }) => {
    const invitee = await createProbeUser("invite-refusals");

    // A tenant with one role, seeded through the service role.
    const slug = `probe-refusal-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);
    const { data: org, error: orgError } = await admin()
      .from("organizations")
      .insert({ name: "Probe Refusal Clinic", slug })
      .select("id")
      .single();
    if (orgError || !org) throw new Error(`could not seed the tenant: ${orgError?.message}`);

    const { data: role, error: roleError } = await admin()
      .from("roles")
      .insert({ organization_id: org.id, key: "doctor", name: "Doctor" })
      .select("id")
      .single();
    if (roleError || !role) throw new Error(`could not seed the role: ${roleError?.message}`);

    // 1. An invitation that has ALREADY EXPIRED.
    const expiredToken = "e".repeat(64);
    const { error: expiredError } = await admin()
      .from("invitations")
      .insert({
        organization_id: org.id,
        email: invitee.email,
        role_id: role.id,
        token_hash: sha256(expiredToken),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        invited_by: invitee.id,
      });
    if (expiredError) throw new Error(expiredError.message);

    expect(await signIn(page, invitee.email, PASSWORD)).toBe("signed_in");

    await page.goto(`/invite/${expiredToken}`);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page.getByText("That invitation cannot be used")).toBeVisible();

    // 2. An invitation that is LIVE, accepted once and then presented again.
    const liveToken = "b".repeat(64);
    await admin()
      .from("invitations")
      .insert({
        organization_id: org.id,
        email: invitee.email,
        role_id: role.id,
        token_hash: sha256(liveToken),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        invited_by: invitee.id,
      });

    await page.goto(`/invite/${liveToken}`);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    const { count: afterFirst } = await admin()
      .from("organization_memberships")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("user_id", invitee.id);
    expect(afterFirst).toBe(1);

    // The same link a second time is refused, and creates no second membership.
    await page.goto(`/invite/${liveToken}`);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page.getByText("That invitation cannot be used")).toBeVisible();

    const { count: afterSecond } = await admin()
      .from("organization_memberships")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("user_id", invitee.id);
    expect(afterSecond).toBe(1);
  });
});
