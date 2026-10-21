/**
 * The auth and onboarding schemas.
 *
 * WHY A SCHEMA TEST AT ALL. A zod schema is declarative, so the realistic failure is a typo
 * that makes one accept everything - `.email()` dropped, `min(1)` loosened, a regex written
 * to match nothing or everything. Those fail silently: the form validates, the bad value is
 * forwarded, and the error surfaces from Supabase as an opaque 400 much later.
 *
 * WHAT IS WORTH ASSERTING. That each schema ACCEPTS a well-formed value, and REJECTS the
 * specific malformation it exists to catch - one positive and one negative per rule, rather
 * than a broad snapshot that would be brittle and would not say which rule broke.
 */
import { describe, expect, it } from "vitest";

import {
  createOrganizationSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from "../../lib/validation/auth";

const ORG = {
  name: "Northside Family Clinic",
  slug: "northside-clinic",
  timezone: "Asia/Kolkata",
  currency: "INR",
  locale: "en-IN",
};

describe("loginSchema", () => {
  it("accepts a well-formed login", () => {
    expect(loginSchema.safeParse({ email: "Dr@Clinic.Test", password: "hunter2!" }).success).toBe(
      true,
    );
  });

  it("normalises the address so case and padding cannot split an account", () => {
    const parsed = loginSchema.parse({ email: "  Dr@Clinic.Test ", password: "x" });
    expect(parsed.email).toBe("dr@clinic.test");
  });

  it("rejects a malformed address", () => {
    expect(loginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("does not apply the signup password policy", () => {
    // A login must not fail on a PASSWORD RULE: that would leak, by message, that the
    // password exists and is merely too weak.
    expect(loginSchema.safeParse({ email: "a@b.test", password: "short" }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "a@b.test", password: "" }).success).toBe(false);
  });
});

describe("signupSchema", () => {
  it("accepts a conforming signup", () => {
    expect(
      signupSchema.safeParse({ email: "dr@clinic.test", password: "clinic123", fullName: "Dr Rao" })
        .success,
    ).toBe(true);
  });

  it("accepts an EMPTY name, because the field is labelled optional", () => {
    // MEASURED, and the cause of a signup that could not be submitted at all: the form
    // seeds `fullName: ""`, and a `min(1)` on an optional field rejected it, so the
    // resolver never reached the server action. A field that is optional in the label
    // but required in practice cannot be submitted.
    const parsed = signupSchema.safeParse({
      email: "dr@clinic.test",
      password: "clinic123",
      fullName: "",
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses an implausibly long name", () => {
    expect(
      signupSchema.safeParse({
        email: "dr@clinic.test",
        password: "clinic123",
        fullName: "x".repeat(121),
      }).success,
    ).toBe(false);
  });

  it("enforces length and both character classes", () => {
    expect(signupSchema.safeParse({ email: "a@b.test", password: "short1" }).success).toBe(false);
    expect(signupSchema.safeParse({ email: "a@b.test", password: "longenough" }).success).toBe(
      false,
    );
    expect(signupSchema.safeParse({ email: "a@b.test", password: "12345678" }).success).toBe(false);
  });
});

describe("password reset", () => {
  it("takes an address alone for a forgotten password", () => {
    expect(forgotPasswordSchema.safeParse({ email: "dr@clinic.test" }).success).toBe(true);
    expect(forgotPasswordSchema.safeParse({}).success).toBe(false);
  });

  it("takes a new password alone for a reset, and applies the signup policy", () => {
    expect(resetPasswordSchema.safeParse({ password: "clinic123" }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ password: "weak" }).success).toBe(false);
    // Deliberately no email field: branching on one here would reveal whether the address
    // is registered. Zod STRIPS unknown keys rather than rejecting the object - asserted
    // explicitly, because "the extra field is ignored" and "the extra field is absent from
    // the parsed output" are different claims, and only the second matters to a caller
    // that forwards the parsed value onward to Supabase.
    const parsed = resetPasswordSchema.parse({ password: "clinic123", email: "a@b.test" });
    expect(parsed).toEqual({ password: "clinic123" });
    expect("email" in parsed).toBe(false);
  });
});

describe("createOrganizationSchema", () => {
  it("accepts a well-formed organization", () => {
    expect(createOrganizationSchema.safeParse(ORG).success).toBe(true);
  });

  it("lower-cases and trims the slug", () => {
    const parsed = createOrganizationSchema.parse({ ...ORG, slug: "  Northside-Clinic " });
    expect(parsed.slug).toBe("northside-clinic");
  });

  it("rejects a slug that would break routing", () => {
    // A slash in the tenant key puts an extra path segment in every URL built from it.
    for (const slug of ["north side", "north/side", "north_side", "-north", "north-", "nb"]) {
      expect(createOrganizationSchema.safeParse({ ...ORG, slug }).success, slug).toBe(false);
    }
  });

  it("requires a real currency code and a non-empty timezone", () => {
    expect(createOrganizationSchema.safeParse({ ...ORG, currency: "RUPEE" }).success).toBe(false);
    expect(createOrganizationSchema.safeParse({ ...ORG, timezone: "" }).success).toBe(false);
  });
});
