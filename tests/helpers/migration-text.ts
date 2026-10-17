import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/**
 * Reading the migration SQL from tests.
 *
 * supabase/migrations/ is the source of truth and no vitest process can reach the
 * database (migrations are applied agent-side through the Composio MCP), so the
 * database-state assertions in these suites are made against the migration text
 * instead, with the live catalogue verified as a controller-run rehearsal.
 *
 * Function bodies must be read through `latestDefinition`, never by opening a
 * single file. `create or replace` means the LAST definition in filename order
 * wins, and a correction migration is added rather than editing an applied one -
 * so an assertion bound to one file silently describes superseded SQL.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/**
 * One migration with `--` comment lines removed and whitespace collapsed, so an
 * assertion can match a statement without reproducing the file's formatting.
 */
export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), "utf8")
    .replace(/^\s*--.*$/gm, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Every migration in filename order, concatenated. */
export const ALL_MIGRATION_SQL: string = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map(readMigration)
  .join("\n");

/**
 * The effective definition of `private.<name>` - the last `create or replace`
 * for it across all migrations, which is what Postgres would be using.
 */
export function latestDefinition(name: string): string {
  const start = ALL_MIGRATION_SQL.lastIndexOf(`create or replace function private.${name}(`);
  expect(start, `no definition of private.${name} in any migration`).toBeGreaterThanOrEqual(0);
  const end = ALL_MIGRATION_SQL.indexOf("$fn$;", start);
  return ALL_MIGRATION_SQL.slice(start, end === -1 ? undefined : end);
}
