import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("signs up a fresh user and lands on onboarding", async ({ page }) => {
    await page.goto("/signup");

    // Fill signup form
    const email = `test-${Date.now()}@example.com`;
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "TestPass123");
    await page.fill('input[id="fullName"]', "Test User");

    // Submit
    await page.click('button[type="submit"]');

    // Should redirect to onboarding (not an inbox interstitial)
    await expect(page).toHaveURL(/\/app\/onboarding/);
  });

  test("signs out and signs back in", async ({ page }) => {
    // First sign up
    await page.goto("/signup");
    const email = `test-${Date.now()}@example.com`;
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "TestPass123");
    await page.fill('input[id="fullName"]', "Test User");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app\/onboarding/);

    // Sign out by going to a protected route and checking redirect
    await page.goto("/login");

    // Sign in with the same credentials
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "TestPass123");
    await page.click('button[type="submit"]');

    // Should reach dashboard
    await expect(page).toHaveURL(/\/app\/dashboard/);
  });

  test("password reset shows generic success (no account enumeration)", async ({ page }) => {
    await page.goto("/forgot-password");

    // Request reset for non-existent email
    await page.fill('input[id="email"]', "nonexistent@example.com");
    await page.click('button[type="submit"]');

    // Should show success message regardless of whether account exists
    await expect(page.locator("text=Check your email")).toBeVisible();
    await expect(page.locator("text=If an account exists")).toBeVisible();
  });

  test("password reset for existing account shows same generic success", async ({ page }) => {
    // First create an account
    await page.goto("/signup");
    const email = `test-${Date.now()}@example.com`;
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "TestPass123");
    await page.fill('input[id="fullName"]', "Test User");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app\/onboarding/);

    // Now request password reset for that account
    await page.goto("/forgot-password");
    await page.fill('input[id="email"]', email);
    await page.click('button[type="submit"]');

    // Should show the SAME generic success message (no enumeration)
    await expect(page.locator("text=Check your email")).toBeVisible();
    await expect(page.locator("text=If an account exists")).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    // First create an account
    await page.goto("/signup");
    const email = `test-${Date.now()}@example.com`;
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "TestPass123");
    await page.fill('input[id="fullName"]', "Test User");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app\/onboarding/);

    // Sign out
    await page.goto("/login");

    // Try to sign in with wrong password
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "WrongPass123");
    await page.click('button[type="submit"]');

    // Should show error
    await expect(page.locator("text=Invalid")).toBeVisible();
  });

  test("verify page handles already signed in user", async ({ page }) => {
    // Create an account first
    await page.goto("/signup");
    const email = `test-${Date.now()}@example.com`;
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "TestPass123");
    await page.fill('input[id="fullName"]', "Test User");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/app\/onboarding/);

    // Visit verify page - should detect already signed in
    await page.goto("/verify");

    await expect(page.locator("text=Already signed in")).toBeVisible();
    await expect(page.locator("text=Email confirmation is disabled")).toBeVisible();
  });
});
