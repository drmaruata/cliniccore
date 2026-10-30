import { expect, test } from "@playwright/test";

import { admin } from "../helpers/auth-session-fixture";
import { cleanupProbe, newProbeCleanup } from "../helpers/e2e-cleanup";
import { signIn } from "../helpers/e2e-sign-in";

/**
 * Patient registration, archiving and tenant separation.
 *
 * WHY EVERY RUN CREATES ITS OWN ACCOUNT AND TENANT. The suite runs fully parallel against
 * a live project, and public signup is rate limited, so the account is created through the
 * admin API and the organization, clinic and patient carry a timestamp and process id. A
 * shared fixture would let one worker's patient appear in another worker's table.
 *
 * WHY THE IDENTIFIER ASSERTION READS THE DATABASE. The registration form does not collect
 * identifiers, and the detail page that now shows them is the Task 6 route. The only honest
 * check that none were written at registration is the row count in `patient_identifiers`
 * for the patient the form just created.
 *
 * WHY THE SECOND TENANT IS CREATED THROUGH ONBOARDING. `createOrganization` sets the active
 * organization cookie, so completing onboarding again is the product's own way to switch
 * tenants. The assertion is that the first tenant's patient is absent from the second
 * tenant's list - the explicit organization filter and RLS working together.
 *
 * WHY THE TEST IS MARKED SLOW. The detail route adds an action round trip on top of
 * registration, onboarding and the tenant switch, and two browsers share one server. The
 * tripled budget absorbs that latency without turning a hang into a passing test.
 */

const PASSWORD = "Pr0be-Passw0rd!x";

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

test.describe("Patients", () => {
  test("registers a patient with an MRN, archives it, and does not show it in another organization", async ({
    page,
  }) => {
    test.slow();
    const user = await createProbeUser("patients");
    expect(await signIn(page, user.email, PASSWORD)).toBe("signed_in");

    const stamp = `${Date.now()}-${process.pid}`;
    const firstOrgName = `Probe Patients Clinic ${stamp}`;
    const firstSlug = `probe-patients-${stamp}`;
    probe.slugs.push(firstSlug);

    // 1. A tenant of this run, created through the product's own onboarding.
    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', firstOrgName);
    await page.fill('input[id="slug"]', firstSlug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // 2. Register a patient. The only clinic is the one onboarding created, so the
    //    picker's default is the clinic the record belongs to.
    const firstName = "Ada";
    const lastName = `Okafor ${stamp}`;
    await page.goto("/app/patients/new");
    await page.fill('input[id="patient-first-name"]', firstName);
    await page.fill('input[id="patient-last-name"]', lastName);
    await page.fill('input[id="patient-date-of-birth"]', "1990-01-02");
    await page.selectOption('select[id="patient-sex"]', "female");
    await page.fill('input[id="patient-phone"]', "+15550001000");
    await page.fill('input[id="patient-email"]', `ada-${stamp}@example.com`);
    await page.getByRole("button", { name: "Register patient" }).click();

    // 3. The action redirects to the list, and the record number is the clinic's own.
    await expect(page).toHaveURL(/\/app\/patients$/);
    const mrnCell = page.getByRole("cell", { name: /^MRN-\d{6}$/ });
    await expect(mrnCell).toBeVisible();
    const mrn = (await mrnCell.textContent())?.trim() ?? "";
    expect(mrn).toMatch(/^MRN-\d{6}$/);
    await expect(page.getByRole("cell", { name: `${firstName} ${lastName}` })).toBeVisible();

    // 4. No identifiers were written by the registration form.
    const { data: patient, error: patientError } = await admin()
      .from("patients")
      .select("id")
      .eq("mrn", mrn)
      .eq("first_name", firstName)
      .eq("last_name", lastName)
      .single();
    if (patientError || !patient) {
      throw new Error(`could not read the registered patient: ${patientError?.message}`);
    }
    const { count: identifierCount, error: identifierError } = await admin()
      .from("patient_identifiers")
      .select("id", { count: "exact", head: true })
      .eq("patient_id", patient.id);
    if (identifierError) {
      throw new Error(`could not count patient identifiers: ${identifierError.message}`);
    }
    expect(identifierCount).toBe(0);

    // 5. The detail page shows the same record. Clicking the name is the product's own
    //    navigation, so the link is what is under test.
    await page.getByRole("link", { name: `${firstName} ${lastName}` }).click();
    await expect(page).toHaveURL(new RegExp(`/app/patients/${patient.id}$`));
    await expect(page.getByText(mrn, { exact: true }).first()).toBeVisible();

    // 6. A permitted user adds an identifier, and the page re-renders with it.
    const identifierValue = `NID-${stamp}`;
    await page.fill('input[id="identifier-kind"]', "NATIONAL_ID");
    await page.fill('input[id="identifier-value"]', identifierValue);
    await page.getByRole("button", { name: "Add identifier" }).click();
    await expect(page.getByRole("cell", { name: identifierValue })).toBeVisible({
      timeout: 15_000,
    });

    // 7. Create an appointment for the patient.
    await page.goto("/app/appointments");
    await expect(page.getByText("No appointments on this day")).toBeVisible();
    await page.selectOption('select[id="appointment-patient"]', patient.id);
    await page.fill('input[id="appointment-date"]', "2027-03-15");
    await page.fill('input[id="appointment-time"]', "09:00");
    await page.fill('input[id="appointment-duration"]', "30");
    await page.fill('input[id="appointment-reason"]', "Follow-up");
    await page.getByRole("button", { name: "Book appointment" }).click();

    // 8. The appointment appears on the day view with status `booked`.
    await page.goto("/app/appointments?day=2027-03-15");
    await expect(page.getByRole("cell", { name: mrn })).toBeVisible();
    await expect(page.getByRole("cell", { name: "09:00" })).toBeVisible();
    await expect(page.getByText("booked")).toBeVisible();

    const appointmentId = (await admin()
      .from("appointments")
      .select("id")
      .eq("patient_id", patient.id)
      .single()).data?.id;

    // 9. Change the status to confirmed.
    await page.selectOption(
      'select[aria-label="`Status for `${mrn}`"]',
      "confirmed",
    );
    await page.getByRole("button", { name: `Update status for ${mrn}` }).click();
    await expect(page.getByText("confirmed")).toBeVisible();

    // 10. A random id is a real 404, not an empty detail page. The response status is the
    //     assertion; the visible fallback proves the 404 reached the user.
    const response = await page.goto(`/app/patients/${crypto.randomUUID()}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("This page could not be found.")).toBeVisible();

    // 11. Back to the list before archiving.
    await page.goto("/app/patients");

    // 12. Archiving removes it from the active list, after the confirm dialog.
    await page.getByRole("button", { name: `Archive ${mrn}`, exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Confirm archive" }).click();
    await expect(page.getByRole("cell", { name: mrn, exact: true })).toHaveCount(0);
    await expect(page.getByText("No patients yet")).toBeVisible();

    // 13. The archived record is still there, under the archived filter.
    await page.goto("/app/patients?archived=1");
    await expect(page.getByRole("cell", { name: mrn, exact: true })).toBeVisible();

    // 14. A second organization for the same user, active after onboarding. The first
    //    tenant's patient must not appear in its list.
    const secondSlug = `probe-patients-two-${stamp}`;
    probe.slugs.push(secondSlug);
    await page.goto("/app/onboarding");
    await page.fill('input[id="name"]', `Probe Patients Clinic Two ${stamp}`);
    await page.fill('input[id="slug"]', secondSlug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    await page.goto("/app/patients");
    await expect(page.getByRole("cell", { name: mrn, exact: true })).toHaveCount(0);
    await expect(page.getByText("No patients yet")).toBeVisible();
  });
});
