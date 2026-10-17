import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

/**
 * Direct Postgres connection for the integration suite.
 *
 * WHY THIS EXISTS. The plan's integration tests assert catalogue state -
 * pg_proc.prosecdef, pg_policies contents, constraint arity - and PostgREST
 * cannot return any of it, so those assertions need a direct connection. Until
 * this file existed they were discharged as controller-run rehearsals, which ran
 * but were not reproducible and could not fail a build.
 *
 * WHY IT PARSES .env.local ITSELF rather than relying on Vite's envPrefix.
 * `vitest.config.ts` sets no envPrefix, and whether a prefixed var reaches a test
 * through `process.env` or only through `import.meta.env` is a Vite-version
 * detail this project should not depend on. Reading the file explicitly is one
 * function and cannot drift. It also means a missing variable produces a named
 * error instead of a connection error.
 *
 * THE SECRET NEVER APPEARS IN CODE. TEST_DATABASE_URL is read from the
 * environment or `.env.local`, both of which are gitignored. Nothing here builds
 * a connection string by concatenation, so `check-no-secrets` has nothing to
 * flag and no credential can reach a commit by accident.
 *
 * These tests connect as the database owner, which BYPASSES RLS. That is
 * correct for inspecting the catalogue, and it makes them incapable of proving
 * anything about tenant isolation - behaviour tests must go through PostgREST
 * with a real user JWT for that.
 */

const ENV_FILES = [".env.local", ".env"];

/** Parse a dotenv file. Deliberately minimal: KEY=VALUE, `#` comments, optional quotes. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let fileEnv: Record<string, string> | null = null;

/** A variable from the real environment first, then the first dotenv file present. */
export function envValue(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;

  const loaded = (fileEnv ??= Object.assign(
    {},
    ...ENV_FILES.map((file) => {
      const path = join(process.cwd(), file);
      return existsSync(path) ? parseEnvFile(path) : {};
    }),
  ));
  return loaded[name];
}

/** Throws naming the variable, rather than letting `pg` fail with a socket error. */
export function databaseUrl(): string {
  const url = envValue("TEST_DATABASE_URL");
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_URL is not set. Add it to .env.local (gitignored) as a Supabase " +
        "connection string, for example postgresql://postgres.<project-ref>:<password>@" +
        "aws-0-<region>.pooler.supabase.com:6543/postgres . The integration suite needs a " +
        "direct connection because PostgREST cannot read the catalogue these tests assert.",
    );
  }
  return url;
}

let pool: Pool | null = null;

export function getPool(): Pool {
  pool ??= new Pool({
    connectionString: databaseUrl(),
    // Fail fast rather than hanging for the OS connect timeout on a bad host or
    // an unreachable port, which is the usual first-run experience.
    connectionTimeoutMillis: 10_000,
    max: 4,
  });
  return pool;
}

/** Run one parameterised query and return its rows. */
export async function query<T extends Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params as unknown[]);
  return result.rows as T[];
}

/** Close the pool. Call from `afterAll` so a run does not hold the process open. */
export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}
