import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { generatePlatformScopeSql } from "@/scripts/gen-permissions-sql";

/*
 * Task 7 - the platform seed inlined in 00400 must match the registry.
 *
 * This is the guard that replaces the plan's scripts/apply-permissions-seed.ts.
 * A Node script cannot reach the MCP applier, so it could never "apply" anything,
 * and under ESM without allowImportingTsExtensions it cannot even import the
 * generator to emit it. The seed is therefore generated into the migration itself
 * (the emitted statements carry on-conflict clauses, so re-running 00400 refreshes
 * it), and THIS test is what stops the two copies from forking: change
 * lib/permissions/registry.ts without re-inlining and CI fails here.
 *
 * To re-inline: run the generator, paste its output between the sentinels in
 * supabase/migrations/20261014000400_authorization.sql.
 */

const MIGRATION = join(process.cwd(), "supabase", "migrations", "20261014000400_authorization.sql");
const BEGIN = "-- BEGIN GENERATED PLATFORM SEED";
const END = "-- END GENERATED PLATFORM SEED";

function readInlinedSeed(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const begin = sql.indexOf(BEGIN);
  const end = sql.indexOf(END);
  expect(begin, `${BEGIN} is missing from the authorization migration`).toBeGreaterThanOrEqual(0);
  expect(end, `${END} is missing from the authorization migration`).toBeGreaterThan(begin);
  return sql.slice(begin + BEGIN.length, end).trim();
}

describe("platform permission seed", () => {
  it("is inlined byte-for-byte as the registry generates it", () => {
    expect(readInlinedSeed()).toBe(generatePlatformScopeSql().trim());
  });

  it("seeds permissions, the platform role and its grants, all re-appliable", () => {
    const seed = readInlinedSeed();
    expect(seed).toContain("insert into public.permissions (key, description) values");
    expect(seed).toContain("on conflict (key) do update set description = excluded.description;");
    // The platform role is written at organization_id NULL, which only dedupes
    // because roles is unique nulls not distinct (organization_id, key).
    expect(seed).toContain("(null, 'platform_super_admin', 'Platform Super Admin', true)");
    expect(seed).toContain("on conflict (organization_id, key) do update");
    expect(seed).toContain("insert into public.role_permissions (role_id, permission_key)");
    expect(seed).toContain("on conflict (role_id, permission_key) do nothing;");
  });
});
