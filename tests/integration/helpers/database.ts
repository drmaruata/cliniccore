import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
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

/**
 * `describe` for a database-backed suite, with the skip policy in one place.
 *
 * SKIPPING IS FAILURE-SHAPED ON PURPOSE. With no TEST_DATABASE_URL the suite
 * skips, so a fork or a contributor without the database password still gets a
 * green `npm run test`. But when CI=true - or REQUIRE_TEST_DATABASE_URL=true, so
 * it can be demanded locally - a missing URL FAILS instead, because a suite that
 * skips silently in CI is how test coverage rots unnoticed.
 *
 * Only ABSENCE skips. A URL that is present but wrong - the common one being
 * Supabase's direct host, which is IPv6-only and does not resolve from an IPv4
 * machine - fails loudly with ENOTFOUND. A silently skipping suite pointed at
 * the wrong database would report coverage it does not have.
 *
 * This lived inline in tenancy-schema.test.ts and four later files forgot it,
 * which is how 34 tests came to fail on a bare `npm run test`. It is a helper
 * now so that cannot recur.
 */
const url = envValue("TEST_DATABASE_URL");
const missing = url === undefined || url === "";
const mustRun = envValue("CI") === "true" || envValue("REQUIRE_TEST_DATABASE_URL") === "true";
let warned = false;

export function dbDescribe(name: string, suite: () => void): void {
  if (missing && !warned) {
    warned = true;
    console.warn(
      mustRun
        ? "[integration] TEST_DATABASE_URL is required here but absent - failing."
        : "[integration] TEST_DATABASE_URL is not set - skipping the catalogue suite. " +
            "Set it in .env.local to run these against the database.",
    );
  }
  (missing ? (mustRun ? describe : describe.skip) : describe)(name, suite);
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

/**
 * A transaction the caller rolls back.
 *
 * THIS IS HOW BEHAVIOURAL ASSERTIONS WORK WITHOUT POSTGREST. Two statements are
 * enough to be any principal: `set local role authenticated` changes the role the
 * rest of the transaction runs as, and
 * `select set_config('request.jwt.claim.sub', …, true)` is exactly what PostgREST
 * does with a JWT. Both are transaction-local, so a rollback restores both.
 *
 * That means a test can assert what a tenant's session sees - a refused audit
 * write, a scoped MRN counter - without any HTTP layer, and can create its
 * fixtures as the owner first, then act as the tenant. Rolling back also means
 * the suite leaves no rows behind, which matters more than usual here: the
 * project's rehearsal rows are PHI-shaped.
 *
 * It does NOT test PostgREST itself - schema exposure, JWT verification, HTTP
 * behaviour - which stays a separate concern.
 */
export interface DbSession {
  query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run as the owner again (undo `set local role`) inside the same transaction. */
  resetRole(): Promise<void>;
  rollback(): Promise<void>;
}

export async function beginSession(): Promise<DbSession> {
  const client = await getPool().connect();
  await client.query("begin");
  let finished = false;

  const run = async <T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    const result = await client.query(text, params as unknown[]);
    return result.rows as T[];
  };

  const rollback = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await client.query("rollback");
    client.release();
  };

  return {
    query: run,
    resetRole: async () => {
      await client.query("reset role");
    },
    rollback,
  };
}

/**
 * Assert a statement fails, then leave the transaction usable.
 *
 * WITHOUT THIS A TEST CANNOT ASSERT TWO FAILURES IN A ROW. Postgres aborts the
 * transaction on the first error, so every statement after it fails with "current
 * transaction is aborted" instead of the error under test - which reads as a
 * broken guard when the guard is fine. Each expected failure therefore gets its
 * own savepoint, rolled back before the next assertion.
 */
export async function expectRejection(
  session: DbSession,
  text: string,
  params: readonly unknown[],
  matcher: RegExp,
): Promise<void> {
  await session.query("savepoint expected_rejection");
  let message = "";
  try {
    await session.query(text, params);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await session.query("rollback to savepoint expected_rejection");

  if (message === "") {
    throw new Error(`expected a failure matching ${matcher} but the statement succeeded`);
  }
  if (!matcher.test(message)) {
    throw new Error(`expected a failure matching ${matcher}, got: ${message}`);
  }
}
