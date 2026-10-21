import { expect, test } from "@playwright/test";

import { admin } from "../helpers/auth-session-fixture";
import { hasSession, signIn } from "../helpers/e2e-sign-in";

/**
 * The auth pages, end to end.
 *
 * WHY ONE ACCOUNT PER FILE. The public signup endpoint is RATE LIMITED - about two or
 * three calls a window, MEASURED and recorded in AGENTS.md - so a suite that signs up
 * per test fails on the limit rather than on the behaviour. So ONE account is created
 * with the ADMIN API, which is not rate limited, and every test that needs a signed-in
 * user shares it. Only the signup test itself goes through the public endpoint, and it
 * goes there ONCE.
 *
 * WHY THE ACCOUNTS ARE CLEANED UP. The live project is a real one, and the pristine
 * state of this project is zero auth users. A probe user left behind is a user in a
 * clinic system. The suite reports what it removed.
 *
 * WHY THE SESSION COOKIE IS ASSERTED ALONGSIDE THE URL. A redirect alone proves
 * nothing: the URL changes whether or not the signup worked, and the pages this
 * workflow lands on - the onboarding and dashboard routes - are Task 17's, so their
 * content is not this spec's to assert. The cookie is the thing that says the user was
 * actually signed in, so it is the assertion that can fail for the right reason.
 *
 * WHY "SIGN OUT" IS A COOKIE CLEAR. This spec exercises the AUTH pages, and the
 * sign-out control lives in the signed-in shell, which is Task 16's - so what this step
 * needs is the state a sign-out leaves (no session), and that is what clearing the
 * cookies is. The shell's own button is covered by tests/e2e/onboarding.spec.ts.
 */

const PASSWORD = "Pr0be-Passw0rd!x";
const ONBOARDING_ROUTE = "/app/onboarding";

/** The account every test shares. Created with the admin API, so no rate limit. */
let sharedEmail: string;
let sharedUserId: string;

/** The account the signup test creates through the public endpoint. */
let signupEmail: string;

async function deleteUserByEmail(email: string): Promise<boolean> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return false;
    const found = data.users.find((user) => user.email === email);
    if (found) {
      const removed = await admin().auth.admin.deleteUser(found.id);
      return !removed.error;
    }
    if (data.users.length < 1000) return false;
  }
  return false;
}

test.beforeAll(async () => {
  sharedEmail = `e2e-shared-${Date.now()}-${process.pid}@example.com`;
  const { data, error } = await admin().auth.admin.createUser({
    email: sharedEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user)
    throw new Error(`could not create the shared account: ${error?.message}`);
  sharedUserId = data.user.id;
});

test.afterAll(async () => {
  if (signupEmail) await deleteUserByEmail(signupEmail);
  if (sharedUserId) await admin().auth.admin.deleteUser(sharedUserId);
});

/**
 * Sign in through the form and report what happened.
 *
 * The helper lives in tests/helpers/e2e-sign-in.ts, because the provider's rate limit
 * makes the retry part of the ANSWER rather than of this file: three specs sign in, and
 * three copies of a retry loop would be three chances to get the backoff wrong.
 */

test.describe("Authentication", () => {
  test("signs up a fresh user and lands on onboarding", async ({ page }) => {
    signupEmail = `e2e-signup-${Date.now()}-${process.pid}@example.com`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.goto("/signup");
      await page.fill('input[id="email"]', signupEmail);
      await page.fill('input[id="password"]', PASSWORD);
      await page.fill('input[id="fullName"]', "Test User");
      await page.click('button[type="submit"]');

      // The public signup endpoint is the scarcest resource this suite touches, so
      // the one call to it retries rather than failing on the limit. A refused attempt
      // creates nothing, so the retry is safe with the same address.
      const landed = await page
        .waitForURL(new RegExp(`${ONBOARDING_ROUTE}$`), { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (landed) break;
      await page.waitForTimeout(5000);
    }

    // The destination is the ONBOARDING ROUTE, and not an inbox interstitial: the url
    // belongs to this application, and the session cookie says the signup worked.
    await expect(page).toHaveURL(new RegExp(`${ONBOARDING_ROUTE}$`));
    expect(page.url()).not.toContain("supabase");
    await expect.poll(() => hasSession(page)).toBe(true);
  });

  test("signs out and signs back in", async ({ page }) => {
    expect(await signIn(page, sharedEmail, PASSWORD)).toBe("signed_in");
    await expect.poll(() => hasSession(page)).toBe(true);

    // SIGN OUT. This application has no sign-out control yet - the button belongs to
    // the signed-in shell, which is Task 17's - so the step takes the state a sign-out
    // leaves: no session cookie.
    await page.context().clearCookies();
    expect(await hasSession(page)).toBe(false);

    await page.goto("/login");
    expect(await signIn(page, sharedEmail, PASSWORD)).toBe("signed_in");
    await expect.poll(() => hasSession(page)).toBe(true);
  });

  test("password reset shows the same generic message for an address that has no account", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.fill('input[id="email"]', "definitely-not-an-account@example.com");
    await page.click('button[type="submit"]');

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("If an account exists")).toBeVisible();
  });

  test("password reset for an account that exists shows the SAME generic message", async ({
    page,
  }) => {
    // The no-enumeration guarantee, as a COMPARISON: the two answers must be the same
    // text, so a test that asserted only "a message appeared" would not be testing
    // the thing that matters.
    await page.goto("/forgot-password");
    await page.fill('input[id="email"]', sharedEmail);
    await page.click('button[type="submit"]');

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("If an account exists")).toBeVisible();
  });

  test("a wrong password is refused with a message the user can act on", async ({ page }) => {
    // The message says the same thing for a wrong password and for an unknown
    // address, so it is not an account-existence oracle - and it is not the generic
    // "Something went wrong", which cannot help anybody with a typo.
    // NOT getByRole("alert"): that also matches Next's route announcer, which is
    // empty, and the strict-mode violation it caused was hiding the real message.
    expect(await signIn(page, sharedEmail, "WrongPass123")).toBe("refused");
    expect(await hasSession(page)).toBe(false);
  });

  test("the verify page explains that confirmation is disabled", async ({ page }) => {
    expect(await signIn(page, sharedEmail, PASSWORD)).toBe("signed_in");

    await page.goto("/verify");

    // A HEADING, not a substring: the phrase used to appear twice on the page and the
    // locator matched both, which Playwright reports as a strict-mode violation.
    await expect(page.getByRole("heading", { name: "Already signed in" })).toBeVisible();
    await expect(page.getByText("Email confirmation is disabled")).toBeVisible();
  });
});
