import { expect, test } from "@playwright/test";

import { admin } from "../helpers/auth-session-fixture";
import { cleanupProbe, newProbeCleanup } from "../helpers/e2e-cleanup";
import { signIn } from "../helpers/e2e-sign-in";

/**
 * The platform console's gate, and the public shell it sits beside.
 *
 * WHY EVERY TEST CREATES ITS OWN ACCOUNTS. The provider's public signup endpoint is
 * rate limited to about two or three calls a window, so the accounts are created
 * through the ADMIN API, which is not rate limited. Each test creates its own, so no
 * test depends on another having run first - the suite runs its tests in parallel.
 *
 * WHY `is_platform_admin` IS SET THROUGH THE SERVICE ROLE AND NEVER FROM THE BROWSER.
 * `private.guard_platform_admin()` refuses any change to the column unless the statement
 * came from the service role, and `profiles_update_self` refuses it in the policy as
 * well. So the flag is the one thing in this schema that a user cannot give themselves,
 * and a test that set it from the browser would be testing a path the product forbids.
 *
 * WHY THE OPERATOR IS NOT A MEMBER OF THE TENANT IT READS. The member count in the
 * directory is the interesting number: `organization_memberships_select` shows a
 * membership only to a member of that organization, so an operator who belonged to the
 * tenant would see the count whether the query were RLS-governed or not. The operator
 * here belongs to nothing, so a count of one is evidence that the count was taken by the
 * definer and not filtered away.
 */
const PASSWORD = "Pr0be-Passw0rd!x";
/**
 * TWO TENANT NAMES, BECAUSE THE TESTS RUN IN PARALLEL.
 *
 * The suite is fully parallel, so the owner test's tenant and the operator test's tenant
 * exist at the same time - and a shared name would put two rows in the directory, which
 * is not what either assertion is about.
 */
const OWNER_TENANT_NAME = "Probe Owner Clinic";
const DIRECTORY_TENANT_NAME = "Probe Platform Tenant";
/**
 * A THIRD TENANT, WHICH THE OWNER DOES NOT BELONG TO.
 *
 * The refused page has to be shown to contain NO tenant - not the caller's own and not
 * somebody else's. Asserting only the caller's own tenant would pass for a console that
 * leaked every OTHER tenant and none of the caller's, so the owner test seeds a tenant
 * it has no membership in and asserts that one is absent too.
 */
const FOREIGN_TENANT_NAME = "Probe Foreign Tenant";

/** What this worker created. The suite runs its tests in parallel, so it is per worker. */
const probe = newProbeCleanup();

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

test.describe("the marketing shell", () => {
  test("the public root renders without a session, and says nothing about a signed-in visitor", async ({
    page,
  }) => {
    const anonymous = await page.goto("/");
    expect(anonymous?.status()).toBe(200);
    // The hero leads with the platform promise. An earlier revision pinned "Every
    // organization is its own isolated workspace", which was corrected on 2026-10-22;
    // the 2026-10-28 redesign moved that fact onto the feature grid ("Tenant
    // isolation") because the brief wanted the hero to lead with the promise, not the
    // architecture. The grid heading is pinned so the reference design's four cards
    // cannot silently lose the section.
    await expect(page.getByRole("heading", { name: /Simplify clinic operations/ })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "A secure and flexible platform for modern clinics" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Get started" }).first()).toBeVisible();

    // And the same page for a signed-in visitor. A public shell that changed for a
    // signed-in user would disclose that somebody is signed in, which is a fact the
    // marketing page has no business holding.
    const user = await createProbeUser("marketing");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});

test.describe("the platform console", () => {
  test("a clinic owner is refused the console and sees no tenant directory", async ({ page }) => {
    const owner = await createProbeUser("platform-owner");
    expect(await signIn(page, owner.email, PASSWORD)).toBe("signed_in");

    // A real clinic owner: an organization, with the owner as a member of it.
    const slug = `probe-platform-owner-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);
    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', OWNER_TENANT_NAME);
    await page.fill('input[id="slug"]', slug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // And a tenant the owner does NOT belong to, so "no tenant at all" has teeth: a
    // console that leaked other tenants and not the caller's own would still fail.
    const foreignSlug = `probe-platform-foreign-${Date.now()}-${process.pid}`;
    probe.slugs.push(foreignSlug);
    const { error: foreignError } = await admin()
      .from("organizations")
      .insert({ name: FOREIGN_TENANT_NAME, slug: foreignSlug });
    if (foreignError) {
      throw new Error(`could not seed the foreign tenant: ${foreignError.message}`);
    }

    const response = await page.goto("/platform");
    expect(response?.status(), "the console must not answer a clinic owner").toBe(404);
    await expect(page.getByRole("heading", { name: "Tenants" })).toHaveCount(0);
    // No directory at all - not the owner's own tenant, and not anybody else's.
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByText(OWNER_TENANT_NAME)).toHaveCount(0);
    await expect(page.getByText(FOREIGN_TENANT_NAME)).toHaveCount(0);
  });

  test("a platform administrator reads the tenant directory", async ({ page }) => {
    const operator = await createProbeUser("platform-admin");
    const member = await createProbeUser("platform-member");

    // The flag, through the service role - the only door into it.
    const { error: flagError } = await admin()
      .from("profiles")
      .update({ is_platform_admin: true })
      .eq("id", operator.id);
    if (flagError) throw new Error(`could not set the platform flag: ${flagError.message}`);

    // A tenant with one member, who is NOT the operator.
    const slug = `probe-platform-tenant-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);
    const { data: org, error: orgError } = await admin()
      .from("organizations")
      .insert({ name: DIRECTORY_TENANT_NAME, slug })
      .select("id")
      .single();
    if (orgError || !org) throw new Error(`could not seed the tenant: ${orgError?.message}`);
    const { error: membershipError } = await admin()
      .from("organization_memberships")
      .insert({ organization_id: org.id, user_id: member.id, status: "active" });
    if (membershipError) {
      throw new Error(`could not seed the membership: ${membershipError.message}`);
    }

    expect(await signIn(page, operator.email, PASSWORD)).toBe("signed_in");

    const response = await page.goto("/platform");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Tenants" })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: DIRECTORY_TENANT_NAME });
    await expect(row).toBeVisible();
    await expect(row.getByText("Active")).toBeVisible();
    // The count is the definer's, not an RLS-filtered zero: the operator belongs to no
    // tenant, so a filtered read would have said zero.
    await expect(row.getByText("1", { exact: true })).toBeVisible();
  });
});
