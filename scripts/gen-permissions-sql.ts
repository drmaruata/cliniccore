/**
 * Deterministic SQL generator for the permission registry.
 *
 * WHY THIS FILE EXISTS. `lib/permissions/registry.ts` is the single source of
 * truth for the role × permission matrix; this file is the only thing allowed
 * to turn it into SQL. Task 7 inlines `generatePlatformScopeSql()` into the
 * authorization migration; Task 8's onboarding RPC inlines
 * `generateOrganizationScopedRoleSeedTemplate()` with the organization id
 * substituted for `{{ORGANIZATION_ID}}`.
 *
 * DETERMINISM IS THE CONTRACT. The same registry must produce byte-identical
 * SQL on every call, independent of declaration order. Task 7's migration
 * inlines this output, so any drift between calls would silently fork the
 * seeded matrix. Every list is therefore sorted by key before emission, and
 * no timestamps or other volatile tokens may appear in the output.
 *
 * The emitted statements target the plan's tenancy schema exactly:
 * `roles.is_system` marks seeded roles, and grants are
 * `role_permissions(role_id, permission_key)` joining to `permissions(key)`.
 * Every statement carries an on-conflict clause so the seed is re-appliable.
 *
 * DO NOT EDIT THE OUTPUT BY HAND. Change the registry, regenerate.
 */

import {
  PERMISSIONS,
  ROLES,
  type PermissionDefinition,
  type RegistryInput,
  type RoleDefinition,
} from "@/lib/permissions/registry";

/** Replaced with a concrete organization id when Task 8 inlines the template. */
export const ORGANIZATION_ID_PLACEHOLDER = "{{ORGANIZATION_ID}}";

const NO_PERMISSIONS_COMMENT = "-- (no permissions in this scope; nothing to seed)";
const NO_ROLES_COMMENT = "-- (no roles in this scope; nothing to seed)";
const NO_GRANTS_COMMENT = "-- (no role-permission grants in this scope; nothing to seed)";

/**
 * Keys are inlined into the emitted SQL, so their shape is enforced at the
 * input boundary rather than assumed. One or more lowercase snake_case
 * segments joined by dots — `patients.read`, `platform.tenants.manage`.
 */
const PERMISSION_KEY_PATTERN = /^[a-z_]+(?:\.[a-z_]+)+$/;

/** Role keys: a single lowercase snake_case word. */
const ROLE_KEY_PATTERN = /^[a-z_]+$/;

/**
 * A newline is legal inside a SQL literal but breaks the one-row-per-line
 * shape that keeps the emitted SQL greppable, so descriptions and names are
 * rejected if they span lines.
 */
const NEWLINE_PATTERN = /[\r\n]/;

/** Escape a SQL single-quoted literal (SQL-style: double the quote). */
function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Validate the input before emitting anything. Throws on any defect. */
function validateRegistry(input: RegistryInput): void {
  const permissionKeys = new Set<string>();
  for (const permission of input.permissions) {
    if (!PERMISSION_KEY_PATTERN.test(permission.key)) {
      throw new Error(
        `malformed permission key: ${JSON.stringify(permission.key)} — must match ${PERMISSION_KEY_PATTERN.source} (lowercase snake_case segments joined by dots)`,
      );
    }
    if (NEWLINE_PATTERN.test(permission.description)) {
      throw new Error(
        `permission ${permission.key} has a multi-line description — the generator emits one row per line, so a newline would break the emitted SQL`,
      );
    }
    if (permissionKeys.has(permission.key)) {
      throw new Error(`duplicate permission key: ${permission.key}`);
    }
    permissionKeys.add(permission.key);
  }

  const roleKeys = new Set<string>();
  for (const role of input.roles) {
    if (!ROLE_KEY_PATTERN.test(role.key)) {
      throw new Error(
        `malformed role key: ${JSON.stringify(role.key)} — must match ${ROLE_KEY_PATTERN.source} (a single lowercase snake_case word)`,
      );
    }
    if (NEWLINE_PATTERN.test(role.name)) {
      throw new Error(
        `role ${role.key} has a multi-line name — the generator emits one row per line, so a newline would break the emitted SQL`,
      );
    }
    if (roleKeys.has(role.key)) {
      throw new Error(`duplicate role key: ${role.key}`);
    }
    roleKeys.add(role.key);

    const seen = new Set<string>();
    for (const permission of role.permissions) {
      if (seen.has(permission)) {
        throw new Error(`role ${role.key} lists the permission ${permission} more than once`);
      }
      seen.add(permission);

      if (!permissionKeys.has(permission)) {
        throw new Error(`unknown permission: ${permission}`);
      }
    }
  }
}

function sortedPermissions(input: RegistryInput): readonly PermissionDefinition[] {
  return [...input.permissions].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

function sortedRoles(input: RegistryInput): readonly RoleDefinition[] {
  return [...input.roles].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

function sortedGrants(
  roles: readonly RoleDefinition[],
): Array<{ role: string; permission: string }> {
  return roles
    .flatMap((role) => role.permissions.map((permission) => ({ role: role.key, permission })))
    .sort((left, right) => {
      const leftKey = `${left.role}\u0000${left.permission}`;
      const rightKey = `${right.role}\u0000${right.permission}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function permissionsBlock(input: RegistryInput): string {
  const permissions = sortedPermissions(input);
  if (permissions.length === 0) {
    return NO_PERMISSIONS_COMMENT;
  }
  const rows = permissions.map(
    (permission) => `  ('${permission.key}', '${escapeLiteral(permission.description)}')`,
  );
  return [
    "insert into public.permissions (key, description) values",
    `${rows.join(",\n")}`,
    "on conflict (key) do update set description = excluded.description;",
  ].join("\n");
}

function rolesBlock(roles: readonly RoleDefinition[], organizationIdSql: string): string {
  if (roles.length === 0) {
    return NO_ROLES_COMMENT;
  }
  const rows = roles.map(
    (role) =>
      `  (${organizationIdSql}, '${role.key}', '${escapeLiteral(role.name)}', ${role.isPlatform})`,
  );
  return [
    "insert into public.roles (organization_id, key, name, is_system) values",
    `${rows.join(",\n")}`,
    "on conflict (organization_id, key) do update",
    "  set name = excluded.name, is_system = excluded.is_system;",
  ].join("\n");
}

/**
 * Emit the (role, permission) grant pairs.
 *
 * The column list follows the plan's schema — `role_permissions(role_id,
 * permission_key)` with `permission_key` referencing `permissions(key)`;
 * there is no `permissions.id` and no `permission_id` to select (review
 * round 1, C1).
 *
 * `on conflict (role_id, permission_key) do nothing` makes the statement
 * re-appliable: grants are pure join rows with nothing to update, so a
 * re-run must skip pairs that already exist rather than raise
 * `unique_violation` on the primary key (review round 1, I2).
 *
 * The tuple separator is a lone `  ,` line rather than a trailing comma, so
 * that every tuple line is exactly `  ('role', 'permission')`. The registry
 * test's extractor pins that exact row shape, and the shape keeps the emitted
 * SQL greppable one grant per line.
 */
function grantsBlock(
  grants: Array<{ role: string; permission: string }>,
  rolesJoin: string,
): string {
  if (grants.length === 0) {
    return NO_GRANTS_COMMENT;
  }
  const rows = grants.map((grant) => `  ('${grant.role}', '${grant.permission}')`);
  return [
    "insert into public.role_permissions (role_id, permission_key)",
    "select r.id, p.key",
    "from (values",
    rows.join("\n  ,\n"),
    ") as seed(role_key, permission_key)",
    `join public.roles r on ${rolesJoin}`,
    "join public.permissions p on p.key = seed.permission_key",
    "on conflict (role_id, permission_key) do nothing;",
  ].join("\n");
}

function header(scopeDescription: string): string[] {
  return [
    "-- Generated by scripts/gen-permissions-sql.ts. Do not edit by hand.",
    `-- Scope: ${scopeDescription}`,
    "-- Source of truth: lib/permissions/registry.ts. Change the registry, regenerate.",
    "",
  ];
}

/**
 * The platform scope: all permissions, the platform role at
 * `organization_id NULL`, and that role's grants. Applied once by Task 7's
 * authorization migration.
 */
export function generatePlatformScopeSql(
  input: RegistryInput = { permissions: PERMISSIONS, roles: ROLES },
): string {
  validateRegistry(input);
  const platformRoles = sortedRoles(input).filter((role) => role.isPlatform);
  const grants = sortedGrants(platformRoles);

  return [
    ...header("platform (seeded once; organization_id is null)"),
    permissionsBlock(input),
    "",
    rolesBlock(platformRoles, "null"),
    "",
    grantsBlock(grants, "r.organization_id is null and r.key = seed.role_key"),
    "",
  ].join("\n");
}

/**
 * The organization scope: the fourteen organization roles and their grants,
 * parameterised on the organization id. Task 8's onboarding RPC substitutes a
 * concrete id for `{{ORGANIZATION_ID}}`. Organization-scoped roles are seeded
 * per organization at onboarding — never globally — so this template is the
 * only path that creates them.
 */
export function generateOrganizationScopedRoleSeedTemplate(
  input: RegistryInput = { permissions: PERMISSIONS, roles: ROLES },
): string {
  validateRegistry(input);
  const organizationRoles = sortedRoles(input).filter((role) => !role.isPlatform);
  const grants = sortedGrants(organizationRoles);

  return [
    ...header(`organization (id substituted for ${ORGANIZATION_ID_PLACEHOLDER} at apply time)`),
    permissionsBlock(input),
    "",
    rolesBlock(organizationRoles, ORGANIZATION_ID_PLACEHOLDER),
    "",
    grantsBlock(
      grants,
      `r.organization_id = ${ORGANIZATION_ID_PLACEHOLDER} and r.key = seed.role_key`,
    ),
    "",
  ].join("\n");
}
