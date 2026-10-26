# Routes and permissions - ClinicCore foundation

Measured from `app/**`, `lib/auth/**` and `lib/permissions/registry.ts` on 2026-10-26. The
registry is the single source of truth for the matrix; `scripts/gen-permissions-sql.ts` turns it
into the seed SQL, so the TypeScript and the database cannot drift silently.

## Routes and guards

| Route                   | File                                | Guard                                                                                                |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/`                     | `app/(marketing)/page.tsx`          | **Public.** Reads no session at all; the header always offers "Sign in", even to a signed-in visitor |
| `/login`                | `app/(auth)/login/`                 | Public                                                                                               |
| `/signup`               | `app/(auth)/signup/`                | Public                                                                                               |
| `/verify`               | `app/(auth)/verify/`                | Public; reports signed-in / signed-out / provider-unavailable truthfully                             |
| `/forgot-password`      | `app/(auth)/forgot-password/`       | Public; the response is generic for a known and an unknown address                                   |
| `/reset-password`       | `app/(auth)/reset-password/`        | Public page; the action needs a recovery **session**, which it checks                                |
| `/api/auth/verify`      | `app/api/auth/verify/route.ts`      | Route handler; exchanges the recovery code and redirects only to an **allow-listed** `next`          |
| `/invite/[token]`       | `app/invite/[token]/page.tsx`       | Public page; redemption needs a signed-in session and the invitation's own address                   |
| `/app`                  | `app/app/page.tsx`                  | Session; redirects to `/app/dashboard`                                                               |
| `/app/dashboard`        | `app/app/dashboard/page.tsx`        | Session + a resolvable active organization                                                           |
| `/app/onboarding`       | `app/app/onboarding/page.tsx`       | Session                                                                                              |
| `/app/settings/members` | `app/app/settings/members/page.tsx` | Session + tenant; the **invite form** additionally asks `staff.manage`                               |
| `/platform`             | `app/platform/page.tsx`             | Platform administrator; every other caller receives `notFound()` (404)                               |

Route groups are pathless. `app/(marketing)` and `app/(auth)` add no URL segment; `app/app/` and
`app/platform/` are **real** segments, because a pathless `(platform)` group would serve `/` and
collide with the marketing root.

### The four shell states

`app/app/layout.tsx` renders one of four things, and the distinction between the first two is the
one that matters:

1. **No membership at all** → the onboarding screen, rendered instead of the shell.
2. **Memberships exist but all are hidden** → "your access is not active". A member of a suspended
   tenant, or a suspended member, sees **no** membership rows - the SELECT policy is
   `private.is_member(organization_id)`. An empty list therefore does not mean "you belong to
   nothing". `public.has_any_membership()` (a definer, so it sees the hidden rows) tells the two
   apart.
3. **Several active memberships, no choice** → the organization picker. A stale `cc_active_org`
   cookie resolves to `null` and does **not** fall back to another tenant.
4. **An active organization** → the shell.

### Known route limitations

- **Sign-in does not carry a `next`.** It always lands on `/app/dashboard`. An invited user with
  no organization yet therefore lands on onboarding and has **no route back** to the pending
  invitation. The invite link still works as a capability; the product does not carry the user to
  it.
- **`/platform` answers 404, not 403 or a redirect.** A redirect would confirm the route exists.
- **There is no route for patient data.** `patients` exists as schema and RLS only.

## The 21 permission keys

| Key                             | Description                                          | Enforced at                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `appointments.manage`           | Book, reschedule, cancel and confirm appointments    | nowhere yet (module unbuilt)                                                                                                                  |
| `audit.read`                    | Read the organization audit log                      | `audit_logs_select`                                                                                                                           |
| `billing.manage`                | Create invoices, record payments and issue refunds   | nowhere yet (module unbuilt)                                                                                                                  |
| `encounters.read`               | View clinical encounter records                      | `clinical-attachments` SELECT                                                                                                                 |
| `encounters.write`              | Create, edit and finalize clinical encounters        | `clinical-attachments` INSERT/UPDATE/DELETE                                                                                                   |
| `inventory.manage`              | Manage stock, batches, suppliers and adjustments     | nowhere yet (module unbuilt)                                                                                                                  |
| `investigations.order`          | Order laboratory and diagnostic investigations       | `investigation-reports` SELECT                                                                                                                |
| `investigations.verify`         | Verify and release results                           | `investigation-reports` INSERT/UPDATE/DELETE                                                                                                  |
| `patients.create`               | Register new patients                                | `patients_write`, `patient_identifiers_write`                                                                                                 |
| `patients.export`               | Export patient data                                  | `public.export_patients` (the definer is the enforcement point)                                                                               |
| `patients.read`                 | View patient records                                 | `patients_select`, `patient_identifiers_select`, `patient-documents` SELECT                                                                   |
| `patients.update`               | Edit patient details                                 | `patients_update`/`_delete`, `patient_identifiers_*`, `patient-documents` write                                                               |
| `platform.audit.read`           | Read platform-level audit events                     | nowhere yet (reserved)                                                                                                                        |
| `platform.subscriptions.manage` | Manage any tenant subscription                       | nowhere yet (reserved)                                                                                                                        |
| `platform.tenants.manage`       | Suspend, archive and support a tenant                | nowhere yet (reserved)                                                                                                                        |
| `platform.tenants.read`         | View the platform tenant directory                   | nowhere yet (the console asks `is_platform_admin()`, not this key)                                                                            |
| `prescriptions.create`          | Create and sign prescriptions                        | `prescription-documents`                                                                                                                      |
| `reports.view`                  | View operational and clinical reports                | nowhere yet (module unbuilt)                                                                                                                  |
| `settings.manage`               | Change organization, clinic and application settings | `organizations_update`, `clinics_update`, `roles_*`, `role_permissions_*`, `clinic_memberships_*`, `org-assets`, `public.delete_organization` |
| `staff.manage`                  | Invite staff, assign clinics and grant roles         | `organization_memberships_update`, `user_role_assignments_*`, `invitations_*`, `clinic_memberships_*`                                         |
| `subscription.manage`           | View and change the organization subscription        | nowhere yet (module unbuilt)                                                                                                                  |

A key with no enforcement point is a **seed for a later phase**, not a working control. Nine of
the 21 are in that state; do not describe them as active.

## The 15 roles

14 are seeded per tenant; `platform_super_admin` is seeded once with `organization_id NULL`.

| Role                       | Key                    | Permissions                                                                                                                                                                                                                                                                                                 | #   |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Organization Owner         | `organization_owner`   | appointments.manage, audit.read, billing.manage, encounters.read, encounters.write, inventory.manage, investigations.order, investigations.verify, patients.create, patients.export, patients.read, patients.update, prescriptions.create, reports.view, settings.manage, staff.manage, subscription.manage | 17  |
| Organization Administrator | `organization_admin`   | the same 17                                                                                                                                                                                                                                                                                                 | 17  |
| Medical Director           | `medical_director`     | appointments.manage, audit.read, encounters.read, encounters.write, investigations.order, investigations.verify, patients.create, patients.export, patients.read, patients.update, prescriptions.create, reports.view, staff.manage                                                                         | 13  |
| Clinic Administrator       | `clinic_admin`         | appointments.manage, audit.read, billing.manage, encounters.read, inventory.manage, patients.create, patients.read, patients.update, reports.view, settings.manage, staff.manage                                                                                                                            | 11  |
| Doctor                     | `doctor`               | appointments.manage, encounters.read, encounters.write, investigations.order, patients.create, patients.read, patients.update, prescriptions.create, reports.view                                                                                                                                           | 9   |
| Nurse                      | `nurse`                | appointments.manage, encounters.read, investigations.order, patients.create, patients.read, patients.update, reports.view                                                                                                                                                                                   | 7   |
| Receptionist               | `receptionist`         | appointments.manage, billing.manage, patients.create, patients.read, reports.view                                                                                                                                                                                                                           | 5   |
| Accountant                 | `accountant`           | audit.read, billing.manage, patients.read, reports.view                                                                                                                                                                                                                                                     | 4   |
| Auditor                    | `auditor`              | audit.read, encounters.read, patients.read, reports.view                                                                                                                                                                                                                                                    | 4   |
| Clinical Assistant         | `clinical_assistant`   | appointments.manage, encounters.read, investigations.order, patients.read                                                                                                                                                                                                                                   | 4   |
| Laboratory Technician      | `lab_technician`       | encounters.read, investigations.verify, patients.read, reports.view                                                                                                                                                                                                                                         | 4   |
| Billing Officer            | `billing_officer`      | billing.manage, patients.read, reports.view                                                                                                                                                                                                                                                                 | 3   |
| Inventory Manager          | `inventory_manager`    | inventory.manage, patients.read, reports.view                                                                                                                                                                                                                                                               | 3   |
| Pharmacist                 | `pharmacist`           | inventory.manage, patients.read, reports.view                                                                                                                                                                                                                                                               | 3   |
| Platform Super Admin       | `platform_super_admin` | platform.audit.read, platform.subscriptions.manage, platform.tenants.manage, platform.tenants.read                                                                                                                                                                                                          | 4   |

The matrix rulings the tests pin:

- `organization_owner` and `organization_admin` carry **byte-identical** permission sets. That is
  why the subset ceiling cannot tell them apart, and why only an owner may mint an owner.
- `auditor` is read-only plus `audit.read`; never `patients.update` or `patients.export`.
- `lab_technician` verifies investigations but never orders them and never prescribes.
- `pharmacist` manages inventory but never prescribes.
- `platform_super_admin` holds platform keys only. It must never see clinical data; do not add a
  clinical permission to it.

## `private.can` / `public.can`

`public.can(p_org_id, p_permission, p_clinic_id)` is a thin wrapper over `private.can`. The browser
asks `public.can`; it must not reimplement the rule in TypeScript. `userCan` in
`lib/auth/active-org.ts` is the one place that calls it.

The rule (in `private.can_for`, since `can` is a one-line delegation):

```
lower(p_permission) not like 'platform.%'
and is_member_for(user, org)                 -- active membership, active organization
and exists (an assignment in org for user, role belongs to org,
            carrying the permission,
            and (clinic_id is null or clinic_id = p_clinic_id))
```

Two clauses are easy to lose and both are load-bearing:

- **Org-strict.** A role of another organization does not count, even if the assignment row exists.
- **Platform-key-refusing, case-insensitively.** `permissions` is one global table with no scope
  column, so without this a tenant could attach `platform.tenants.manage` to its own role. The
  `lower()` matters because the grant match is exact text: `Platform.tenants.manage` would
  otherwise insert and match.

### The clinic parameter is `assignmentClinicId`

`userCan(permission, assignmentClinicId)` answers "is there a GRANT of this permission for this
clinic" - **not** "can the caller reach this clinic". Reach is `private.clinic_ids`, and RLS
enforces it. Measured: a user restricted to one clinic, holding an org-wide grant, answers `true`
for a clinic they cannot read. Both halves are required:

```
organization_id in current_org_ids()
and can(org, permission, clinic_id)
and clinic_id in clinic_ids(org)
```

`private.clinic_ids` returns the empty set to a non-member and never filters `clinics.is_active`, so
a deactivation does not erase access to retained records.

## Clinic scoping

- A **membership** joins a user to an organization.
- A **role assignment** carries an optional `clinic_id`. `NULL` = organization-wide.
- A **clinic membership** (`clinic_memberships`) scopes a membership to specific clinics.
- `private.clinic_ids(org)` is the set of clinics the caller can reach: an org-wide assignment or
  membership means all of them; a clinic-scoped one means that clinic.
- `switchClinic` requires the clinic to be in the **active organization**, because the `clinics`
  SELECT policy spans every organization the user belongs to. A lookup by id alone would accept the
  other tenant's clinic.

## The invitation and owner ceiling

`private.can_assign_role(org, role)` is the **single** ceiling on every grant path:
`user_role_assignments_write` and `_update`, `invitations_write` and `invitations_update`, and
`private.accept_invitation` (re-checked for the **inviter** at redemption).

It is two rules:

1. **Subset.** Every permission on the role being granted must also be held by the grantor, in that
   organization. `private.can_grant_for` owns this rule; `can_assign_role_for` adds the next one.
2. **Owner-only.** Only an existing `organization_owner` may grant `organization_owner`. The subset
   rule cannot express it, because an administrator's set is identical.

The ceiling is evaluated for the **inviter** at redemption, not at issue time, so an invitation
whose inviter has since lost the permissions is refused. That is the fail-closed direction.

`public.grantable_roles(p_org_id)` is the UI's question: which roles may this caller hand out. The
invite form offers only that list.

`invitations.clinic_ids` is refused rather than over-granted: the foundation's invite form offers
no clinic choice, and honouring the column properly needs `clinic_memberships` rows as well.
