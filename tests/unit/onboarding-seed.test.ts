import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ORGANIZATION_ID_PLACEHOLDER,
  generateOrganizationScopedRoleSeedTemplate,
} from "@/scripts/gen-permissions-sql";

/*
 * Task 8 - the org-scoped role seed inlined in the onboarding RPC must match the
 * registry.
 *
 * This is the drift guard for the second generated block. Organization roles are
 * seeded per organization inside private.create_organization_with_owner and
 * nowhere else, so a registry change that is not re-inlined produces tenants whose
 * roles do not match the matrix - silently, because the function still works.
 *
 * The block is generated with ORGANIZATION_ID_PLACEHOLDER replaced by the plpgsql
 * variable v_org_id, so the expected text is derived the same way the migration
 * was, rather than being compared against a hand-written copy.
 *
 * To re-inline: run the generator, substitute the placeholder for v_org_id, and
 * paste between the sentinels in supabase/migrations/20261014000600_onboarding_rpc.sql.
 */

const MIGRATION = "20261014000600_onboarding_rpc.sql";
const BEGIN = "-- BEGIN GENERATED ORG SEED";
const END = "-- END GENERATED ORG SEED";

function readInlinedSeed(): string {
  // The raw file, not the normalised one: readMigration strips comment lines,
  // which is exactly what these sentinels are.
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");
  const begin = sql.indexOf(BEGIN);
  const end = sql.indexOf(END);
  expect(begin, `${BEGIN} is missing from ${MIGRATION}`).toBeGreaterThanOrEqual(0);
  expect(end, `${END} is missing from ${MIGRATION}`).toBeGreaterThan(begin);
  // The block is indented to sit inside the function body; the generator emits it
  // flush-left, so compare against the same shape the migration should contain.
  return sql
    .slice(begin + BEGIN.length, end)
    .split("\n")
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n")
    .trim();
}

describe("organization-scoped permission seed", () => {
  it("is inlined as the registry generates it, with the org id left as a variable", () => {
    const expected = generateOrganizationScopedRoleSeedTemplate()
      .replaceAll(ORGANIZATION_ID_PLACEHOLDER, "v_org_id")
      .trim();
    expect(readInlinedSeed()).toBe(expected);
  });

  it("seeds all fourteen organization roles and none of the platform one", () => {
    const seed = readInlinedSeed();
    for (const key of [
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
      "receptionist",
    ]) {
      expect(seed).toContain(`(v_org_id, '${key}'`);
    }
    // Organization roles are seeded per tenant; the platform role belongs to
    // 00400's global seed and must never appear here.
    expect(seed).not.toContain("platform_super_admin");
  });

  it("re-seeds idempotently, so a second organization does not collide", () => {
    const seed = readInlinedSeed();
    expect(seed).toContain("on conflict (organization_id, key) do update");
    expect(seed).toContain("on conflict (role_id, permission_key) do nothing;");
    expect(seed).toContain("on conflict (key) do update set description = excluded.description;");
  });
});
