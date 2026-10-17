/**
 * Migration manifest harness for ClinicCore.
 *
 * WHAT IT DOES. Reads supabase/migrations/*.sql in filename order, validates
 * each file against the naming convention, and emits a manifest of pending
 * migrations: [{ name, idempotencyKey, sql }].
 *
 * WHAT IT IS USED FOR. The SQL files in supabase/migrations/ are the source of
 * truth for the database schema. This script does NOT apply them - scripts
 * cannot call the Composio MCP, and there is no Supabase PAT for the Management
 * API. The controller reads the manifest and applies each entry through the
 * Composio `SUPABASE_APPLY_A_MIGRATION` tool with `idempotencyKey`, then
 * verifies by querying information_schema / pg_catalog (never the apply
 * response body).
 *
 * USAGE. `npx tsx scripts/apply-migration.ts` prints the JSON manifest;
 * `--check` prints a human-readable summary and exits 1 if any file is
 * malformed, misnamed, or empty.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MIGRATION_FILENAME_PATTERN = /^\d{14}_[a-z][a-z0-9_]*\.sql$/;
const TIMESTAMP_PREFIX_PATTERN = /^\d{14}_/;
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

export interface MigrationManifestEntry {
  readonly name: string;
  readonly idempotencyKey: string;
  readonly sql: string;
}

function problem(fileName: string, reason: string): string {
  return `${fileName}: ${reason}`;
}

/**
 * Validate every file in the migrations directory and return one message per
 * problem. Never throws; an empty result means the directory is sound.
 */
export function validateMigrations(dir: string = MIGRATIONS_DIR): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [problem(dir, "no such directory")];
  }

  const problems: string[] = [];
  const fileNames = readdirSync(dir).sort();

  for (const fileName of fileNames) {
    const fullPath = join(dir, fileName);
    const isFile = statSync(fullPath).isFile();

    if (!fileName.endsWith(".sql")) {
      if (TIMESTAMP_PREFIX_PATTERN.test(fileName)) {
        problems.push(problem(fileName, "looks like a migration but does not end in .sql"));
      }
      continue;
    }

    if (!MIGRATION_FILENAME_PATTERN.test(fileName)) {
      problems.push(problem(fileName, `migration filenames must match \\d{14}_name.sql`));
      continue;
    }

    if (!isFile) {
      problems.push(problem(fileName, "is a directory, not a migration file"));
      continue;
    }

    const sql = readFileSync(fullPath, "utf8");
    if (sql.trim().length === 0) {
      problems.push(problem(fileName, "empty migration file"));
    }
  }

  return problems;
}

/**
 * Build the ordered manifest of pending migrations. Throws with the first
 * problem message if the directory is invalid; callers that want every
 * problem use validateMigrations instead.
 */
export function buildMigrationManifest(dir: string = MIGRATIONS_DIR): MigrationManifestEntry[] {
  const problems = validateMigrations(dir);
  if (problems.length > 0) {
    throw new Error(problems[0] ?? "unknown migration problem");
  }

  return readdirSync(dir)
    .filter((fileName) => MIGRATION_FILENAME_PATTERN.test(fileName))
    .sort()
    .map((fileName) => {
      const fullPath = join(dir, fileName);
      if (!statSync(fullPath).isFile()) {
        throw new Error(problem(fileName, "is a directory, not a migration file"));
      }
      return {
        name: fileName,
        idempotencyKey: fileName.replace(/\.sql$/, ""),
        sql: readFileSync(fullPath, "utf8"),
      };
    });
}

function isDirectRun(): boolean {
  const argv1 = process.argv[1] ?? "";
  return argv1.replace(/\\/g, "/").endsWith("apply-migration.ts");
}

if (isDirectRun()) {
  const problems = validateMigrations();
  if (problems.length > 0) {
    for (const line of problems) console.error(`migrations check FAILED: ${line}`);
    process.exit(1);
  }

  if (process.argv.includes("--check")) {
    const manifest = buildMigrationManifest();
    console.log(`migrations check OK: ${manifest.length} file(s), all valid`);
    for (const entry of manifest) console.log(`  ${entry.name}  [key: ${entry.idempotencyKey}]`);
  } else {
    console.log(JSON.stringify(buildMigrationManifest(), null, 2));
  }
}
