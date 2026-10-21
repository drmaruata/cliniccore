import type { Page } from "@playwright/test";

import { AUTH_COOKIE } from "./auth-session-fixture";

/**
 * Signing in through the form, with the provider's rate limit taken into account.
 *
 * WHY THIS IS A HELPER AND NOT A COPY. Three specs need a signed-in browser, and the
 * provider's `signInWithPassword` is rate limited per project and per IP - so the
 * retry is not an optimisation, it is the difference between a suite that passes and a
 * suite that fails on somebody else's traffic.
 *
 * WHY THE OUTCOME IS A VALUE AND NOT A BOOLEAN. "signed in" and "refused" are two
 * DIFFERENT answers the application gives, and a caller has to be able to tell them
 * apart: a spec that asserts "the sign-in did not fail" proves nothing, because the
 * same value would be returned by a form that never submitted. So the helper reports
 * which answer it got, and "no_outcome" is a third, distinct value - the form did
 * neither, which is a failure of the page rather than of the credentials.
 */
export type SignInOutcome = "signed_in" | "refused" | "no_outcome";

const DASHBOARD_ROUTE = "/app/dashboard";

/**
 * Whether the browser holds a signed-in session.
 *
 * WHY THIS IS NOT THE SAME AS THE URL. A redirect proves nothing: the URL changes
 * whether or not the sign-in worked. The session cookie is the thing that says the
 * user was actually signed in, so it is the assertion that can fail for the right
 * reason.
 */
export async function hasSession(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies();
  return cookies.some((cookie) => cookie.name === AUTH_COOKIE && cookie.value.length > 0);
}

export async function signIn(page: Page, email: string, password: string): Promise<SignInOutcome> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto("/login");
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', password);
    await page.click('button[type="submit"]');

    const signedIn = page
      .waitForURL(new RegExp(`${DASHBOARD_ROUTE}$`), { timeout: 8000 })
      .then(() => "signed_in" as const)
      .catch(() => "no_redirect" as const);
    const refused = page
      .getByText("Invalid email or password.", { exact: true })
      .waitFor({ timeout: 8000 })
      .then(() => "refused" as const)
      .catch(() => "no_message" as const);

    const outcome = await Promise.race([signedIn, refused]);
    if (outcome === "signed_in" || outcome === "refused") return outcome;
    await page.waitForTimeout(5000);
  }
  return "no_outcome";
}
