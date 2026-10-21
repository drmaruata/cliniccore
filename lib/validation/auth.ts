/**
 * Request-body schemas for the auth and onboarding forms.
 *
 * WHY THESE EXIST RATHER THAN CHECKS AT THE EDGE. Every one of these values is about to be
 * forwarded to Supabase Auth or written to `organizations`, so the boundary where it is
 * cheapest to refuse bad input is here - before a network call, before a row exists, and
 * before the value reaches anything that stores it.
 *
 * WHAT THEY DELIBERATELY DO NOT DO. They do not enforce uniqueness (that is the database's
 * job, and a check constraint answers it authoritatively under concurrency), and they do
 * not encode password policy beyond shape - length and character classes, because a policy
 * that lives only in a schema is a policy nobody reads when they need it.
 *
 * `z.email()` / `z.url()` are Zod 4's top-level formats; this project pins zod 4.6.7
 * exactly, so the older `z.string().email()` is deprecated rather than removed.
 */
import { z } from "zod";

/**
 * A real email address. `.max(254)` is not decoration: the RFC caps a forward path at 254
 * characters and Supabase's own column does too, so an unbounded string here would fail
 * later and less clearly.
 *
 * NOTE THE ORDER. Transform, THEN validate. Chaining `.trim().toLowerCase()` after
 * `z.email()` looks equivalent and is not: Zod checks the format against the INPUT string,
 * so ` Dr@clinic.test ` was rejected as malformed. Piping the transformed string through the
 * format check is what makes the normalisation actually happen.
 */
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/**
 * Length plus character classes rather than a full complexity score. Eight characters with
 * a letter and a number is the shape most guidance actually converges on, and a longer
 * rule here would only push people toward `Passw0rd!`.
 */
const password = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(200, "That password is implausibly long")
  .regex(/[A-Za-z]/, "Include at least one letter")
  .regex(/[0-9]/, "Include at least one number");

export const loginSchema = z.object({
  email,
  // No minimum beyond non-empty here: refusing a login because of a PASSWORD RULE would
  // leak, by timing and by message, that the password exists and merely fails a rule.
  password: z.string().min(1, "Enter your password").max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const signupSchema = z.object({
  email,
  password,
  // An EMPTY name is ABSENT, not invalid. The field is labelled optional, and a field
  // that is optional in the label but required in practice cannot be submitted at all.
  // MEASURED: the form seeds `fullName: ""`, and `min(1)` rejected it, so the
  // resolver never reached the server action. A name that is only whitespace is the
  // same thing.
  fullName: z.string().trim().max(120, "That name is implausibly long").optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const forgotPasswordSchema = z.object({ email });

/**
 * The reset form, with the confirmation field.
 *
 * ONE schema for both sides. The client resolver and the server action must agree, or
 * the form accepts something the server refuses - and the disagreement is invisible
 * until a user hits it.
 */
export const resetPasswordFormSchema = z
  .object({
    password: z
      .string()
      .min(8, "Use at least 8 characters")
      .max(200, "That password is implausibly long")
      .regex(/[A-Za-z]/, "Include at least one letter")
      .regex(/[0-9]/, "Include at least one number"),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * No email field: the reset token identifies the account, and accepting an address here
 * would invite callers to branch on it and accidentally reveal whether it is registered.
 */
export const resetPasswordSchema = z.object({ password });

/**
 * Mirrors what `organizations` actually stores. `slug` is the tenant key used in URLs, so
 * it is constrained to lowercase kebab-case rather than left free - a slug containing a
 * slash or an uppercase letter breaks routing later, far from here.
 */
export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Name your clinic").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Use at least 3 characters")
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens"),
  // IANA zone names, which contain a slash and underscores. Deliberately not validated
  // against the installed tzdata: the set differs between runtimes, and `clinicDayBounds`
  // is the component that will fail loudly if a zone is unknown.
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().toUpperCase().length(3, "Use a three-letter currency code"),
  locale: z.string().trim().min(2).max(35),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
