# Security - ClinicCore foundation

Foundation (Phases 1–3). The security-relevant machinery exists and is tested; the product is
**not production-ready**. This page states what is defended, how it was measured, and what is
still open. Historical detail: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

## Threat model

| Threat                                         | Mitigation                                                                                                                                                                                                                                                                                  | Evidence                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cross-tenant **read** of another clinic's rows | RLS on all 16 public tables; the tenant predicate is in every policy                                                                                                                                                                                                                        | `tests/security/tenant-isolation.test.ts`; re-verified over real HTTPS with real JWTs        |
| Cross-tenant **write**                         | RLS `WITH CHECK` plus composite foreign keys, so a child row naming another tenant's parent is unrepresentable                                                                                                                                                                              | 38 recorded mutations; the composite-key test disables the policy and shows the FK refuse it |
| Privilege **escalation** inside a tenant       | The grant ceiling: a role may only be granted if its permission set is a subset of the grantor's, and only an owner may grant `organization_owner`; one rule (`private.can_assign_role`) on every path                                                                                      | `rls-policies.test.ts`, mutation-verified                                                    |
| Escalation to **platform** authority           | `private.can` refuses every `platform.%` key case-insensitively and admits only the asked-organization's roles; `profiles.is_platform_admin` is trigger-guarded                                                                                                                             | `authorization-schema-sql.test.ts`, `rls-policies.test.ts`                                   |
| **Service-role key leakage**                   | The key is server-only, confined by `scripts/check-no-secrets.ts`; `lib/supabase/server.ts` begins with `import "server-only"`; a client import fails at bundle time                                                                                                                        | `tests/unit/server-boundary.test.ts`, `check-no-secrets.test.ts`                             |
| **Platform console abuse**                     | The route answers 404 to a non-operator, and the data layer refuses to read the directory **before** the query                                                                                                                                                                              | `tests/unit/platform-console.test.ts`, `tests/e2e/platform-gate.spec.ts`                     |
| **Storage path traversal**                     | `private.storage_path_is_safe` refuses a dot-dot segment and requires a UUID first segment; tenancy comes from the path                                                                                                                                                                     | `tests/security/storage-policies.test.ts`                                                    |
| **Invitation token theft**                     | Only a SHA-256 digest is stored; 7-day expiry; one redemption; the acceptor's account address must equal the invitation's. This binds the account to the stored address; with email confirmation disabled it does **not** prove mailbox control, so re-enabling confirmation is the control | `invitations.spec.ts`, `rls-policies.test.ts`                                                |
| **Audit falsification**                        | `audit_logs` is append-only to clients; the only writer is a definer that checks membership; metadata is screened to identifiers and codes                                                                                                                                                  | `tenant-isolation.test.ts`, `audit-log.test.ts`                                              |

## Tenant isolation

Three independent layers. Each is load-bearing on its own; together they make the common
mistake - forgetting a predicate - fail closed rather than leak.

1. **RLS as the authority.** 39 public policies across 14 tables, 20 on `storage.objects`. The
   shapes are in [`RLS_POLICIES.md`](RLS_POLICIES.md). `tenant_sequences` and
   `tenant_creation_events` carry no policy at all and are default-deny.
2. **Composite foreign keys.** 5 of 21 public foreign keys carry `organization_id`, so a row that
   names another tenant's clinic or patient cannot be inserted even if a policy were missing.
   Single-column role references are closed by `private.guard_role_org_scope` instead.
3. **Path-derived storage tenancy.** `<org>/<clinic>/<file>` (or `<org>/<file>` for `org-assets`)
   is parsed by two definers and checked by every one of the 20 policies. A text path cannot carry
   a foreign key, so this layer is policy, not constraint.

**Verified through the real path, not only a direct connection.** Three real auth users, three
real signed JWTs, HTTPS to PostgREST: a member sees only their own organization's rows; a member
holding **no permission** sees nothing even though they are a member; a non-member sees nothing;
`auth.uid()` resolves from the JWT; a permitted write succeeds (1 row, value changed); a
cross-tenant write returns **0 rows with no error** and leaves the database untouched.

**JWT verification is real.** A flipped signature, a forged signature, and a payload rewritten to
`role: service_role` **with the genuine signature** all return 401 (PGRST301). The role claim
cannot be tampered with at the HTTP layer.

The security suite's own transactions run as the table **owner**, which bypasses RLS. That is a
proxy, not the product; the HTTPS measurement above is the product-side half. Do not treat a
green impersonated test as proof about PostgREST - the two answer different questions.

## Authorisation and the ceiling

`private.can` is the single authority, and policies ask it rather than reimplementing the rule in
TypeScript. The rule lives in `private.can_for(user, org, permission, clinic)`:

```
lower(permission) not like 'platform.%'
and is_member_for(user, org)
and exists (an assignment in org for that user, whose role belongs to org,
            carrying the permission, and (clinic is null or = the asked clinic))
```

`can` is org-strict **and** platform-key-refusing. Both clauses are required: `permissions` is one
global table with no scope column, so without the `platform.%` refusal a tenant could attach a
platform key to its own role.

The **ceiling** is `private.can_assign_role` - the subset rule plus the owner-only clause - and it
is called by `user_role_assignments_write`, `_update`, `invitations_write`, `invitations_update`
and re-checked at redemption for the **inviter**. Only an existing `organization_owner` may mint
another owner; the subset rule cannot tell owner from admin because their permission sets are
byte-identical.

`private.can_grant` is the subset rule **without** the owner clause. It has no callers and its
EXECUTE is revoked; leaving a looser rule callable is a trap for the next policy.

## Session and authentication controls

- Supabase Auth handles credentials. Passwords are validated for shape before the provider call
  (8–200 characters, at least one letter and one number); the login schema deliberately applies
  **no** password policy, because a rule refusal would leak that the account exists.
- `proxy.ts` refreshes the session on every non-static request and writes the refreshed cookie to
  both the request and the response.
- The `cc_active_org` / `cc_active_clinic` cookies are `httpOnly`, `sameSite: lax`, 30-day
  `maxAge`, and `secure: process.env.NODE_ENV === "production"` - the request scheme is not
  consulted. In production over plain HTTP the browser discards the cookie, so the selection does
  not persist; outside production the cookie is not `secure` and can travel over HTTP.
- Protected routes are gated in `app/app/layout.tsx`; a request without a session is redirected to
  `/login`.
- Signup, sign-in, sign-out, verification status and password reset are the only auth flows. There
  is no OAuth, no MFA and no account-deletion UI.
- **Auth cookies are `httpOnly: false`.** That is `@supabase/ssr`'s design: the browser client
  restores its session by reading `document.cookie`, so an HttpOnly cookie would break sign-in on
  a full page load. The consequence is that any XSS can read the session cookie. Recorded, not
  hidden.

## Key handling

| Secret                      | Where it may appear                                                     |
| --------------------------- | ----------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase/server.ts` and `tests/` only; never a `"use client"` file |
| `TEST_DATABASE_URL`         | `tests/integration/helpers/database.ts`; tests only                     |
| `NEXT_PUBLIC_*`             | Browser-safe by contract; no secret may be prefixed `NEXT_PUBLIC_`      |

`scripts/check-no-secrets.ts` enforces four rules: the service key's path allow-list, the
`NEXT_PUBLIC_` prefix ban, the client/server import boundary, and a hard-coded-secret scan (a
`sb_secret_…` or `eyJ…` literal fails everywhere, including tests and `.env.example`). It runs as
one of the four gates inside `npm run lint`.

**A database-layer check cannot identify the service role.** `authenticator` holds `SET` on
`service_role` by design, so a definer function cannot unforgeably tell "the service role" from an
authenticated caller. Checks such as `guard_platform_admin` are defence-in-depth, **not** a
boundary. The real boundary for a browser request is JWT verification, before any policy runs.

## Audit: append-only, not tamper-proof

- `audit_logs` has no foreign keys, so deleting a tenant or an actor cannot cascade the trail away.
- `authenticated` holds **SELECT only**; INSERT, UPDATE and DELETE are revoked. Append-only does
  not depend on there being no write policy.
- The only writer is `private.write_audit`, a definer that checks `private.is_member` itself -
  because a definer bypasses RLS.
- Metadata may carry identifiers and codes. A value with whitespace, or a key naming clinical free
  text, is refused; the refusal names the key and the reason.
- Reads require `audit.read` in the organization, or a platform administrator for platform-level
  (`organization_id IS NULL`) rows.

**Not claimed: tamper-proofing.** A database owner, a superuser or anyone with the service key can
alter or delete audit rows. There is no hash chain, no write-once storage and no external log
shipping. Calling this "tamper-proof" would be false.

## Known limits

| Limit                                                             | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Email confirmation is disabled** on the hosted project          | Anyone can register an address they do not own and is signed in immediately. This **does** expose the invitation path: Supabase implicitly sets `email_confirmed_at` at signup, so an attacker who knows the invited address can register it, open the link and accept. The acceptance binds the account to the stored address only; it does not prove control of the mailbox. Re-enabling confirmation is the control, and it is a mandatory pre-launch step |
| **No invitation email delivery**                                  | Invitation links are displayed for manual sharing. Delivery is BLOCKED; no mail provider exists                                                                                                                                                                                                                                                                                                                                                               |
| **Password-reset mail unverified**                                | The hosted project's redirect allow-list must include the app URL before a mail is sent. No mailbox was available to prove delivery                                                                                                                                                                                                                                                                                                                           |
| **Invitation token is in the URL**                                | It is in browser history and any access log. `Referrer-Policy: no-referrer` stops it leaking to linked pages; a one-time code or fragment would fix the rest, and is a later task                                                                                                                                                                                                                                                                             |
| **No rate-limit testing**                                         | The public signup endpoint is measurably limited by the provider (about 2–3 calls per window, per project), but no application-level limit is tested. The tenant-creation cap (5 per user per 24 h) is the one application limit that exists                                                                                                                                                                                                                  |
| **No CORS testing**                                               | PostgREST's CORS policy was not exercised                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **No error-message-leakage testing**                              | Some messages were deliberately shaped ("expected a failure matching …") but no systematic audit exists                                                                                                                                                                                                                                                                                                                                                       |
| **No load or performance testing**                                | Throughput and concurrency behaviour are unmeasured beyond correctness under parallel test files                                                                                                                                                                                                                                                                                                                                                              |
| **No CSP or security headers**                                    | `next.config.ts` sets no `headers()`; there is no CSP, HSTS, `X-Frame-Options` or `X-Content-Type-Options`. A production deployment must add them                                                                                                                                                                                                                                                                                                             |
| **Platform console gate is 404**                                  | Deliberate: a redirect would confirm that `/platform` exists. The trade-off is that an operator gets no hint about why they cannot see it                                                                                                                                                                                                                                                                                                                     |
| **The platform directory exposes name, status and member count**  | It cannot return an id, a slug or a clinical row - that is a property of `public.tenant_directory()`'s signature. The count is of membership rows in any status, by design                                                                                                                                                                                                                                                                                    |
| **`export_patients` is a bulk-read enforcement point with no UI** | RLS cannot distinguish reading one patient from exporting all of them; the definer is the enforcement point. Nothing in the app calls it yet                                                                                                                                                                                                                                                                                                                  |
| **Audit metadata screening is a blocklist**                       | Normalised keys and a widened word list; a single-word value that is not a free-text key name is indistinguishable from a code and passes. The real closure is an allowlist that needs the application's metadata shape first                                                                                                                                                                                                                                 |

## Reporting a vulnerability

There is no security contact address in this repository. A deployment must add one before launch.
Do not open a public issue for a suspected cross-tenant disclosure.
