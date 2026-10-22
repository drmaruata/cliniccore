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
 *
 * `resetPasswordSchema` has no email field: the reset token identifies the account, and
 * accepting an address here would invite callers to branch on it and accidentally reveal
 * whether it is registered. `resetPasswordFormSchema` extends it with the confirmation
 * field so the client resolver and the server action agree - a disagreement is invisible
 * until a user hits it.
 *
 * `createOrganizationSchema` mirrors what `organizations` actually stores. `slug` is the
 * tenant key used in URLs, so it is constrained to lowercase kebab-case rather than left
 * free - a slug containing a slash or an uppercase letter breaks routing later, far from
 * here. The time zone is not validated against the installed tzdata: the set differs
 * between runtimes, and `clinicDayBounds` is the component that fails loudly if a zone is
 * unknown.
 */
import { z } from "zod";

// Transform, THEN validate: Zod checks the format against the INPUT string, so
// ` Dr@clinic.test ` was rejected when `.trim().toLowerCase()` was chained after `z.email()`.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const password = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(200, "That password is implausibly long")
  .regex(/[A-Za-z]/, "Include at least one letter")
  .regex(/[0-9]/, "Include at least one number");

export const loginSchema = z.object({
  email,
  // No minimum beyond non-empty: a PASSWORD RULE refusal would leak that the password
  // exists and merely fails a rule.
  password: z.string().min(1, "Enter your password").max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const signupSchema = z.object({
  email,
  password,
  // An EMPTY name is ABSENT, not invalid. MEASURED: the form seeds `fullName: ""`, and
  // `min(1)` rejected it, so the resolver never reached the server action.
  fullName: z.string().trim().max(120, "That name is implausibly long").optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({ password });

export const resetPasswordFormSchema = resetPasswordSchema
  .extend({
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Name your clinic").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Use at least 3 characters")
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens"),
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().toUpperCase().length(3, "Use a three-letter currency code"),
  locale: z.string().trim().min(2).max(35),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
