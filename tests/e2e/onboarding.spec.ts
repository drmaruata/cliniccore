import { expect, test } from "@playwright/test";

import { admin } from "../helpers/auth-session-fixture";
import { cleanupProbe, newProbeCleanup } from "../helpers/e2e-cleanup";
import { signIn, hasSession } from "../helpers/e2e-sign-in";

/**
 * The zero-membership path: what a user with no organization sees, and what happens
 * when the clinic address they want is already taken.
 *
 * WHY EVERY TEST CREATES ITS OWN ACCOUNT. The provider's public signup endpoint is
 * rate limited to about two or three calls a window, so the accounts are created
 * through the ADMIN API, which is not rate limited. Each test creates its own, so no
 * test depends on another having run first - the suite runs its tests in parallel.
 *
 * WHY THE CLEANUP DELETES CHILDREN BEFORE PARENTS, AND VERIFES ITSELF. An
 * organization with a clinic, a membership and roles under it does not go away on a
 * plain delete in every state of this schema, and a probe tenant left behind in a live
 * clinic system is a finding. The helper in tests/helpers/e2e-cleanup.ts also removes
 * the audit rows - `audit_logs` carries NO foreign keys on purpose - and re-counts
 * what it removed, so a silent leak fails the test that caused it.
 */

const PASSWORD = "Pr0be-Passw0rd!x";
const TAKEN_SLUG = "taken-slug";

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

test.describe("Onboarding", () => {
  test("a user with no organization is offered the onboarding screen, and a taken clinic address is refused inline", async ({
    page,
  }) => {
    const user = await createProbeUser("onboarding");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    // The tenant that already owns the slug the form is about to be given.
    const { error: seedError } = await admin()
      .from("organizations")
      .insert({ name: "Taken Slug Clinic", slug: TAKEN_SLUG });
    if (seedError) throw new Error(`could not seed the taken slug: ${seedError.message}`);
    probe.slugs.push(TAKEN_SLUG);

    // 1. The zero-membership path. `/app` renders the onboarding screen: a real screen,
    //    not a crash and not a redirect loop - the URL is still `/app` afterwards.
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/app");

    // 2. A slug that is already taken. The failure must be a friendly message in the
    //    form, and NOT a 500: the response listener is attached before the submit, so
    //    it sees the server action's own response.
    const serverErrors: number[] = [];
    page.on("response", (response) => {
      if (response.status() >= 500) serverErrors.push(response.status());
    });

    await page.fill('input[id="name"]', "Probe Onboarding Clinic");
    await page.fill('input[id="slug"]', TAKEN_SLUG);
    await page.getByRole("button", { name: "Create organization" }).click();

    await expect(
      page.getByText("That clinic address is already taken. Choose a different one."),
    ).toBeVisible();
    expect(serverErrors, "the refusal must not be a server error").toEqual([]);

    // And the refused attempt created NOTHING: no organization with the name that was
    // submitted, and the seeded tenant is still the only holder of the slug.
    const { count: created } = await admin()
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("name", "Probe Onboarding Clinic");
    expect(created).toBe(0);

    const { count: holders } = await admin()
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("slug", TAKEN_SLUG);
    expect(holders).toBe(1);
  });

  test("creating an organization lands on the dashboard with the organization's name", async ({
    page,
  }) => {
    const user = await createProbeUser("onboarding-create");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    const slug = `probe-clinic-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);

    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', "Probe Onboarding Clinic");
    await page.fill('input[id="slug"]', slug);
    await page.getByRole("button", { name: "Create organization" }).click();

    await expect(page).toHaveURL(/\/app\/dashboard$/);
    // The organization name, read from the database, and not a placeholder.
    await expect(page.getByRole("heading", { name: "Probe Onboarding Clinic" })).toBeVisible();
  });

  test("the shell's sign-out control ends the session", async ({ page }) => {
    // The shell's own control, and the one control Task 15 had to fake - Task 15
    // cleared the cookies by hand because there was no button to click. The shell only
    // exists for a user with a tenant, so this account creates one first.
    const user = await createProbeUser("sign-out");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    const slug = `probe-signout-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);
    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', "Probe Sign Out Clinic");
    await page.fill('input[id="slug"]', slug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    // The session is gone, and not merely redirected.
    expect(await hasSession(page)).toBe(false);
  });
});
