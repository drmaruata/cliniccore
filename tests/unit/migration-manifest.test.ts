import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMigrationManifest,
  validateMigrations,
  type MigrationManifestEntry,
} from "@/scripts/apply-migration";

/*
 * Task 4 - migration manifest harness.
 *
 * The files in supabase/migrations/ are the source of truth. This harness
 * validates them and emits the manifest the controller applies through the
 * Composio MCP: scripts cannot call the MCP themselves, and there is no
 * Supabase PAT for the Management API. Fixtures live in a temp directory so
 * the real migrations directory is only ever read, never written.
 */

let fixtureDir: string | null = null;

function makeFixtureDir(): string {
  const dir = join(
    tmpdir(),
    `cliniccore-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  fixtureDir = dir;
  return dir;
}

afterEach(() => {
  if (fixtureDir !== null) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = null;
  }
});

function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, "utf8");
}

const VALID_SQL = "create table if not exists probe (id uuid primary key);\n";

describe("buildMigrationManifest", () => {
  it("lists migrations sorted by filename, with idempotency keys derived from the stem", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "20261014000200_second.sql", VALID_SQL);
    writeMigration(dir, "20261014000100_first.sql", VALID_SQL);

    const entries: MigrationManifestEntry[] = buildMigrationManifest(dir);

    expect(entries.map((entry) => entry.name)).toEqual([
      "20261014000100_first.sql",
      "20261014000200_second.sql",
    ]);
    expect(entries[0]?.idempotencyKey).toBe("20261014000100_first");
  });

  it("carries each file's SQL verbatim", () => {
    const dir = makeFixtureDir();
    const sql = "-- a comment\nselect 1;\n";
    writeMigration(dir, "20261014000100_only.sql", sql);

    expect(buildMigrationManifest(dir)[0]?.sql).toBe(sql);
  });

  it("returns an empty manifest for a directory with no migrations", () => {
    const dir = makeFixtureDir();
    expect(buildMigrationManifest(dir)).toEqual([]);
  });

  it("rejects a directory entry named like a migration, naming the entry", () => {
    const dir = makeFixtureDir();
    mkdirSync(join(dir, "20261014000100_directory.sql"), { recursive: true });

    expect(() => buildMigrationManifest(dir)).toThrow(
      /20261014000100_directory\.sql.*is a directory/,
    );
  });

  it("rejects a filename that breaks the timestamp_name convention, naming the file", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "not-a-migration.sql", VALID_SQL);

    expect(() => buildMigrationManifest(dir)).toThrow(
      /not-a-migration\.sql: migration filenames must match/,
    );
  });

  it("rejects a filename whose timestamp prefix is not fourteen digits", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "20261014_short.sql", VALID_SQL);

    expect(() => buildMigrationManifest(dir)).toThrow(/short\.sql/);
  });

  it("rejects a timestamp-prefixed file with the wrong extension, naming the file", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "20261014000100_notes.txt", "ignore me?");

    expect(() => buildMigrationManifest(dir)).toThrow(/20261014000100_notes\.txt/);
  });

  it("rejects an empty migration file, naming the file", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "20261014000100_empty.sql", "");

    expect(() => buildMigrationManifest(dir)).toThrow(/20261014000100_empty\.sql.*empty/);
  });

  it("rejects a directory that does not exist, naming the path", () => {
    expect(() => buildMigrationManifest(join(tmpdir(), "cliniccore-no-such-dir"))).toThrow(
      /no such directory/,
    );
  });

  it("ignores files that are not timestamp-prefixed and not .sql", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "20261014000100_real.sql", VALID_SQL);
    writeFileSync(join(dir, "notes.txt"), "ignore me", "utf8");

    const entries = buildMigrationManifest(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("20261014000100_real.sql");
  });
});

describe("validateMigrations", () => {
  it("returns an empty problems list for a valid directory", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "20261014000100_good.sql", VALID_SQL);

    expect(validateMigrations(dir)).toEqual([]);
  });

  it("collects every problem rather than stopping at the first", () => {
    const dir = makeFixtureDir();
    writeMigration(dir, "bad-name.sql", VALID_SQL);
    writeMigration(dir, "20261014000100_empty.sql", "");
    writeMigration(dir, "20261014000102_mislabeled.txt", "content");

    const problems = validateMigrations(dir);
    expect(problems).toHaveLength(3);
    expect(problems).toContain("bad-name.sql: migration filenames must match \\d{14}_name.sql");
    expect(problems).toContain("20261014000100_empty.sql: empty migration file");
    expect(problems).toContain(
      "20261014000102_mislabeled.txt: looks like a migration but does not end in .sql",
    );
  });

  it("reports a missing directory as a problem rather than throwing", () => {
    const problems = validateMigrations(join(tmpdir(), "cliniccore-also-missing"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no such directory/);
  });
});
