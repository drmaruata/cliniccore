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

  test("the clinic switcher refuses a clinic from another organization", async ({ page }) => {
    // The user belongs to TWO organizations, and the shell only ever offers the
    // clinics of the ACTIVE one - so the other tenant's clinic has to be put into the
    // control by hand, which is exactly what a session-holder would do. The action has
    // to refuse it: the `clinics` SELECT policy spans every organization the user
    // belongs to, so a lookup by id alone would accept the other tenant's clinic,
    // and a cookie naming it becomes a cross-tenant filter the moment a clinical
    // screen reads it.
    const user = await createProbeUser("clinic-scope");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    const slugA = `probe-clinic-a-${Date.now()}-${process.pid}`;
    const slugB = `probe-clinic-b-${Date.now()}-${process.pid}`;
    probe.slugs.push(slugA, slugB);

    for (const [name, slug] of [
      ["Probe Clinic A", slugA],
      ["Probe Clinic B", slugB],
    ] as const) {
      await page.goto("/app/onboarding");
      await page.fill('input[id="name"]', name);
      await page.fill('input[id="slug"]', slug);
      await page.getByRole("button", { name: "Create organization" }).click();
      await expect(page).toHaveURL(/\/app\/dashboard$/);
    }

    // The ACTIVE organization is the second one. The first one's clinic is the one a
    // crafted request would name.
    const { data: clinicA } = await admin()
      .from("clinics")
      .select("id")
      .eq("name", "Probe Clinic A")
      .single();
    if (!clinicA) throw new Error("the first clinic was not created");

    await page.evaluate((clinicId) => {
      const select = document.querySelector<HTMLSelectElement>("#cc-clinic-switcher");
      if (!select) throw new Error("the clinic switcher is not on the page");
      const option = document.createElement("option");
      option.value = clinicId;
      option.textContent = "Probe Clinic A";
      select.appendChild(option);
      // The NATIVE setter, not `select.value = ...`: React tracks the value on the
      // node, and assigning through the tracked property makes React believe nothing
      // changed - so the change event would be swallowed and the action never called.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )?.set;
      setter?.call(select, clinicId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, clinicA.id);

    // The refusal, and the cookie is not written: the dashboard still reads "all
    // clinics", because the action refused before it could record a choice.
    await expect(page.getByText("You cannot reach that clinic.")).toBeVisible();
    await expect(page.getByText("Working in all clinics")).toBeVisible();
  });

  test("a member whose access is suspended is not offered a new organization", async ({ page }) => {
    // THE SHELL'S THIRD STATE. The memberships table hides a suspended membership from
    // its owner, so the shell's "you belong to nothing" branch would have offered
    // the ONBOARDING screen - "create your organization" - to a member the database
    // is hiding. The shell asks the database instead, and says what is true.
    const user = await createProbeUser("suspended");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    const slug = `probe-suspended-${Date.now()}-${process.pid}`;
    probe.slugs.push(slug);
    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', "Probe Suspended Clinic");
    await page.fill('input[id="slug"]', slug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // Suspend the member's own membership, the way an administrator would.
    const { error } = await admin()
      .from("organization_memberships")
      .update({ status: "suspended" })
      .eq("user_id", user.id);
    if (error) throw new Error(`could not suspend the membership: ${error.message}`);

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Your access is not active" })).toBeVisible();
    // And NOT the offer to create a second organization.
    await expect(page.getByRole("heading", { name: "Create your organization" })).toHaveCount(0);
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
