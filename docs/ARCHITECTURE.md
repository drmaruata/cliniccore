# Architecture - ClinicCore foundation

Foundation (Phases 1–3). No clinical feature exists. This document describes the structure the
code actually has; historical reasons are in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

## Route topology

| URL                     | Directory                           | Kind                            | Guard                                                  |
| ----------------------- | ----------------------------------- | ------------------------------- | ------------------------------------------------------ |
| `/`                     | `app/(marketing)/page.tsx`          | Route group (pathless)          | none - public, reads no session                        |
| `/login`                | `app/(auth)/login/`                 | Route group (pathless)          | none                                                   |
| `/signup`               | `app/(auth)/signup/`                | Route group                     | none                                                   |
| `/verify`               | `app/(auth)/verify/`                | Route group                     | none                                                   |
| `/forgot-password`      | `app/(auth)/forgot-password/`       | Route group                     | none                                                   |
| `/reset-password`       | `app/(auth)/reset-password/`        | Route group                     | none; the action needs a recovery session              |
| `/api/auth/verify`      | `app/api/auth/verify/route.ts`      | Route handler                   | none; allow-listed `next`                              |
| `/invite/[token]`       | `app/invite/[token]/`               | Real segment, outside the shell | none; redemption needs a session                       |
| `/app`                  | `app/app/page.tsx`                  | Real segment                    | session; redirects to `/app/dashboard`                 |
| `/app/dashboard`        | `app/app/dashboard/page.tsx`        | Real segment                    | session + a resolvable active organization             |
| `/app/onboarding`       | `app/app/onboarding/page.tsx`       | Real segment                    | session                                                |
| `/app/settings/members` | `app/app/settings/members/page.tsx` | Real segment                    | session + tenant; the invite form needs `staff.manage` |
| `/platform`             | `app/platform/page.tsx`             | Real segment                    | platform administrator; otherwise `notFound()`         |

`app/app/` and `app/platform/` are **real segments, not route groups**. A pathless group named
`(platform)` would serve `/` and collide with the marketing root; the design spec's table uses
parentheses as shorthand for a URL prefix.

The root layout is `app/layout.tsx` (owns `<html>` and `<body>`). A route group cannot own a
root layout.

## Server/client boundaries

| Module                   | Boundary               | Rule                                                                         |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| `lib/supabase/server.ts` | server only            | starts with `import "server-only"`; a client import fails at bundle time     |
| `lib/supabase/client.ts` | browser                | `createBrowserClient` from `@supabase/ssr`; publishable key only             |
| `lib/supabase/proxy.ts`  | server (proxy runtime) | refreshes the session                                                        |
| `lib/billing/*`          | server only            | `import "server-only"` in every file of the seam                             |
| `lib/auth/*`             | server only            | reads the cookie and asks the database                                       |
| `components/**`          | client or server       | `"use client"` only where state, an event handler or a browser API is needed |

`scripts/check-no-secrets.ts` (rule 3) fails `npm run lint` if a `"use client"` file imports
`lib/supabase/`, and rule 1 confines `SUPABASE_SERVICE_ROLE_KEY` to `lib/supabase/server.ts`
and `tests/`. The `server-only` import is the primary defence.

## Session refresh

`proxy.ts` at the repository root - Next.js 16 renamed `middleware.ts` to `proxy.ts`, and a
leftover `middleware` export is silently ignored. The proxy calls `updateSession`, which:

1. builds a Supabase server client bound to the request cookies;
2. awaits `getClaims()` immediately, so a refresh actually happens before the response is
   committed;
3. writes every refreshed cookie to **both** the request and a re-created response, accumulating
   cookies across batches because rebuilding the response discards earlier ones.

`setAll` in `lib/supabase/server.ts` swallows a write failure during a Server Component render:
that render cannot write cookies, and the proxy has already refreshed them.

Authentication uses `getUser()` where the answer gates on identity; `getClaims()` is the cheap
local read used to detect a session.

## Supabase clients

- `lib/supabase/client.ts` - `createBrowserClient`, keyed by
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. `@supabase/ssr`
  returns one cached browser client per page, deliberately.
- `lib/supabase/server.ts` - `createServerClient` bound to `next/headers` cookies, plus
  `getUser()` and `getClaims()`.
- `lib/supabase/proxy.ts` - the refresh path above.
- `lib/supabase/server.ts` is the only application file allowed to read
  `SUPABASE_SERVICE_ROLE_KEY`; it does not use it for requests in this release.

## Active organization and clinic

- `cc_active_org` and `cc_active_clinic` are HTTP-only cookies (`lib/auth/session.ts`), 30-day
  `maxAge`, `secure: process.env.NODE_ENV === "production"`.
- The organization is resolved by `resolveActiveOrg` in `lib/auth/active-org.ts`: it lists the
  caller's **memberships** (never `organizations` directly), then accepts the cookie only if the
  list contains it. One membership and no cookie resolves to that membership; several and no
  cookie resolves to `null`; a cookie that no longer matches resolves to `null` and never falls
  back.
- The write path (`switchOrganization`) re-checks membership before writing the cookie, so a
  refusal is earlier and clearer; the read path re-validates anyway, which is the security.
- `switchClinic` resolves the active organization first and requires the clinic to be in it,
  because the `clinics` SELECT policy spans every organization the user belongs to.

## Tenancy model

- `organizations` is the tenant root. 10 of the 16 public tables carry `organization_id`;
  `roles.organization_id` is nullable because a platform role belongs to no tenant.
- `clinics` belong to an organization; `organization_memberships` join a user to an
  organization; `clinic_memberships` scope a membership to clinics; `user_role_assignments`
  carry the role and an optional clinic.
- A membership is unique per `(organization_id, user_id)`. A role assignment is unique per
  `(organization_id, user_id, role_id, clinic_id)` with `NULLS NOT DISTINCT`, so an org-wide
  assignment cannot be duplicated.
- A role is unique per `(organization_id, key)` with `NULLS NOT DISTINCT`, so the platform role
  key is unique among platform roles.

## Cross-tenant referential integrity

Postgres cannot make a foreign key RLS-aware. The structural mitigation is to carry the tenant
into the key:

```sql
-- parent
constraint clinics_organization_id_id_key unique (organization_id, id)

-- child: the tenant is part of the reference
constraint patients_clinic_fkey
  foreign key (organization_id, clinic_id)
  references public.clinics (organization_id, id)
```

Measured in the live catalogue: **21 public foreign keys, 5 of them composite** -
`clinic_memberships` (2), `patient_identifiers` (1), `patients` (1), `user_role_assignments`
(1). The three role references are single-column; a role's organization scope is enforced by
`private.guard_role_org_scope` and by policy, not by the key.

`audit_logs`, `platform_settings` and `tenant_creation_events` deliberately carry no tenant
foreign key (the first two carry no foreign key at all), so a cascade cannot erase history.

## Authorisation funnel

`private.can` is the only permission authority. Policies call it (and its companions), never a
second copy of the rule in TypeScript.

```
auth.uid()  →  private.can  →  private.can_for  →  is_member_for
                                                 →  user_role_assignments
                                                 →  role_permissions
                                                 →  permissions.key
```

The rule inside `private.can_for`:

```
lower(p_permission) not like 'platform.%'
and is_member_for(user, org)
and exists (an assignment in org, for user, whose role belongs to org,
            carrying rp.permission_key = p_permission,
            and (assignment.clinic_id is null or = p_clinic_id))
```

Both extra clauses are load-bearing: without `platform.%` a tenant could attach a platform key
to its own role; without the exact-text match, a role's grants and the permission asked for
must agree character for character. `private.can` itself is a one-line delegation with
`auth.uid()`; the `*_for` variants are **not** executable by `authenticated`, because they answer
about other users.

Helpers are `security definer`, owned by `postgres` (`rolbypassrls`), `stable`, with
`search_path = ''` and schema-qualified references. `private` is not exposed by PostgREST
(measured: a `POST /rest/v1/rpc/<private fn>` answers PGRST202 naming `public` as the schema it
searched), so the browser reaches the primitives through the ten `public` wrappers.

## Storage

Five private buckets. Object tenancy is the object **name** - `<org>/<clinic>/<file>`, or
`<org>/<file>` for `org-assets` - because a text path cannot carry a foreign key. The project's
composite-key rule is therefore satisfied here by policy, not by constraint. Helpers:
`private.storage_org_id`, `private.storage_clinic_id`, `private.storage_path_is_safe`.
20 policies on `storage.objects`; the MIME allowlist lives on the bucket rows.

## Payment seam

`lib/billing/provider.ts` defines `PaymentProvider` (create checkout, verify webhook, refund),
`CheckoutInput`/`RefundInput` with idempotency keys, and `isPaymentConfigured()` which asks the
provider. `lib/billing/unconfigured.ts` exports a frozen stub whose every method rejects with
`PaymentNotConfiguredError`. The factory in `provider.ts` is the only place a provider is
chosen. Nothing here performs I/O; there is no provider SDK and no environment variable in
`lib/billing/`.

## Dependency directions

```
app/**  ──► lib/auth, lib/supabase, lib/validation, lib/errors, components/**
components/** ──► lib/utils (cn), components/ui
lib/auth ──► lib/supabase, lib/errors, lib/permissions (types)
lib/billing ──► lib/errors, lib/utils/money (types)
lib/supabase ──► @supabase/ssr, next/headers, types/database.types
```

`lib/` may import only a short sanctioned package list - including `@supabase/ssr` and
`@supabase/supabase-js`, which are the sanctioned HTTP clients - and a relative import from
`lib/` must resolve inside `lib/` or `types/`. This is pinned by
`tests/unit/payment-provider.test.ts` and guards against a second, unsanctioned HTTP path.

## Database access model

- PostgREST exposes the `public` schema only. The browser reaches tables directly under RLS, and
  ten RPC functions in `public` (thin wrappers or purpose-built definers).
- The `private` schema holds the helpers, triggers and definers that must not be callable
  directly by the browser.
- Migrations are delivered by Composio, not `supabase db push`; files are the source of truth.

## What is absent by design

No state-management library, no API layer between the app and Supabase, no client-side
authorization decision, no email transport, no payment transport, no caching layer, no queue.
Each of those belongs to a later phase; adding one now would be a claim the foundation cannot
support.
