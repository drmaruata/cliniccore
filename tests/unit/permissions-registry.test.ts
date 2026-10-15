import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  ROLES,
  defaultPermissionsFor,
  hasPermission,
  type PermissionKey,
  type RegistryInput,
  type RoleKey,
} from "@/lib/permissions/registry";
import {
  ORGANIZATION_ID_PLACEHOLDER,
  generateOrganizationScopedRoleSeedTemplate,
  generatePlatformScopeSql,
} from "@/scripts/gen-permissions-sql";

/*
 * Task 3 — permission registry integrity + deterministic SQL generation.
 *
 * The registry in lib/permissions/registry.ts is the single source of truth
 * for the role × permission matrix. These tests pin three things:
 *
 *   1. registry integrity — shape, uniqueness, referential completeness;
 *   2. the security-critical matrix rulings — who can never see what;
 *   3. the SQL contract Task 7 (platform scope) and Task 8 (per-organization
 *      scope) inline into migrations: idempotent upserts, byte-stable output.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The fifteen role keys the foundation brief mandates, in sorted order. */
const EXPECTED_ROLE_KEYS = [
  "accountant",
  "auditor",
  "billing_officer",
  "clinic_admin",
  "clinical_assistant",
  "doctor",
  "inventory_manager",
  "lab_technician",
  "medical_director",
  "nurse",
  "organization_admin",
  "organization_owner",
  "pharmacist",
  "platform_super_admin",
  "receptionist",
] as const satisfies readonly RoleKey[];

/** Platform-console permissions. Platform operators see nothing clinical. */
const PLATFORM_PERMISSION_KEYS = [
  "platform.audit.read",
  "platform.subscriptions.manage",
  "platform.tenants.manage",
  "platform.tenants.read",
] as const satisfies readonly PermissionKey[];

/** Every permission that is not platform-console, in sorted order. */
const NON_PLATFORM_PERMISSION_KEYS = [
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
] as const satisfies readonly PermissionKey[];

/** The roles seeded per organization — every role except the platform one. */
const EXPECTED_ORGANIZATION_ROLE_KEYS = EXPECTED_ROLE_KEYS.filter(
  (key) => key !== "platform_super_admin",
);

const sortedKeys = (keys: readonly string[]): string[] => [...keys].sort();

const pairSortKey = (pair: { role: string; permission: string }): string =>
  `${pair.role}\u0000${pair.permission}`;

const byPairKey = (
  list: Array<{ role: string; permission: string }>,
): Array<{ role: string; permission: string }> =>
  [...list].sort((left, right) => {
    const leftKey = pairSortKey(left);
    const rightKey = pairSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

/**
 * The real registry with every array reversed — same data, opposite
 * insertion order. Byte-identical output from this input is what proves
 * the generator sorts by key instead of relying on declaration order.
 */
function reversedRegistry(): RegistryInput {
  return {
    permissions: [...PERMISSIONS].reverse(),
    roles: [...ROLES]
      .reverse()
      .map((role) => ({ ...role, permissions: [...role.permissions].reverse() })),
  };
}

/** Registry-shaped data that exists nowhere in the real registry. */
const SYNTHETIC_REGISTRY: RegistryInput = {
  permissions: [{ key: "patients.read", description: "View a patient's record" }],
  roles: [
    {
      key: "organization_owner",
      name: "Owner's delegate",
      isPlatform: false,
      permissions: ["patients.read"],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* SQL text extractors                                                 */
/* ------------------------------------------------------------------ */

/** The VALUES rows of one `insert ... values` section, as raw lines. */
function valuesRows(sql: string, sectionMarker: string): string[] {
  const start = sql.indexOf(sectionMarker);
  if (start === -1) return [];
  const body = sql.slice(start + sectionMarker.length).split("\non conflict")[0] ?? "";
  return body.split("\n");
}

/** Permission keys in the order the permissions VALUES block lists them. */
function permissionKeysInValues(sql: string): string[] {
  const keys: string[] = [];
  for (const row of valuesRows(sql, "insert into public.permissions (key, description) values")) {
    const match = row.match(/^  \('([a-z_]+(?:\.[a-z_]+)+)'/);
    if (match) keys.push(match[1] ?? "");
  }
  return keys;
}

/** Role keys in the order a roles VALUES block lists them. */
function roleKeysInValues(sql: string): string[] {
  const keys: string[] = [];
  for (const row of valuesRows(
    sql,
    "insert into public.roles (organization_id, key, name, is_platform) values",
  )) {
    const match = row.match(/^  \((?:null|\{\{ORGANIZATION_ID\}\}), '([a-z_]+)'/);
    if (match) keys.push(match[1] ?? "");
  }
  return keys;
}

/** (role key, permission key) pairs in the order the grants VALUES block lists them. */
function grantPairsInValues(sql: string): Array<{ role: string; permission: string }> {
  const marker = "insert into public.role_permissions (role_id, permission_id)";
  const start = sql.indexOf(marker);
  if (start === -1) return [];
  const pairs: Array<{ role: string; permission: string }> = [];
  for (const row of sql.slice(start).split("\n")) {
    const match = row.match(/^  \('([a-z_]+)', '([a-z_]+(?:\.[a-z_]+)+)'\)$/);
    if (match) pairs.push({ role: match[1] ?? "", permission: match[2] ?? "" });
  }
  return pairs;
}

/* ------------------------------------------------------------------ */
/* Registry integrity                                                  */
/* ------------------------------------------------------------------ */

describe("PERMISSIONS", () => {
  it("formats every permission key as lowercase snake segments joined by dots", () => {
    // The brief specified /^[a-z_]+\.[a-z_]+$/, which admits exactly two
    // segments. The task ruling that added the platform-console set also
    // added three-segment keys (platform.tenants.read), so the pattern
    // admits one-or-more dot-separated segments while keeping the brief's
    // intent: lowercase snake_case segments, no digits, nothing else.
    const pattern = /^[a-z_]+(?:\.[a-z_]+)+$/;
    for (const permission of PERMISSIONS) {
      expect(pattern.test(permission.key), `bad key: ${permission.key}`).toBe(true);
    }
  });

  it("has no duplicate keys", () => {
    expect(new Set(PERMISSIONS.map((permission) => permission.key)).size).toBe(PERMISSIONS.length);
  });

  it("describes every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.description.length > 0, permission.key).toBe(true);
    }
  });

  it("grants every permission to at least one role", () => {
    const granted = new Set(ROLES.flatMap((role) => [...role.permissions]));
    const orphans = PERMISSIONS.filter((permission) => !granted.has(permission.key)).map(
      (permission) => permission.key,
    );
    expect(orphans).toEqual([]);
  });
});

describe("ROLES", () => {
  it("defines exactly the fifteen brief-mandated roles", () => {
    expect([...ROLES].map((role) => role.key).sort()).toEqual([...EXPECTED_ROLE_KEYS]);
  });

  it("references only permissions the registry defines", () => {
    const defined = new Set(PERMISSIONS.map((permission) => permission.key));
    for (const role of ROLES) {
      for (const permission of role.permissions) {
        expect(defined.has(permission), `${role.key} references ${permission}`).toBe(true);
      }
    }
  });

  it("lists no permission twice within a role", () => {
    for (const role of ROLES) {
      expect(new Set(role.permissions).size, role.key).toBe(role.permissions.length);
    }
  });

  it("gives every role at least one permission", () => {
    for (const role of ROLES) {
      expect(role.permissions.length > 0, role.key).toBe(true);
    }
  });

  it("marks only platform_super_admin as a platform role", () => {
    expect(ROLES.filter((role) => role.isPlatform).map((role) => role.key)).toEqual([
      "platform_super_admin",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Matrix rulings                                                      */
/* ------------------------------------------------------------------ */

describe("the role x permission matrix", () => {
  it("gives organization_owner the brief's named permissions", () => {
    const owner = defaultPermissionsFor("organization_owner");
    expect(owner).toContain("staff.manage");
    expect(owner).toContain("settings.manage");
    expect(owner).toContain("billing.manage");
  });

  it("gives organization_owner every non-platform permission and no platform permission", () => {
    expect(sortedKeys(defaultPermissionsFor("organization_owner"))).toEqual(
      sortedKeys(NON_PLATFORM_PERMISSION_KEYS),
    );
    expect(defaultPermissionsFor("organization_owner")).not.toContain("platform.tenants.read");
  });

  it("gives organization_admin the same grant set as organization_owner", () => {
    expect(sortedKeys(defaultPermissionsFor("organization_admin"))).toEqual(
      sortedKeys(defaultPermissionsFor("organization_owner")),
    );
  });

  it("restricts auditor to read-only viewing plus audit.read", () => {
    expect(sortedKeys(defaultPermissionsFor("auditor"))).toEqual([
      "audit.read",
      "encounters.read",
      "patients.read",
      "reports.view",
    ]);
    expect(defaultPermissionsFor("auditor")).not.toContain("patients.update");
    expect(defaultPermissionsFor("auditor")).not.toContain("patients.export");
  });

  it("lets lab_technician verify investigations but never prescribe", () => {
    const lab = defaultPermissionsFor("lab_technician");
    expect(lab).toContain("investigations.verify");
    expect(lab).not.toContain("prescriptions.create");
  });

  it("lets pharmacist manage inventory but never prescribe", () => {
    const pharmacist = defaultPermissionsFor("pharmacist");
    expect(pharmacist).toContain("inventory.manage");
    expect(pharmacist).not.toContain("prescriptions.create");
  });

  it("confines platform_super_admin to the four platform-console permissions", () => {
    expect(sortedKeys(defaultPermissionsFor("platform_super_admin"))).toEqual(
      sortedKeys(PLATFORM_PERMISSION_KEYS),
    );
    expect(defaultPermissionsFor("platform_super_admin")).not.toContain("patients.read");
  });
});

/* ------------------------------------------------------------------ */
/* Lookup helpers                                                      */
/* ------------------------------------------------------------------ */

describe("defaultPermissionsFor", () => {
  it("returns the permissions declared for the role", () => {
    const doctor = defaultPermissionsFor("doctor");
    const declared = ROLES.find((role) => role.key === "doctor")?.permissions ?? [];
    expect(doctor).toEqual(declared);
  });

  it("throws on a role key the registry does not define", () => {
    expect(() => defaultPermissionsFor("ghost_role" as unknown as RoleKey)).toThrow(RangeError);
  });
});

describe("hasPermission", () => {
  it("grants a permission one of the roles holds", () => {
    expect(hasPermission(["auditor"], "audit.read")).toBe(true);
    expect(hasPermission(["nurse", "doctor"], "prescriptions.create")).toBe(true);
  });

  it("denies a permission none of the roles holds", () => {
    expect(hasPermission(["auditor"], "patients.update")).toBe(false);
    expect(hasPermission(["nurse", "receptionist"], "prescriptions.create")).toBe(false);
    expect(hasPermission(["nurse"], "billing.manage")).toBe(false);
  });

  it("denies when the caller holds no roles", () => {
    expect(hasPermission([], "patients.read")).toBe(false);
  });

  it("denies a permission the registry does not define", () => {
    expect(hasPermission(["doctor"], "nothing.read")).toBe(false);
  });

  it("denies a role key the registry does not define — fail-closed, no throw", () => {
    expect(hasPermission(["ghost_role"] as unknown as readonly RoleKey[], "patients.read")).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Platform-scope SQL                                                  */
/* ------------------------------------------------------------------ */

describe("generatePlatformScopeSql", () => {
  it("upserts permissions with the brief's exact on-conflict clause", () => {
    expect(generatePlatformScopeSql()).toContain(
      "on conflict (key) do update set description = excluded.description;",
    );
  });

  it("seeds all registry permissions in sorted key order", () => {
    expect(permissionKeysInValues(generatePlatformScopeSql())).toEqual(
      sortedKeys([...NON_PLATFORM_PERMISSION_KEYS, ...PLATFORM_PERMISSION_KEYS]),
    );
  });

  it("seeds only the platform role at organization_id null", () => {
    const sql = generatePlatformScopeSql();
    expect(roleKeysInValues(sql)).toEqual(["platform_super_admin"]);
    expect(sql).toContain("(null, 'platform_super_admin', 'Platform Super Admin', true)");
  });

  it("upserts roles against (organization_id, key)", () => {
    const sql = generatePlatformScopeSql();
    expect(sql).toContain("on conflict (organization_id, key) do update");
    expect(sql).toContain("  set name = excluded.name, is_platform = excluded.is_platform;");
  });

  it("grants the platform role only platform-console permissions", () => {
    const sql = generatePlatformScopeSql();
    const pairs = grantPairsInValues(sql);
    expect(pairs).toEqual(
      byPairKey(
        PLATFORM_PERMISSION_KEYS.map((permission) => ({
          role: "platform_super_admin",
          permission,
        })),
      ),
    );
    expect(pairs.every((pair) => pair.permission.startsWith("platform."))).toBe(true);
    expect(sql).toContain("r.organization_id is null and r.key = seed.role_key");
  });
});

/* ------------------------------------------------------------------ */
/* Organization-scope SQL (Task 8 consumes this)                       */
/* ------------------------------------------------------------------ */

describe("generateOrganizationScopedRoleSeedTemplate", () => {
  it("parameterises the organization id with the documented placeholder", () => {
    const template = generateOrganizationScopedRoleSeedTemplate();
    expect(template).toContain(`(${ORGANIZATION_ID_PLACEHOLDER}, 'accountant'`);
    expect(template).toContain(
      `r.organization_id = ${ORGANIZATION_ID_PLACEHOLDER} and r.key = seed.role_key`,
    );
    expect(template).not.toContain("(null,");
  });

  it("seeds exactly the fourteen organization-scoped roles in sorted key order", () => {
    expect(roleKeysInValues(generateOrganizationScopedRoleSeedTemplate())).toEqual(
      EXPECTED_ORGANIZATION_ROLE_KEYS,
    );
  });

  it("never seeds the platform role or platform permissions into an organization", () => {
    const template = generateOrganizationScopedRoleSeedTemplate();
    expect(roleKeysInValues(template)).not.toContain("platform_super_admin");
    const granted = grantPairsInValues(template).map((pair) => pair.permission);
    expect(granted.every((permission) => !permission.startsWith("platform."))).toBe(true);
  });

  it("grants every organization-scoped role exactly its declared permissions", () => {
    const pairs = grantPairsInValues(generateOrganizationScopedRoleSeedTemplate());
    const expected = ROLES.filter((role) => !role.isPlatform).flatMap((role) =>
      role.permissions.map((permission) => ({ role: role.key, permission })),
    );
    expect(pairs).toEqual(byPairKey(expected));
  });
});

/* ------------------------------------------------------------------ */
/* Determinism — the contract that makes inlining safe                */
/* ------------------------------------------------------------------ */

describe("determinism of the generated SQL", () => {
  it("emits byte-identical platform SQL on repeated calls", () => {
    expect(generatePlatformScopeSql()).toBe(generatePlatformScopeSql());
  });

  it("emits byte-identical organization templates on repeated calls", () => {
    expect(generateOrganizationScopedRoleSeedTemplate()).toBe(
      generateOrganizationScopedRoleSeedTemplate(),
    );
  });

  it("ignores registry insertion order (platform scope)", () => {
    expect(generatePlatformScopeSql(reversedRegistry())).toBe(generatePlatformScopeSql());
  });

  it("ignores registry insertion order (organization scope)", () => {
    expect(generateOrganizationScopedRoleSeedTemplate(reversedRegistry())).toBe(
      generateOrganizationScopedRoleSeedTemplate(),
    );
  });

  it("contains no timestamps or other volatile tokens", () => {
    for (const sql of [generatePlatformScopeSql(), generateOrganizationScopedRoleSeedTemplate()]) {
      expect(sql).not.toMatch(/now\(\)|CURRENT_TIMESTAMP|CURRENT_DATE|clock_timestamp|random\(\)/i);
      expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Quoting and input validation                                         */
/* ------------------------------------------------------------------ */

describe("quoting and validation of generator input", () => {
  it("escapes single quotes in emitted literals", () => {
    const template = generateOrganizationScopedRoleSeedTemplate(SYNTHETIC_REGISTRY);
    expect(template).toContain("'View a patient''s record'");
    expect(template).toContain("'Owner''s delegate'");
  });

  it("emits a comment instead of an empty roles insert when the scope has no roles", () => {
    const sql = generatePlatformScopeSql(SYNTHETIC_REGISTRY);
    expect(sql).toContain("insert into public.permissions");
    expect(sql).not.toContain("insert into public.roles");
    expect(sql).toContain("-- (no roles in this scope; nothing to seed)");
    expect(sql).toContain("-- (no role-permission grants in this scope; nothing to seed)");
  });

  it("refuses input where a role references an unknown permission", () => {
    const invalid: RegistryInput = {
      permissions: [{ key: "patients.read", description: "View patient records" }],
      roles: [
        {
          key: "doctor",
          name: "Doctor",
          isPlatform: false,
          permissions: ["patients.read", "encounters.read"],
        },
      ],
    };
    expect(() => generatePlatformScopeSql(invalid)).toThrow(/unknown permission: encounters\.read/);
  });

  it("refuses input with a duplicate permission key", () => {
    const invalid: RegistryInput = {
      permissions: [
        { key: "patients.read", description: "View patient records" },
        { key: "patients.read", description: "View patient records, again" },
      ],
      roles: [],
    };
    expect(() => generatePlatformScopeSql(invalid)).toThrow(/duplicate permission key/);
  });

  it("refuses input with a duplicate role key", () => {
    const invalid: RegistryInput = {
      permissions: [{ key: "patients.read", description: "View patient records" }],
      roles: [
        {
          key: "doctor",
          name: "Doctor",
          isPlatform: false,
          permissions: ["patients.read"],
        },
        {
          key: "doctor",
          name: "Doctor",
          isPlatform: false,
          permissions: ["patients.read"],
        },
      ],
    };
    expect(() => generatePlatformScopeSql(invalid)).toThrow(/duplicate role key/);
  });

  it("refuses input where a role lists the same permission twice", () => {
    const invalid: RegistryInput = {
      permissions: [{ key: "patients.read", description: "View patient records" }],
      roles: [
        {
          key: "doctor",
          name: "Doctor",
          isPlatform: false,
          permissions: ["patients.read", "patients.read"],
        },
      ],
    };
    expect(() => generateOrganizationScopedRoleSeedTemplate(invalid)).toThrow(
      /lists the permission patients\.read more than once/,
    );
  });
});
