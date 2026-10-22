/**
 * ClinicCore permission registry - the single source of truth for the role × permission
 * matrix.
 *
 * WHY THIS FILE EXISTS. The matrix is defined once, here, in TypeScript.
 * `scripts/gen-permissions-sql.ts` turns it into the seed SQL that
 * `supabase/migrations/` inlines, and the UI consults these same constants. A second
 * hand-maintained copy in SQL - or a third in the UI - would drift; deriving every
 * consumer from this file makes divergence structurally impossible.
 *
 * SECURITY-CRITICAL INVARIANT. `platform_super_admin` holds platform-console
 * permissions ONLY. Platform operators see the tenant directory, subscription and usage -
 * never a tenant's patient records. Do not add clinical permissions to that role.
 *
 * GRANT-CEILING OBLIGATION. `staff.manage` is flat in the registry's terms: any holder
 * can, on paper, grant any role - including `organization_owner`. The registry cannot
 * express hierarchy, so the invite and role-assignment flow that consumes it MUST enforce
 * a ceiling: a grantor may never assign a role whose privileges exceed their own, and in
 * particular only an existing `organization_owner` may mint another `organization_owner`.
 * The database owns that check (`private.can_assign_role`); do not assume this file
 * provides it.
 *
 * THE MATRIX RULINGS THE TESTS PIN EXPLICITLY.
 *  - `organization_owner` and `organization_admin` hold every non-platform permission and
 *    no platform permission - byte-identical sets, which is why only an owner may mint
 *    an owner;
 *  - `auditor` is read-only viewing plus `audit.read` - never `patients.update` or
 *    `patients.export`;
 *  - `lab_technician` fulfils investigation orders (verifies results) but never places
 *    them and never prescribes - `investigations.order` belongs to the clinicians who
 *    order the test, not the lab that runs it;
 *  - `pharmacist` manages inventory but never prescribes;
 *  - `platform_super_admin` is confined to the four platform-console permissions - it must
 *    never see clinical data.
 *
 * THE SHAPES BELOW. `RegistryInput` is the shape the SQL generator accepts; the real
 * registry satisfies it, and the tests pass synthetic registries through it to pin the
 * generator's validation and determinism. `PERMISSIONS` is sorted by key, but only for
 * convenience - the generator re-sorts regardless. `hasPermission` FAILS CLOSED: an
 * unrecognised role key or permission key denies rather than throws, so a caller passing
 * garbage can never get a grant out of it.
 */

export type PermissionKey = `${string}.${string}`;

export type RoleKey =
  | "accountant"
  | "auditor"
  | "billing_officer"
  | "clinic_admin"
  | "clinical_assistant"
  | "doctor"
  | "inventory_manager"
  | "lab_technician"
  | "medical_director"
  | "nurse"
  | "organization_admin"
  | "organization_owner"
  | "pharmacist"
  | "platform_super_admin"
  | "receptionist";

export interface PermissionDefinition {
  readonly key: PermissionKey;
  readonly description: string;
}

export interface RoleDefinition {
  readonly key: RoleKey;
  readonly name: string;
  /** Platform roles are seeded once at `organization_id NULL`, never per tenant. */
  readonly isPlatform: boolean;
  readonly permissions: readonly PermissionKey[];
}

export interface RegistryInput {
  readonly permissions: readonly PermissionDefinition[];
  readonly roles: readonly RoleDefinition[];
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  { key: "appointments.manage", description: "Book, reschedule, cancel and confirm appointments" },
  { key: "audit.read", description: "Read the organization audit log" },
  { key: "billing.manage", description: "Create invoices, record payments and issue refunds" },
  { key: "encounters.read", description: "View clinical encounter records" },
  { key: "encounters.write", description: "Create, edit and finalize clinical encounter records" },
  { key: "inventory.manage", description: "Manage stock, batches, suppliers and adjustments" },
  { key: "investigations.order", description: "Order laboratory and diagnostic investigations" },
  {
    key: "investigations.verify",
    description: "Verify and release laboratory and diagnostic results",
  },
  { key: "patients.create", description: "Register new patients" },
  { key: "patients.export", description: "Export patient data from the organization" },
  { key: "patients.read", description: "View patient records" },
  { key: "patients.update", description: "Edit patient demographic and clinical details" },
  { key: "platform.audit.read", description: "Read platform-level audit events" },
  { key: "platform.subscriptions.manage", description: "Manage any tenant subscription state" },
  { key: "platform.tenants.manage", description: "Suspend, archive and support any tenant" },
  { key: "platform.tenants.read", description: "View the platform tenant directory" },
  { key: "prescriptions.create", description: "Create and sign prescriptions" },
  { key: "reports.view", description: "View operational and clinical reports" },
  { key: "settings.manage", description: "Change organization, clinic and application settings" },
  { key: "staff.manage", description: "Invite staff, assign clinics and grant roles" },
  { key: "subscription.manage", description: "View and change the organization subscription" },
];

export const ROLES: readonly RoleDefinition[] = [
  {
    key: "accountant",
    name: "Accountant",
    isPlatform: false,
    permissions: ["audit.read", "billing.manage", "patients.read", "reports.view"],
  },
  {
    key: "auditor",
    name: "Auditor",
    isPlatform: false,
    permissions: ["audit.read", "encounters.read", "patients.read", "reports.view"],
  },
  {
    key: "billing_officer",
    name: "Billing Officer",
    isPlatform: false,
    permissions: ["billing.manage", "patients.read", "reports.view"],
  },
  {
    key: "clinic_admin",
    name: "Clinic Administrator",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "audit.read",
      "billing.manage",
      "encounters.read",
      "inventory.manage",
      "patients.create",
      "patients.read",
      "patients.update",
      "reports.view",
      "settings.manage",
      "staff.manage",
    ],
  },
  {
    key: "clinical_assistant",
    name: "Clinical Assistant",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "encounters.read",
      "investigations.order",
      "patients.read",
    ],
  },
  {
    key: "doctor",
    name: "Doctor",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "encounters.read",
      "encounters.write",
      "investigations.order",
      "patients.create",
      "patients.read",
      "patients.update",
      "prescriptions.create",
      "reports.view",
    ],
  },
  {
    key: "inventory_manager",
    name: "Inventory Manager",
    isPlatform: false,
    permissions: ["inventory.manage", "patients.read", "reports.view"],
  },
  {
    key: "lab_technician",
    name: "Laboratory Technician",
    isPlatform: false,
    permissions: ["encounters.read", "investigations.verify", "patients.read", "reports.view"],
  },
  {
    key: "medical_director",
    name: "Medical Director",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "audit.read",
      "encounters.read",
      "encounters.write",
      "investigations.order",
      "investigations.verify",
      "patients.create",
      "patients.export",
      "patients.read",
      "patients.update",
      "prescriptions.create",
      "reports.view",
      "staff.manage",
    ],
  },
  {
    key: "nurse",
    name: "Nurse",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "encounters.read",
      "investigations.order",
      "patients.create",
      "patients.read",
      "patients.update",
      "reports.view",
    ],
  },
  {
    key: "organization_admin",
    name: "Organization Administrator",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "audit.read",
      "billing.manage",
      "encounters.read",
      "encounters.write",
      "inventory.manage",
      "investigations.order",
      "investigations.verify",
      "patients.create",
      "patients.export",
      "patients.read",
      "patients.update",
      "prescriptions.create",
      "reports.view",
      "settings.manage",
      "staff.manage",
      "subscription.manage",
    ],
  },
  {
    key: "organization_owner",
    name: "Organization Owner",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "audit.read",
      "billing.manage",
      "encounters.read",
      "encounters.write",
      "inventory.manage",
      "investigations.order",
      "investigations.verify",
      "patients.create",
      "patients.export",
      "patients.read",
      "patients.update",
      "prescriptions.create",
      "reports.view",
      "settings.manage",
      "staff.manage",
      "subscription.manage",
    ],
  },
  {
    key: "pharmacist",
    name: "Pharmacist",
    isPlatform: false,
    permissions: ["inventory.manage", "patients.read", "reports.view"],
  },
  {
    key: "platform_super_admin",
    name: "Platform Super Admin",
    isPlatform: true,
    permissions: [
      "platform.audit.read",
      "platform.subscriptions.manage",
      "platform.tenants.manage",
      "platform.tenants.read",
    ],
  },
  {
    key: "receptionist",
    name: "Receptionist",
    isPlatform: false,
    permissions: [
      "appointments.manage",
      "billing.manage",
      "patients.create",
      "patients.read",
      "reports.view",
    ],
  },
];

export function defaultPermissionsFor(roleKey: RoleKey): readonly PermissionKey[] {
  const role = ROLES.find((candidate) => candidate.key === roleKey);
  if (role === undefined) {
    throw new RangeError(`unknown role key: ${String(roleKey)}`);
  }
  return role.permissions;
}

export function hasPermission(roles: readonly RoleKey[], permission: PermissionKey): boolean {
  return roles.some((role) =>
    ROLES.some((candidate) => candidate.key === role && candidate.permissions.includes(permission)),
  );
}
