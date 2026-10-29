# ClinicCore Clinical Core (Phases 5-6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first clinical records - patients, appointments, queue, encounters, vitals, prescriptions and laboratory investigations - on the existing tenancy, authorisation and storage foundation, without weakening any tenant or clinic boundary.

**Architecture:** Six migrations add the clinical tables, their RLS policies and three definer RPCs that change clinical state (finalize, sign, verify). Every new table carries `organization_id`, uses composite tenant foreign keys, and gets a three-clause policy (`current_org_ids` + `can(org, perm, clinic)` + `clinic_ids`). Server Components read; Server Actions validate with zod, call `requireActiveOrg()` and `userCan()`, and rely on RLS as the authority. UI follows the existing `app/app/...` shell.

**Tech Stack:** Next.js 16.4 App Router, React 19.3, TypeScript 6.0.3 (strict), Tailwind v4, Supabase Postgres with RLS, `@supabase/ssr`, zod 4, vitest 5, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-14-cliniccore-foundation-design.md` (tenancy, composite keys, authorisation funnel, storage, testing strategy) plus `docs/PRD.md` (phase table) and `lib/permissions/registry.ts` (the 21 permission keys already defined for these features).

---

## Global Constraints

- Money is `bigint` paise through `lib/utils/money.ts` (`Minor`). No floating point in a money path. Phase 5-6 introduce no price fields; this binds Phase 7.
- Every tenant-owned table carries `organization_id uuid not null references public.organizations (id)`, and every reference to another tenant row is **composite** (`organization_id, id`). A cross-tenant reference must be unrepresentable, not merely hidden.
- `private.can` is the single RLS authority. Policies never re-implement a permission rule. Clinic-scoped policies are the three-clause **conjunction**: `organization_id in (select private.current_org_ids())` AND `private.can(organization_id, '<perm>', clinic_id)` AND `clinic_id in (select private.clinic_ids(organization_id))`.
- A policy `USING` miss **filters** (zero rows, no error); a failed `WITH CHECK` and a trigger **raise**. Every refusal test asserts the correct shape, and every refusal has an authorised positive control beside it.
- Writes are gated on a **permission**, never on bare `is_member`. The membership directory is the only read that may use `is_member`.
- Migrations are applied one per Composio call (`SUPABASE_APPLY_A_MIGRATION`), never batched, and verified against `pg_policies` / `pg_proc` / `information_schema`. Files are the source of truth; an applied file is never edited, only corrected by a later file.
- New migration filenames match `/^\d{14}_[a-z][a-z0-9_]*\.sql$/` and sort after `20261014001880`. The plan uses the `2026102900xxxx` range.
- After any migration, regenerate `types/database.types.ts` (`SUPABASE_GENERATE_TYPESCRIPT_TYPES`). Its diff against the committed file is expected because prettier reformats it; never hand-edit the generated content.
- A `"use client"` file must never import from `lib/supabase/`. Server modules start with `import "server-only"`.
- Server Actions accept `FormData` as well as an object (`lib/auth/action-input.ts`); a form with neither puts the password in the query string and is forbidden.
- Do not write numerous code comments. When a comment is needed, put one block at the top saying what the file does and why.
- No hex literal and no Tailwind numeric-palette class outside the token blocks; `tests/unit/design-tokens.test.ts` enforces this.
- The six gates run **last**, immediately before a commit: `npm run typecheck && npm run lint && npm run check:secrets && npm run test && npm run build && npm run format:check`. `npm run lint` is four gates, not one.
- Two pins move with any policy migration: `tests/security/rls-policies.test.ts` (public policy catalogue) and the ledger test in `tests/security/tenant-isolation.test.ts` (public + storage total). Update both in the SAME commit as the policies.

## Review Focus

Each line is a real-world input or failure mode the spec implies but no existing test covers. Each is pinned by the task named.

1. **A user scoped to one clinic must not read a sibling clinic's clinical rows in the same tenant.** A clinic-scoped assignment plus an org-wide grant is the normal case; dropping `clinic_ids` from one policy turns it into a tenant-wide leak. Pinned in Task 2 and Task 13 (two isolating fixtures, one defended only by `can`, one only by `clinic_ids`).
2. **"Today" for an appointment list and a queue board is the CLINIC's day, not the server's.** `clinicDayBounds(zone, day)` is the only permitted boundary computation; a DST transition on local midnight must not move an appointment into the wrong day. Pinned in Task 7.
3. **A finalized encounter, a signed prescription and a verified investigation must be immutable through the ordinary UPDATE path.** A policy that only checks the permission would let a clinician edit a signed prescription. Pinned in Task 9 and Task 16.
4. **Two receptionists registering patients in the same clinic at the same time must both succeed with distinct MRNs.** A counter read then insert races; uniqueness per clinic plus a definer-owned counter is the fix, and a duplicate must surface as a retryable message, not a 500. Pinned in Task 3 and Task 5.
5. **Patient identity and clinical free text must never reach the audit log or an error message.** Audit metadata carries ids and codes only; a validation failure must not echo another tenant's existence. Pinned in Task 9 and Task 14.
6. **Archiving, not deleting, is the only patient removal the product offers.** `patient_identifiers` is ON DELETE RESTRICT, and an appointment history must survive. Pinned in Task 5.

---

## File Structure

**Migrations (source of truth, applied through Composio)**

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20261029001900_clinical_schema.sql` | `appointments`, `queue_entries`, `encounters`, `encounter_addenda`; composite FKs, checks, indexes, `updated_at` triggers |
| `supabase/migrations/20261029001910_clinical_rls.sql` | RLS enablement, grants, policies for those four tables |
| `supabase/migrations/20261029001920_patient_mrn.sql` | `private.next_patient_mrn`, the `patients` BEFORE INSERT trigger, privilege lockdown |
| `supabase/migrations/20261029001930_clinical_state_rpc.sql` | `public.finalize_encounter`, `public.add_encounter_addendum`, audit writes |
| `supabase/migrations/20261029002000_vitals_and_prescriptions.sql` | `vitals`, `prescriptions`, `prescription_items` |
| `supabase/migrations/20261029002010_vitals_prescription_rls.sql` | policies; `public.sign_prescription`; `public.cancel_prescription` |
| `supabase/migrations/20261029002020_investigations.sql` | `investigations`, `investigation_results`, `investigation_result_values` |
| `supabase/migrations/20261029002030_investigation_rls.sql` | policies; `public.verify_investigation` |

**Server modules**

| File | Responsibility |
| --- | --- |
| `lib/validation/patients.ts` | zod schemas for patient, identifier, appointment, queue, archive |
| `lib/validation/clinical.ts` | zod schemas for encounter, vitals, prescription, investigation |
| `lib/patients/queries.ts` | server-only reads: patient list/detail, identifiers, appointment history |
| `lib/clinical/queries.ts` | server-only reads: day appointments, queue, encounter, vitals, prescriptions, investigations |

**Routes**

| File | Responsibility |
| --- | --- |
| `app/app/patients/page.tsx` | list + search, archive filter |
| `app/app/patients/actions.ts` | `createPatient`, `archivePatient`, `addIdentifier` |
| `app/app/patients/new/page.tsx` + `patient-form.tsx` | registration form |
| `app/app/patients/[id]/page.tsx` | demographics, identifiers, appointments, encounters |
| `app/app/appointments/page.tsx` + `appointment-form.tsx` | day list, book, status change |
| `app/app/appointments/actions.ts` | `bookAppointment`, `setAppointmentStatus` |
| `app/app/queue/page.tsx` + `app/app/queue/actions.ts` | queue board, call/complete/skip |
| `app/app/encounters/[id]/page.tsx` + `encounter-editor.tsx` | draft editor, finalize, addenda, vitals panel |
| `app/app/encounters/actions.ts` | `saveEncounterDraft`, `finalizeEncounter`, `addAddendum`, `recordVitals` |
| `app/app/prescriptions/[id]/page.tsx` + `prescription-form.tsx` | compose, sign, print view |
| `app/app/prescriptions/actions.ts` | `createPrescription`, `signPrescription` |
| `app/app/investigations/page.tsx` + `investigation-form.tsx` | order, enter result, verify |
| `app/app/investigations/actions.ts` | `orderInvestigation`, `enterResult`, `verifyInvestigation` |

**Tests**

| File | Responsibility |
| --- | --- |
| `tests/unit/validation-patients.test.ts` | schema accept/refuse cases |
| `tests/unit/validation-clinical.test.ts` | vitals ranges, prescription and investigation schemas |
| `tests/integration/clinical-schema.test.ts` | tables, columns, composite FKs, indexes, triggers, MRN counter |
| `tests/integration/clinical-policies.test.ts` | catalogue and privilege assertions for the new policies |
| `tests/security/clinical-isolation.test.ts` | two tenants and two clinics; every new table, read and write; mutation-verified |
| `tests/e2e/patients.spec.ts` | register -> book -> encounter finalize -> addendum |
| `tests/e2e/clinical.spec.ts` | vitals, prescription sign, investigation verify |

---

## Phase 5 - Patients, appointments, queue, encounters

### Task 1: Clinical schema migration

**Files:**
- Create: `supabase/migrations/20261029001900_clinical_schema.sql`
- Test: `tests/integration/clinical-schema.test.ts`

**Interfaces:**
- Produces tables: `public.appointments`, `public.queue_entries`, `public.encounters`, `public.encounter_addenda`.
- `appointments (id, organization_id, clinic_id, patient_id, clinician_user_id uuid, scheduled_start timestamptz, scheduled_end timestamptz, status text default 'booked', reason text, notes text, created_by uuid, created_at, updated_at)`.
- `queue_entries (id, organization_id, clinic_id, patient_id, appointment_id uuid null, status text default 'waiting', queued_at, called_at, completed_at, created_by)`.
- `encounters (id, organization_id, clinic_id, patient_id, appointment_id uuid null, clinician_user_id uuid, status text default 'draft', chief_complaint text, history text, examination text, assessment text, plan text, started_at, finalized_at, finalized_by uuid, created_at, updated_at)`.
- `encounter_addenda (id, organization_id, encounter_id, author_user_id uuid, body text, created_at)`.

- [ ] **Step 1: Write the failing schema test**

In `tests/integration/clinical-schema.test.ts`, use `withClient` from `tests/integration/helpers/database.ts` and assert, from `information_schema.columns` and `pg_constraint`:
- the four tables exist with `relrowsecurity = true`;
- `appointments_patient_fkey` and `encounters_patient_fkey` are **composite** over `(organization_id, patient_id)`;
- `appointments_clinic_fkey` and `encounters_clinic_fkey` are composite over `(organization_id, clinic_id)`;
- `appointments_status_check` admits exactly `booked, confirmed, checked_in, completed, cancelled, no_show`;
- `appointments_end_after_start_check` refuses `scheduled_end <= scheduled_start`;
- `queue_entries_status_check` admits `waiting, called, in_consultation, completed, skipped`;
- `encounters_status_check` admits `draft, finalized`;
- `patients_organization_id_clinic_id_mrn_key` still exists;
- index `appointments_clinic_start_idx` exists on `(organization_id, clinic_id, scheduled_start)`;
- index `queue_open_idx` exists as a partial index on `(organization_id, clinic_id, queued_at)` where `completed_at is null`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/clinical-schema.test.ts`
Expected: FAIL - relation `public.appointments` does not exist.

- [ ] **Step 3: Write the migration**

Create the four tables in one file. Each table: `organization_id` cascade to `organizations`; composite FKs as above; `status` guarded by a named CHECK; `updated_at` maintained by the existing `public.set_updated_at()` trigger function where the table has `updated_at`; no foreign key to `auth.users` (`clinician_user_id`, `created_by`, `author_user_id` are plain `uuid` columns, matching the existing convention). `encounter_addenda` is append-only: no `updated_at`, and its `encounter_id` reference is **composite** `(organization_id, encounter_id)` to `encounters (organization_id, id)` with `on delete restrict`, so an addendum blocks a hard delete. Add a partial unique index `queue_one_open_per_patient_idx` on `(organization_id, clinic_id, patient_id)` where `completed_at is null`.

- [ ] **Step 4: Apply the migration through Composio**

One call, name exactly `20261029001900_clinical_schema.sql`, a fresh idempotency key. Then verify from the catalogue: `select relname, relrowsecurity from pg_class where relname in (...)` and `select conname, pg_get_constraintdef(oid) from pg_constraint where conname like 'appointments%'`.

- [ ] **Step 5: Re-run the schema test and regenerate types**

Run: `npx vitest run tests/integration/clinical-schema.test.ts` - PASS. Then regenerate `types/database.types.ts`; the new tables appear in the `Tables` section.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261029001900_clinical_schema.sql tests/integration/clinical-schema.test.ts types/database.types.ts
git commit -m "feat: add appointments, queue, encounters and addenda schema"
```

---

### Task 2: RLS for the Phase 5 clinical tables

**Files:**
- Create: `supabase/migrations/20261029001910_clinical_rls.sql`
- Modify: `tests/security/rls-policies.test.ts` (catalogue pin)
- Modify: `tests/security/tenant-isolation.test.ts` (ledger total)
- Test: `tests/integration/clinical-policies.test.ts`

**Interfaces:**
- Consumes: `private.current_org_ids()`, `private.can(uuid, text, uuid)`, `private.clinic_ids(uuid)`.
- Produces policy names: `appointments_select`, `appointments_write`, `appointments_update`, `appointments_delete`; `queue_entries_select`, `queue_entries_write`, `queue_entries_update`, `queue_entries_delete`; `encounters_select`, `encounters_write`, `encounters_update`; `encounter_addenda_select`, `encounter_addenda_write`.
- Permission mapping: `appointments.*` -> `appointments.manage`; `queue_entries.*` -> `appointments.manage`; `encounters_select` -> `encounters.read` OR `encounters.write` (one policy, `can(...) or can(...)`); `encounters_write` -> `encounters.write`; `encounters_update` -> `encounters.write`; `encounter_addenda_select` -> `encounters.read` or `encounters.write`; `encounter_addenda_write` -> `encounters.write`. The reference to the patient row is covered by the composite foreign key plus `clinic_ids`; an INSERT policy does not see the referenced row, and a same-tenant reference to a clinic the caller cannot reach is refused by `clinic_ids`.

- [ ] **Step 1: Write the failing policy test**

In `tests/integration/clinical-policies.test.ts`, assert from `pg_policies` that each named policy exists, is `PERMISSIVE`, and carries both `qual` and `with_check` non-null where the command needs them; assert `authenticated` holds `SELECT, INSERT, UPDATE, DELETE` on `appointments` and `queue_entries`, `SELECT, INSERT, UPDATE` on `encounters` and `encounter_addenda`, and **no** `DELETE` on `encounters` or `encounter_addenda`; assert `anon` holds none of them.

- [ ] **Step 2: Run it and confirm it fails on the missing policies**

Run: `npx vitest run tests/integration/clinical-policies.test.ts`
Expected: FAIL - expected policy `appointments_select` was not found.

- [ ] **Step 3: Write the policies**

`enable row level security` on all four tables; `revoke all ... from anon`; grant the command set above to `authenticated`. Write the three-clause conjunction exactly as the global constraint states, using `(select private.can(...))` wrappers. Every UPDATE/DELETE filter is scoped by `organization_id` as well as `id`. `encounters_update` adds `and finalized_at is null`, and its `with check` keeps `finalized_at is null` - a finalized encounter is then immutable through the ordinary path, and the definer RPC in Task 9 is the only way to finalize.

- [ ] **Step 4: Apply, verify, and update both pins**

Apply `20261029001910_clinical_rls.sql` as a single Composio call. Read the live catalogue and **count** the public policies; the expected new total is 39 + 13 = 52. Update `tests/security/rls-policies.test.ts` and the ledger in `tests/security/tenant-isolation.test.ts` (public + storage, expected 72) to the MEASURED numbers. A count that differs from the migration file is a migration defect, not a test defect.

- [ ] **Step 5: Run both suites**

Run: `npx vitest run tests/integration/clinical-policies.test.ts tests/security/rls-policies.test.ts tests/security/tenant-isolation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261029001910_clinical_rls.sql tests/integration/clinical-policies.test.ts tests/security/rls-policies.test.ts tests/security/tenant-isolation.test.ts
git commit -m "feat: add row-level security for the clinical tables"
```

---

### Task 3: MRN assignment through a definer

**Files:**
- Create: `supabase/migrations/20261029001920_patient_mrn.sql`
- Test: `tests/integration/clinical-schema.test.ts` (add cases)

**Interfaces:**
- Produces `private.next_patient_mrn(p_organization_id uuid, p_clinic_id uuid) returns text`, `security definer`, `stable`, `set search_path = ''`, revoked from `public` and `anon`, granted to `authenticated`.
- Produces trigger `patients_assign_mrn` BEFORE INSERT on `public.patients` for each row, which fires only when `new.mrn is null or btrim(new.mrn) = ''`.
- Format: `'MRN-' || lpad(sequence_value::text, 6, '0')`, where the sequence key is `'patient_mrn:' || clinic_id`.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/clinical-schema.test.ts`: insert a patient with `mrn` omitted inside a transaction as the table owner, assert the assigned value matches `^MRN-\d{6}$`; insert two patients in the same clinic and assert the numbers differ; insert into a different clinic and assert the counter is independent; call `private.next_patient_mrn` as `authenticated` for an organisation the caller does not belong to and assert it raises; call it as `anon` and assert `42501`.

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/integration/clinical-schema.test.ts`
Expected: FAIL - column `mrn` violates not-null.

- [ ] **Step 3: Implement the function and trigger**

The function checks `private.is_member_for((select auth.uid()), p_organization_id)` and `p_clinic_id in (select private.clinic_ids(p_organization_id))`, then calls the existing `private.next_sequence_value(p_organization_id, 'patient_mrn:' || p_clinic_id::text)`. The trigger is a `security definer` function that calls `private.next_patient_mrn(new.organization_id, new.clinic_id)`. Do not expose the counter itself; `patients.mrn` remains writable on INSERT only because the trigger fills it, and the UPDATE policy may not change it - add `mrn` to the frozen columns by refusing `mrn is distinct from` in `encounters`-style trigger? No: add `patients_guard_mrn` BEFORE UPDATE raising when `new.mrn is distinct from old.mrn`.

- [ ] **Step 4: Apply, verify `md5(prosrc)`, rerun**

Apply `20261029001920_patient_mrn.sql`. Record `md5(prosrc)` for both functions in `docs/IMPLEMENTATION_STATUS.md`. Run the test - PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261029001920_patient_mrn.sql tests/integration/clinical-schema.test.ts docs/IMPLEMENTATION_STATUS.md
git commit -m "feat: assign patient MRNs through a definer-owned counter"
```

---

### Task 4: Validation schemas and patient reads

**Files:**
- Create: `lib/validation/patients.ts`, `lib/patients/queries.ts`
- Test: `tests/unit/validation-patients.test.ts`

**Interfaces:**
- `patientInputSchema`: `{ firstName: string 1-120, lastName: string 1-120, dateOfBirth: YYYY-MM-DD | null, sex: 'female'|'male'|'other'|'unknown'|null, phone: string | null, email: string | null, clinicId: uuid, identifiers: Array<{ kind: string 1-40, value: string 1-120 }> }`.
- `appointmentInputSchema`: `{ patientId: uuid, clinicId: uuid, clinicianUserId: uuid, startsAt: ISO datetime, durationMinutes: 5-240, reason: string | null }`.
- `queueInputSchema`, `archiveInputSchema` (patient id + reason code), `identifierInputSchema`.
- `listPatients({ search, includeArchived })`, `getPatientDetail(patientId)`, `listPatientAppointments(patientId)` - all `server-only`, all scoped to the active organization and the reachable clinics by RLS, returning `null` for a missing patient rather than throwing.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/validation-patients.test.ts` asserts: a valid payload parses; an empty first name is refused; `dateOfBirth` in the future is refused; an invalid clinic id is refused; a 241-minute appointment is refused; an ISO string without a zone offset is refused; `identifiers` may be empty but a 0-length value is refused; the archive schema requires a reason code from a fixed list.

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/unit/validation-patients.test.ts`
Expected: FAIL - cannot resolve `@/lib/validation/patients`.

- [ ] **Step 3: Implement the schemas and queries**

Follow `lib/validation/invitations.ts` for style: zod objects, `.trim()`, explicit messages. Dates are strings at the boundary; the query layer converts to `date`. Queries start with `import "server-only"` and use `createServerClient()`; they take the active org from `getActiveOrg()` (return `[]` when there is no active org, never guess).

- [ ] **Step 4: Run it, expect pass**

Run: `npx vitest run tests/unit/validation-patients.test.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/validation/patients.ts lib/patients/queries.ts tests/unit/validation-patients.test.ts
git commit -m "feat: add patient validation and read queries"
```

---

### Task 5: Patient list and registration UI

**Files:**
- Create: `app/app/patients/page.tsx`, `app/app/patients/actions.ts`, `app/app/patients/new/page.tsx`, `app/app/patients/new/patient-form.tsx`
- Test: `tests/e2e/patients.spec.ts`

**Interfaces:**
- `createPatient(input: unknown): Promise<{ ok: true; patientId: string } | { ok: false; error: string }>`, accepts `FormData` and an object through `lib/auth/action-input.ts`; requires `requireActiveOrg()` and `userCan(org.id, "patients.create", clinicId)`; maps `23505` on `patients_organization_id_clinic_id_mrn_key` to "Could not allocate a record number. Try again." and never echoes the constraint name.
- `archivePatient`, `addIdentifier` in the same file with the same result shape.

- [ ] **Step 1: Write the failing E2E test**

`tests/e2e/patients.spec.ts` creates an account and organization through the existing helper, opens `/app/patients/new`, fills the form, submits, asserts the redirect to `/app/patients` and the new row visible; asserts a patient with no identifiers still lists; archives the patient and asserts it disappears from the default list but appears with `?archived=1`. Also asserts the list is empty for a second organization.

- [ ] **Step 2: Run it, expect failure**

Run: `npx playwright test tests/e2e/patients.spec.ts`
Expected: FAIL - `/app/patients/new` answers 404.

- [ ] **Step 3: Implement the pages and actions**

Server Component list reads through `listPatients`. The form is a Client Component using `useActionState` inside `startTransition` (the measured pattern from the auth pages), dispatches a Server Action, and shows field errors from zod. The archive button is a form with a confirm dialog. No `type="submit"` ambiguity: give every submit button an explicit accessible name. Use the same card surface and spacing as `/app/settings/members`.

- [ ] **Step 4: Run the gate pairs**

Run: `npx vitest run` and `npx playwright test tests/e2e/patients.spec.ts` - PASS. No build run yet.

- [ ] **Step 5: Commit**

```bash
git add app/app/patients tests/e2e/patients.spec.ts
git commit -m "feat: add patient registration and list"
```

---

### Task 6: Patient detail page

**Files:**
- Create: `app/app/patients/[id]/page.tsx`
- Modify: `lib/patients/queries.ts` (add identifiers and encounter summary)
- Test: `tests/e2e/patients.spec.ts` (extend)

**Interfaces:**
- `getPatientDetail(patientId): Promise<PatientDetail | null>` where `PatientDetail` includes `{ patient, identifiers, appointments, encounters }`, each array already RLS-filtered.
- The page calls `notFound()` for `null`, so another tenant's id is indistinguishable from a missing one.

- [ ] **Step 1: Extend the failing test**

Assert that opening a patient's detail shows the MRN, the identifiers added in Task 5, the booked appointment from Task 7 when it exists, and that a random UUID answers 404.

- [ ] **Step 2: Run it, confirm 404 for the real route**

Run: `npx playwright test tests/e2e/patients.spec.ts`
Expected: FAIL - `[id]` route missing.

- [ ] **Step 3: Implement the page**

Use `PageHeader`, `EmptyState`, and the existing card style. Sections: demographics, identifiers, appointments, encounters. No patient name in `<title>` beyond the page's own heading; do not put the MRN in the URL. No edit form yet beyond identifiers - updating demographics is a later task if needed; if added, it uses `patients.update`.

- [ ] **Step 4: Run it, expect pass**

Run: `npx playwright test tests/e2e/patients.spec.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/patients/[id]/page.tsx lib/patients/queries.ts tests/e2e/patients.spec.ts
git commit -m "feat: add patient detail page"
```

---

### Task 7: Appointments - day view and booking

**Files:**
- Create: `app/app/appointments/page.tsx`, `app/app/appointments/appointment-form.tsx`, `app/app/appointments/actions.ts`
- Modify: `lib/patients/queries.ts` (or `lib/clinical/queries.ts`) with `listDayAppointments`
- Test: `tests/unit/appointment-day.test.ts`, `tests/e2e/patients.spec.ts` (extend)

**Interfaces:**
- `listDayAppointments({ clinicId, day }): Promise<AppointmentRow[]>` where `day` is `YYYY-MM-DD` in the CLINIC's zone, converting with `clinicDayBounds(timezone, day)` from `lib/utils/datetime.ts`.
- `bookAppointment`, `setAppointmentStatus` Server Actions returning the same result union.
- Status transitions are validated in TypeScript AND in SQL: `booked -> confirmed|cancelled`, `confirmed -> checked_in|cancelled|no_show`, `checked_in -> completed|cancelled`.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/appointment-day.test.ts` stubs the Supabase client and asserts `listDayAppointments` queries `scheduled_start >= bounds.start` and `< bounds.end`, with both instants taken from `clinicDayBounds('Asia/Kolkata', '2026-11-01')`; a second case uses `America/Santiago` on a DST date and asserts the bounds differ from a fixed 24-hour window.

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/unit/appointment-day.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the query, page and actions**

The page takes `?day=YYYY-MM-DD` (defaults to the clinic's current day, computed with `Intl.DateTimeFormat` in the clinic zone, never `new Date().toISOString().slice(0,10)`). Booking validates the appointment schema, checks `userCan(org.id, 'appointments.manage', clinicId)`, and lets the DB check the end-after-start rule. A status change is a small form per row with an accessible name that includes the patient's MRN.

- [ ] **Step 4: Run the unit test and E2E**

Run: `npx vitest run tests/unit/appointment-day.test.ts` and `npx playwright test tests/e2e/patients.spec.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/appointments lib/patients/queries.ts tests/unit/appointment-day.test.ts tests/e2e/patients.spec.ts
git commit -m "feat: add appointment day view and booking"
```

---

### Task 8: Queue board

**Files:**
- Create: `app/app/queue/page.tsx`, `app/app/queue/actions.ts`
- Test: `tests/e2e/patients.spec.ts` (extend)

**Interfaces:**
- `listQueue({ clinicId }): Promise<QueueRow[]>` ordered by `queued_at`, excluding `completed_at is not null`.
- `addToQueue({ patientId, clinicId, appointmentId? })`, `setQueueStatus({ entryId, status })`; transitions `waiting -> called|skipped`, `called -> in_consultation|skipped`, `in_consultation -> completed`.

- [ ] **Step 1: Extend the failing test**

Assert that checking in an appointment adds one queue row; that calling it moves it to the "in consultation" column and stamps `called_at`; that completing it removes it from the board; that a second open entry for the same patient in the same clinic is refused with a readable message (the partial unique index).

- [ ] **Step 2: Run it, expect failure**

Run: `npx playwright test tests/e2e/patients.spec.ts`
Expected: FAIL - `/app/queue` 404.

- [ ] **Step 3: Implement the board and actions**

Three columns (waiting, called, in consultation) with a card per patient, MRN visible, no auto-refresh in this release - state that in the page description. Actions are forms; no client polling. `setQueueStatus` checks the permission and maps `23505` for the duplicate-open-entry case.

- [ ] **Step 4: Run it, expect pass**

Run: `npx playwright test tests/e2e/patients.spec.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/queue tests/e2e/patients.spec.ts
git commit -m "feat: add the clinic queue board"
```

---

### Task 9: Encounters - draft, finalize, addenda

**Files:**
- Create: `supabase/migrations/20261029001930_clinical_state_rpc.sql`
- Create: `app/app/encounters/[id]/page.tsx`, `app/app/encounters/encounter-editor.tsx`, `app/app/encounters/actions.ts`
- Create: `lib/validation/clinical.ts`, `lib/clinical/queries.ts`
- Test: `tests/integration/clinical-policies.test.ts` (extend), `tests/e2e/patients.spec.ts` (extend), `tests/unit/validation-clinical.test.ts`

**Interfaces:**
- `public.finalize_encounter(p_encounter_id uuid) returns void`; requires `encounters.write` in the encounter's organization AND clinic reach; refuses when `finalized_at is not null`; stamps `finalized_at`, `finalized_by = auth.uid()`; writes audit action `encounter.finalized` with metadata `{ encounter_id }`.
- `public.add_encounter_addendum(p_encounter_id uuid, p_body text) returns uuid`; requires `encounters.write` and a finalized encounter; writes audit `encounter.addendum` with `{ encounter_id, addendum_id }`.
- `encounterDraftSchema`: `{ chiefComplaint, history, examination, assessment, plan }` each `string <= 8000 | null`.
- Server actions `saveEncounterDraft`, `finalizeEncounter`, `addAddendum`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/clinical-policies.test.ts`: a clinician can update a draft encounter; the same clinician's direct UPDATE of a finalized encounter affects zero rows AND leaves the row unchanged; `finalize_encounter` succeeds once and raises on the second call; `encounter_addenda` INSERT is refused for a user without `encounters.write`. `tests/unit/validation-clinical.test.ts`: an 8001-character field is refused. `tests/e2e/patients.spec.ts`: book, check in, open the encounter from the queue, save a draft, finalize, assert the editor becomes read-only and the addendum form appears.

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run tests/unit/validation-clinical.test.ts tests/integration/clinical-policies.test.ts` - FAIL.

- [ ] **Step 3: Implement the RPC, queries, pages and actions**

The RPCs are `security definer`, `set search_path = ''`, and check `private.can` themselves (RLS is bypassed for a definer). The audit calls reject prose - every metadata value is a uuid. The editor is a Client Component with two modes: editable while `status = 'draft'`, read-only after finalize, with the addendum form below. The action calls the RPC and revalidates the path.

- [ ] **Step 4: Apply the migration, verify, run the tests**

Apply `20261029001930_clinical_state_rpc.sql`; record `md5(prosrc)` for both functions; verify the audit rows exist with metadata keys `encounter_id` / `addendum_id`. Run: `npx vitest run tests/unit/validation-clinical.test.ts tests/integration/clinical-policies.test.ts` and `npx playwright test tests/e2e/patients.spec.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261029001930_clinical_state_rpc.sql app/app/encounters lib/validation/clinical.ts lib/clinical/queries.ts tests
git commit -m "feat: add encounter drafting, finalisation and addenda"
```

---

### Task 10: Phase 5 isolation suite and gate

**Files:**
- Create: `tests/security/clinical-isolation.test.ts`
- Modify: `tests/security/mutation-harness.ts` only if a new mutation shape is needed
- Modify: `docs/IMPLEMENTATION_STATUS.md`, `docs/RLS_POLICIES.md`, `docs/DATABASE_SCHEMA.md`, `docs/ROUTES_AND_PERMISSIONS.md`

**Interfaces:**
- Uses `seedTwoOrganizations`, `withPrincipal`, `expectRejection`, `withMutation` from the existing security fixtures/harness.
- Seed adds: two clinics per tenant, one patient per clinic, one appointment, one queue entry, one encounter per tenant.

- [ ] **Step 1: Write the failing isolation tests**

For each new table: tenant A reads zero of B's rows by primary key; a cross-tenant UPDATE and DELETE touch zero rows; a cross-tenant INSERT is refused by policy or composite FK; a clinic-scoped user in A reads only their clinic's rows (two isolating fixtures - one defended only by `can`, one only by `clinic_ids`); a finalize call against B's encounter raises. Each refusal has an authorised twin on the tenant's own row.

- [ ] **Step 2: Run it, expect the leak assertions to fail against a deliberately loosened policy**

Mutation-verify at least: `appointments_select`, `appointments_write`, `encounters_select`, `encounters_update` (drop the `finalized_at is null` clause), `encounter_addenda_write`. Each mutation records the break it must produce; the harness rejects an unexpected break.

- [ ] **Step 3: Restore and re-run**

Every mutation rolls back in its transaction; the ledger test re-reads `pg_policies` on the outer session and pins the exact new total.

- [ ] **Step 4: Update the docs**

`RLS_POLICIES.md` gains the new policy table and the rule each enforces; `DATABASE_SCHEMA.md` gains the four tables, composite FKs and indexes; `ROUTES_AND_PERMISSIONS.md` gains the five routes and their permission; `IMPLEMENTATION_STATUS.md` records the migration names, `md5(prosrc)` values and the mutation list.

- [ ] **Step 5: Run all six gates, immediately before the commit**

Run: `npm run typecheck && npm run lint && npm run check:secrets && npm run test && npm run build && npm run format:check`
Expected: all exit 0. Read each exit code; do not infer it from the output.

- [ ] **Step 6: Commit**

```bash
git add tests/security docs
git commit -m "test: prove the clinical tenant and clinic boundaries"
```

---

## Phase 6 - Vitals, prescriptions, laboratory

### Task 11: Vitals schema and UI

**Files:**
- Create: `supabase/migrations/20261029002000_vitals_and_prescriptions.sql` (BOTH the `vitals` and the `prescriptions`/`prescription_items` tables; the policies and RPCs follow in `02010`)
- Modify: `app/app/encounters/[id]/page.tsx`, `app/app/encounters/actions.ts`
- Test: `tests/integration/clinical-schema.test.ts`, `tests/unit/validation-clinical.test.ts`, `tests/e2e/clinical.spec.ts`

**Interfaces:**
- `vitals (id, organization_id, clinic_id, patient_id, encounter_id uuid null, recorded_by uuid, measured_at timestamptz default now(), temperature_c numeric(4,1), systolic integer, diastolic integer, pulse integer, respiratory_rate integer, spo2 integer, weight_kg numeric(5,2), height_cm numeric(5,2), created_at)`.
- Checks: `temperature_c between 25 and 45`, `systolic between 40 and 300`, `diastolic between 20 and 200`, `systolic > diastolic`, `pulse between 20 and 250`, `respiratory_rate between 4 and 80`, `spo2 between 50 and 100`, `weight_kg between 0.5 and 400`, `height_cm between 20 and 260`.
- `vitalsInputSchema` with the same ranges, nullable fields allowed, at least one measurement required.
- `recordVitals` Server Action requiring `encounters.write`.

- [ ] **Step 1: Write the failing tests**

Schema test asserts the table, the composite FKs to patients/clinics/encounters, and every named CHECK. Unit test asserts each range boundary: 45.1 refused, 45 accepted, spo2 101 refused, systolic 100 / diastolic 120 refused. E2E records vitals on a draft encounter and asserts they render on the page and are absent from the audit log.

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run tests/unit/validation-clinical.test.ts tests/integration/clinical-schema.test.ts` and `npx playwright test tests/e2e/clinical.spec.ts` - FAIL.

- [ ] **Step 3: Implement schema, policy, validation and UI**

Policies: `vitals_select` (`encounters.read` or `encounters.write`), `vitals_write` (`encounters.write`), `vitals_update` (`encounters.write` and not finalized via the encounter join through `private.can` + `clinic_ids`). The panel is a small form on the encounter page; values are `numeric` strings end to end, never `number` in a money-style path (there is no money here, but keep decimals as strings to avoid float drift).

- [ ] **Step 4: Apply, verify, run the tests**

Apply `20261029002000_vitals_and_prescriptions.sql` as one Composio call; it adds the `vitals`, `prescriptions` and `prescription_items` tables with their constraints and indexes, and no policies yet. Verify the three tables from `pg_class` and the composite FKs from `pg_constraint`. Run the three tests - the schema and unit cases PASS; the E2E case still fails until Task 12 adds the route.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261029002000_vitals_and_prescriptions.sql app/app/encounters lib/validation/clinical.ts tests
git commit -m "feat: record patient vitals on an encounter"
```

---

### Task 12: Prescriptions - compose, sign, cancel

**Files:**
- Create: `supabase/migrations/20261029002010_vitals_prescription_rls.sql` (policies + `public.sign_prescription` + `public.cancel_prescription`)
- Create: `app/app/prescriptions/[id]/page.tsx`, `app/app/prescriptions/prescription-form.tsx`, `app/app/prescriptions/actions.ts`
- Test: `tests/integration/clinical-policies.test.ts`, `tests/e2e/clinical.spec.ts`

**Interfaces:**
- `prescriptions (id, organization_id, clinic_id, patient_id, encounter_id, prescriber_user_id, status text default 'draft', notes text, signed_at, cancelled_at, created_at, updated_at)`; status CHECK `draft, signed, cancelled`.
- `prescription_items (id, organization_id, prescription_id, drug_name text not null, dose text, route text, frequency text, duration_days integer, quantity integer, instructions text, position integer not null)`; composite FK `(organization_id, prescription_id)`; unique `(prescription_id, position)`.
- `public.sign_prescription(p_prescription_id uuid)`: requires `prescriptions.create`; refuses a non-draft; stamps `signed_at` and `prescriber_user_id = auth.uid()`; audit `prescription.signed`.
- `public.cancel_prescription(p_prescription_id uuid, p_reason_code text)`: requires `prescriptions.create`; only a signed prescription; audit `prescription.cancelled` with `{ prescription_id, reason_code }`.

- [ ] **Step 1: Write the failing tests**

Isolation: a direct UPDATE of a signed prescription affects zero rows and leaves the row unchanged; `sign_prescription` succeeds once and refuses the second call; a `nurse` (no `prescriptions.create`) is refused on both the direct write and the RPC; cancelling requires a reason code from the fixed list. Unit: an item with an empty `drug_name` refused; duration 0 refused.

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run tests/integration/clinical-policies.test.ts tests/unit/validation-clinical.test.ts` - FAIL.

- [ ] **Step 3: Implement the migration, RPCs and pages**

Policies: `prescriptions_select` (`prescriptions.create` or `encounters.read`), `prescriptions_write` (`prescriptions.create`, draft only), `prescriptions_update` (draft only), `prescription_items_select` (follows the parent), `prescription_items_write`, `prescription_items_update`, `prescription_items_delete` (all draft-parent only). The print view is a Server Component with `@media print` styles, no PDF generation in this phase. The prescription page shows the drug list, a sign button with a confirm, and a cancel form once signed.

- [ ] **Step 4: Apply, verify, run**

Apply the migration; record `md5(prosrc)`; run the tests and `npx playwright test tests/e2e/clinical.spec.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261029002010_vitals_prescription_rls.sql app/app/prescriptions tests
git commit -m "feat: add prescriptions with signing and cancellation"
```

---

### Task 13: Laboratory investigations - order, result, verify

**Files:**
- Create: `supabase/migrations/20261029002020_investigations.sql`, `supabase/migrations/20261029002030_investigation_rls.sql`
- Create: `app/app/investigations/page.tsx`, `app/app/investigations/investigation-form.tsx`, `app/app/investigations/actions.ts`
- Test: `tests/integration/clinical-policies.test.ts`, `tests/unit/validation-clinical.test.ts`, `tests/e2e/clinical.spec.ts`

**Interfaces:**
- `investigations (id, organization_id, clinic_id, patient_id, encounter_id uuid null, ordered_by uuid, kind text not null check in ('laboratory','imaging'), test_name text not null, status text default 'ordered' check in ('ordered','collected','resulted','verified','cancelled'), ordered_at, collected_at, resulted_at, verified_at, verified_by, created_at, updated_at)`.
- `investigation_results (id, organization_id, investigation_id, entered_by uuid, entered_at, summary text, created_at)`; one per investigation via unique `(organization_id, investigation_id)`.
- `investigation_result_values (id, organization_id, result_id, analyte text not null, value text not null, unit text, reference_range text, position integer not null)`; unique `(result_id, position)`.
- `public.verify_investigation(p_investigation_id uuid)`: requires `investigations.verify`; refuses unless status is `resulted`; stamps `verified_at`, `verified_by = auth.uid()`, status `verified`; audit `investigation.verified`.
- `orderInvestigation` requires `investigations.order`; `enterResult` requires `investigations.verify` (the lab enters its own result) and moves `ordered|collected -> resulted`.

- [ ] **Step 1: Write the failing tests**

Isolation: `lab_technician` can read an investigation and enter a result, but cannot order one; `doctor` can order but cannot verify; a direct UPDATE of a verified investigation affects zero rows; verify twice raises; a cross-tenant verify raises. Unit: an investigation with an empty `test_name` refused; `kind` outside the two values refused; a result with zero analyte rows refused (the action requires at least one).

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run tests/unit/validation-clinical.test.ts tests/integration/clinical-policies.test.ts` - FAIL.

- [ ] **Step 3: Implement the migrations, RPC and pages**

Policies: `investigations_select` (`investigations.order` or `investigations.verify` or `encounters.read`), `investigations_write` (`investigations.order`), `investigations_update` (`investigations.verify`, only while not verified); `investigation_results_select` and `_write` follow the parent through the same join; `investigation_result_values_*` likewise. The list page filters by status and kind; result entry is a repeatable analyte rows form (use `useFieldArray` from react-hook-form, already a dependency); verification is a button with a confirm.

- [ ] **Step 4: Apply both migrations, verify, run**

Apply each in its own Composio call. Record `md5(prosrc)`. Run the tests - PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261029002020_investigations.sql supabase/migrations/20261029002030_investigation_rls.sql app/app/investigations tests
git commit -m "feat: add laboratory investigations and result verification"
```

---

### Task 14: Clinical document attachments

**Files:**
- Create: `app/app/patients/[id]/attachments.tsx`, `app/app/patients/attachment-actions.ts`
- Modify: `lib/patients/queries.ts` (list objects), `types/database.types.ts` (no change - storage is not generated)
- Test: `tests/e2e/clinical.spec.ts` (extend), `tests/integration/clinical-policies.test.ts` (extend)

**Interfaces:**
- `uploadAttachment({ patientId, clinicId, kind, file })` where `kind` is one of `patient-documents`, `clinical-attachments`, `investigation-reports`, `prescription-documents`; object path `${orgId}/${clinicId}/${crypto.randomUUID()}-${sanitisedName}`; uses the browser client, so the INSERT policy on `storage.objects` is the authority.
- `listAttachments(patientId)` reads only objects under the active org/clinic prefix and returns `{ name, path, createdAt }`.

- [ ] **Step 1: Write the failing test**

Assert the five-bucket policy already covers the paths this UI writes (bucket name + prefix); assert a JPEG upload succeeds for a user holding `patients.update`, and a `.exe` upload is refused by the MIME allowlist; assert a cross-tenant path is refused with zero objects written.

- [ ] **Step 2: Run it, expect failure**

Run: `npx playwright test tests/e2e/clinical.spec.ts` - FAIL - attachment UI missing.

- [ ] **Step 3: Implement the upload UI**

Client Component with a file input per kind, a progress-free submit (no provider, no queue), and an error message that names the allowlist (PDF, JPEG, PNG, DICOM, text). Never construct the path from a user-supplied segment: the filename is sanitised and the two leading segments come from the active org and clinic. Delete is NOT offered in this phase; list only.

- [ ] **Step 4: Run it, expect pass**

Run: `npx playwright test tests/e2e/clinical.spec.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/patients lib/patients/queries.ts tests
git commit -m "feat: attach clinical documents to a patient"
```

---

### Task 15: Phase 6 isolation suite, docs and final gate

**Files:**
- Modify: `tests/security/clinical-isolation.test.ts`, `tests/security/tenant-isolation.test.ts` (ledger), `tests/security/rls-policies.test.ts` (catalogue)
- Modify: `docs/IMPLEMENTATION_STATUS.md`, `docs/RLS_POLICIES.md`, `docs/DATABASE_SCHEMA.md`, `docs/ROUTES_AND_PERMISSIONS.md`, `docs/TESTING.md`, `docs/PRD.md` (phase status), `AGENTS.md` (new traps, if any were measured)

**Interfaces:**
- Final expected catalogue: public policies = 39 + 13 (Phase 5) + the Phase 6 set; **MEASURE it from `pg_policies` and record the number**, never assert a guessed total.

- [ ] **Step 1: Extend the isolation suite**

For `vitals`, `prescriptions`, `prescription_items`, `investigations`, `investigation_results`, `investigation_result_values`: cross-tenant read/write/delete refusals with authorised twins, the clinic-scoped fixture, and the signed/verified immutability assertions. Mutation-verify `prescriptions_update`, `prescription_items_delete`, `investigations_update` and `investigation_results_write`.

- [ ] **Step 2: Run the security suites**

Run: `npx vitest run tests/security` and record the total mutations. The report file goes to the OS temp directory; also pin the mutation count in the suite's ledger assertion.

- [ ] **Step 3: Update every document that states the foundation's scope**

`PRD.md`'s deferred table moves Phases 5-6 to "as built", with a link to this plan; `DATABASE_SCHEMA.md` gains the ten new tables; `ROUTES_AND_PERMISSIONS.md` gains the routes; `TESTING.md` gains the new suites; `IMPLEMENTATION_STATUS.md` records every migration, `md5(prosrc)`, the measured policy totals, the mutation list and any BLOCKED item (an empty clinical UI state is not a blocker, it is a state).

- [ ] **Step 4: Run the six gates last**

Run: `npm run typecheck && npm run lint && npm run check:secrets && npm run test && npm run build && npm run format:check`
Expected: all exit 0. `npm run format` after any markdown edit, then re-run `format:check`.

- [ ] **Step 5: Commit**

```bash
git add tests/security docs AGENTS.md
git commit -m "test: close the clinical isolation surface and record phases 5-6"
```

---

## Self-Review Notes

- **Spec coverage:** every deferred item in `docs/PRD.md` for Phases 5-6 maps to a task: patients (Tasks 1, 3-6), appointments (Tasks 1, 2, 7), queue (Tasks 1, 2, 8), encounters (Tasks 1, 2, 9), vitals (Task 11), prescriptions (Task 12), laboratory (Task 13), attachments (Task 14), isolation proof (Tasks 10, 15).
- **Deliberately not in this plan:** any billing, inventory, subscription, reports, notifications or export UI (Phases 7-9); appointment reminders (no mail provider); a drug catalogue (Phase 7 inventory); reading `patient_identifiers` in a searchable index (the kind/value unique key exists, but no UI search).
- **Deliberately not fixed:** `login` still does not carry a `next`, so an invited user still lands on the dashboard; that is a recorded carry-over, not part of this work.
- **The policy-count pins are the most likely thing to break.** Any migration that adds or drops a policy must update `rls-policies.test.ts` and the isolation ledger in the same commit; a mismatch means the database and the test disagree about what is protected.
