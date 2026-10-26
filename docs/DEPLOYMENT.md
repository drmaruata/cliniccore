# Deployment - ClinicCore foundation

**The product is not production-ready.** This page explains how the foundation is deployed and
exactly which steps a launch would still need. Do not read the existence of this page as a
readiness claim; Phases 4–10 are unbuilt.

## Runtime requirements

| Requirement  | Value                                                                |
| ------------ | -------------------------------------------------------------------- |
| Node.js      | `>=24` (`package.json` `engines`)                                    |
| Next.js      | 16.4.3 (Turbopack build)                                             |
| React        | 19.3.0                                                               |
| Supabase     | a hosted project; the clients read `NEXT_PUBLIC_SUPABASE_URL`        |
| Build output | `.next`; `npm run build` type-checks as part of the build            |
| Migrations   | through the Composio MCP. There is no Supabase Personal Access Token |

No `Dockerfile` and no Supabase CLI configuration are committed; neither is required by the
scripts in this repository.

## Environment variables

Names only; values live in `.env.local` (gitignored) or the host's environment.

| Name                                   | Read by                            | Notes                                                                     |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | browser + server                   | `lib/supabase/*`                                                          |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server                   | the key the clients actually read                                         |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`        | **nothing**                        | retained as an inert placeholder for Supabase tooling; no client reads it |
| `SUPABASE_SERVICE_ROLE_KEY`            | `lib/supabase/server.ts`, `tests/` | **server only**. Never `NEXT_PUBLIC_`. Never a `"use client"` file        |
| `SUPABASE_PROJECT_REF`                 | the Composio apply                 | not read at runtime                                                       |
| `TEST_DATABASE_URL`                    | tests only                         | pooler host, `postgres.<ref>` user                                        |
| `NEXT_PUBLIC_APP_URL`                  | the password-reset redirect        | must match the hosted allow-list                                          |

`.env.example` is the only tracked template and is scanned by `check-no-secrets` like every other
file. It contains inert placeholders, never credentials.

## Supabase project setup

1. Create a hosted project. The browser and server clients need the URL and the **publishable**
   key; the service-role key is for the operator path only.
2. Apply the 61 migrations (below). Do not use `supabase db push`.
3. Create the five storage buckets if a migration did not: `patient-documents`,
   `clinical-attachments`, `investigation-reports`, `org-assets`, `prescription-documents`. All
   **private**; allowed MIME types PDF, JPEG, PNG, DICOM, plain text. `01300` creates them, but a
   fresh project should be verified rather than assumed.
4. **Re-enable email confirmation** (see the pre-launch list). It is disabled on the current hosted
   project, so signup returns a session immediately.
5. Add the app URL to the hosted project's **redirect allow-list** (see password reset).
6. Set the auth site URL to the deployment hostname, not `http://127.0.0.1:3000`.

`supabase/config.toml` configures a **local** `supabase start` stack only. Editing it does not change
the hosted project. The hosted settings are in the Supabase dashboard.

## Migration delivery

`supabase/migrations/*.sql` is the source of truth, applied in filename order. `Composio` is an
applier, not a source.

1. `npm run migrations:check` validates the names, order and non-emptiness. It applies nothing.
2. Apply **one file per Composio call** with `SUPABASE_APPLY_A_MIGRATION` (`ref`, `name`, `query`,
   `idempotency_key`). The applier derives `schema_migrations.version` from a second-resolution
   timestamp, so two applies batched into one call collide on `schema_migrations_pkey` (23505);
   `idempotency_key` does not prevent it.
3. Fall back to `SUPABASE_BETA_RUN_SQL_QUERY` only when the applier rejects a `DO $$` block.
4. **Never trust the apply response body.** Verify every apply by querying `information_schema`,
   `pg_catalog` or `pg_policies`. An applied migration is not proof the object exists - the
   catalogue is.
5. Record the post-apply `md5(prosrc)` for any function whose body the task asserts.

Guard policy and extension DDL in `DO $$ … $$` against `pg_catalog`; the applier can reject
`IF NOT EXISTS` policy DDL with SQLSTATE 42601.

### Corrections

An applied migration is **never edited**. A correction is a new file whose version sorts after the
one it corrects - `01730` corrected the invitation digest, `01880` restored a lost policy. A
correction that recreates a policy must read the **last** definition of that policy, not an earlier
migration: `01780` restored `01240`'s assignment policy and lost the `01660` clause, which the suite
caught.

## Password reset and the redirect allow-list

`app/(auth)/forgot-password/actions.ts` sends:

```
redirectTo: `${NEXT_PUBLIC_APP_URL}/api/auth/verify?next=/reset-password`
```

The hosted project must allow-list that URL, or **GoTrue refuses to send the mail**. The app recovers
the session in a route handler (`app/api/auth/verify/route.ts`) because a Server Component cannot
write the cookie; the handler matches `next` against an allow-list, so it cannot become an open
redirect.

**Measured limitation:** a reset request for an unknown address returns 200; a request for a known
account at `example.com` is refused with `email_address_invalid`. The cause was not established -
"no MX record" is the likely one and is a guess. Even with the allow-list configured, delivery
cannot be proved without a mailbox.

## Hosted deployment

- **Vercel**: the repository carries no Vercel-specific configuration, so a standard Next.js 16
  build applies. Vercel installs devDependencies for the build phase, which is why the vendored
  `app/shadcn.css` matters: a `--omit=dev` install cannot resolve `shadcn/tailwind.css` at build
  time. A self-hosted build must install devDependencies, or the vendored file is mandatory (it
  is).
- **Node**: `npm ci && npm run build && npm run start`. `next start` serves the production bundle on
  `PORT` (default 3000).
- `proxy.ts` must sit at the repository root. Next.js 16 renamed `middleware.ts` to `proxy.ts`; a
  leftover `middleware` export is silently ignored and the session simply never refreshes.
- **No `headers()` are configured.** There is no CSP, HSTS, `X-Frame-Options` or
  `X-Content-Type-Options`. A production deployment must add them at the edge or in
  `next.config.ts`. This is a real gap, not a preference.
- **Email confirmation is disabled.** Re-enabling it is mandatory before launch.

## What is deliberately absent

| Absent                      | Consequence                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment provider            | `lib/billing/` is a seam whose every method refuses. There is no Razorpay wiring and **no test mode**, and adding a fake provider fails a test |
| Mail provider               | No invitation email is sent; the owner copies the link. No reset mail is sent                                                                  |
| Queue / background worker   | Everything is request-scoped                                                                                                                   |
| Cache layer                 | No Redis, no CDN logic beyond the platform's                                                                                                   |
| Monitoring / error tracking | No Sentry, no APM, no metrics endpoint                                                                                                         |
| Rate limiting               | Only the tenant-creation cap (5 per user per 24 h) exists                                                                                      |
| Backups                     | Whatever the Supabase plan provides; this repository has no backup job                                                                         |

## Go-live checklist

The product is **not** production-ready. This list is what a launch would require, in order.

1. [ ] **Re-enable email confirmation** in the hosted project, and verify a new signup cannot sign
       in before confirming. This is the single largest security gap.
2. [ ] Add every production origin to the auth redirect allow-list, including
       `<app>/api/auth/verify`.
3. [ ] Configure a real mail provider and verify reset delivery end to end.
4. [ ] Add security headers (CSP, HSTS, frame and content-type options) and test them.
5. [ ] Add rate limiting at the edge for signup, login and reset.
6. [ ] Re-run the whole gate set: `typecheck`, `lint` (four sub-gates), `test`, `build`.
7. [ ] Run the E2E suite against the **production** build and a disposable project.
8. [ ] Apply the migrations from zero in a fresh project and verify the catalogue (16 tables, 39 + 20
       policies, 10 public RPCs).
9. [ ] Confirm backups and a restore drill. The audit table has no foreign keys and must survive a
       tenant deletion.
10. [ ] Add monitoring and an on-call runbook (see [`OPERATIONS.md`](OPERATIONS.md)).
11. [ ] Complete Phases 4–10. The clinical product does not exist yet: no patients UI, no
        appointments, no invoices, no reports, no subscriptions.
12. [ ] Add a security contact and a disclosure policy.

Do not mark an item done because the code exists. Mark it done when a named command or a named
manual check proves it.
