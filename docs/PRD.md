# Product requirements - ClinicCore foundation

Status: describes the **foundation (Phases 1–3) as built**. Phases 4–10 are unbuilt. The
implementation record is [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md); this
document states requirements and scope, not history.

## Problem

A clinic group runs several physical clinics. Its staff need one system in which each clinic's
records are isolated from every other clinic's, while a person may legitimately work in more
than one organization. The failure that matters is cross-tenant access to patient records -
not an inconvenience, but a disclosure that cannot be undone.

Before any clinical feature can be trusted, the platform needs an identity, tenancy and
authorization base that makes cross-tenant access structurally difficult: row-level security
as the authority, composite foreign keys so a cross-tenant reference is unrepresentable,
private storage with path-derived tenancy, and a test suite that proves each policy is
load-bearing rather than merely present.

## Personas

| Persona                                                  | What they do in this release                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Clinic owner                                             | Signs up, creates the organization and its first clinic, invites staff, switches tenants, reads their own role assignments |
| Clinic staff (administrator, clinician, receptionist, …) | Accepts an invitation, signs in, lands in the organization they belong to, switches clinic, reads the dashboard            |
| Platform operator                                        | Signs in, opens `/platform`, reads the tenant directory (name, status, membership count). Belongs to no tenant             |

There is no patient persona in this release: patients exist as schema and RLS only.

## Scope of Phases 1–3 (as built)

1. Repository, toolchain, strict TypeScript, ESLint, Prettier, secret-scan and migration-lint
   gates.
2. Design tokens, light/dark theme, and a shared component library on shadcn/ui and Tailwind
   v4 (CSS-first).
3. Public marketing shell (route structure and visual foundation only).
4. Authenticated application shell with organization and clinic switchers.
5. Supabase clients (browser, server, proxy), session refresh in `proxy.ts`, protected routes.
6. Signup, sign-in, sign-out, email-verification status page, password-reset request and
   reset form.
7. Organization onboarding: create organization, first clinic, owner membership and role
   assignment in one transaction.
8. Invitation creation, display of the invitation link, and acceptance with an email binding.
9. Tenancy schema: 16 public tables, RLS on all of them, 21 public foreign keys of which 5
   are composite.
10. Authorization: 15 seeded roles over 21 permission keys, `private.can` as the single
    authority, a tenant-scoped grant ceiling and an owner-only rule.
11. Five private storage buckets with tenant-scoped policies.
12. Audit foundation: an append-only table, definer-only writer, metadata restricted to
    identifiers and codes.
13. A mutation-verified tenant-isolation suite.
14. The documentation set in this directory.

## Explicit non-goals (Phases 4–10)

| Deferred                                                                          | Phase |
| --------------------------------------------------------------------------------- | ----- |
| Full marketing page set (features, pricing, security, legal, SEO)                 | 4     |
| Patients, appointments, queue, encounters, vitals, prescriptions, laboratory      | 5–6   |
| Billing, payments, refunds, inventory                                             | 7     |
| Subscription plans, entitlements, usage limits, tenant lifecycle, Razorpay wiring | 8     |
| Reports, exports, notifications                                                   | 9     |
| Production hardening and launch (see `DEPLOYMENT.md` for the pre-launch list)     | 10    |

Out of scope by decision, not by omission: patient **UI**, appointment **UI**, any payment
step in onboarding, any email delivery, any clinical report, any export UI.

## Success criteria

The foundation's acceptance criteria are the design spec's §11, restated here with the
measured status of each. Nothing below is claimed beyond what
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) records.

| #   | Criterion                                                                            | Status                                                                                              |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | `tsc --noEmit`, ESLint, Vitest and `next build` pass on a clean run                  | Met; see the gate records in the status log                                                         |
| 2   | Migrations apply from zero through Composio and are verified in the catalogue        | Partly: 61 migrations applied and verified in the catalogue; a from-zero rehearsal has not been run |
| 3   | Signup → organization → clinic → owner membership, with no confirmation interstitial | Met; E2E `tests/e2e/onboarding.spec.ts`                                                             |
| 4   | Login, logout, password reset, protected-route redirect work                         | Login/logout/redirect verified; password-reset **mail delivery unverified**                         |
| 5   | A user in two organizations can switch between them, and only those                  | Met; E2E `tests/e2e/onboarding.spec.ts`                                                             |
| 6   | All isolation assertions pass and each is mutation-verified                          | Met; 38 recorded mutations in `tests/security/tenant-isolation.test.ts`                             |
| 7   | `is_platform_admin` cannot be self-assigned by any client path                       | Met; trigger plus self-only profile policy                                                          |
| 8   | Storage buckets exist, are private, and reject cross-tenant access                   | Met; 5 buckets, 20 policies, `tests/security/storage-policies.test.ts`                              |
| 9   | Design tokens match the mandate; light and dark render; no component hardcodes a hex | Met; `tests/unit/design-tokens.test.ts`                                                             |
| 10  | All 15 documentation artefacts exist and describe the actual implementation          | Met by this documentation set                                                                       |
| 11  | The status log honestly records every BLOCKED item                                   | Met; see `IMPLEMENTATION_STATUS.md`                                                                 |

## Assumptions and limits

- The Supabase project is hosted and operator-managed. Email confirmation is **disabled**, so
  signup returns a session immediately. That is acceptable for a test environment and is a
  production blocker; see `SECURITY.md` and `DEPLOYMENT.md`.
- There is no Supabase Personal Access Token, so migrations are delivered through the Composio
  MCP. Composio is an applier, not the source of truth.
- There is no payment provider, no mail provider and no Razorpay test key. Billing is a seam
  that refuses; invitation delivery is manual.
- The product has no clinical records. `patients` and `patient_identifiers` exist so tenant
  isolation can be tested against a PHI-shaped target, and are reachable only through SQL/RLS
  and the isolation fixtures - not through the application.
- The platform console deliberately answers **404** to a caller who is not a platform
  administrator. That is a gate, not a redirect.
- Not production-ready. Phases 4–10 remain.
