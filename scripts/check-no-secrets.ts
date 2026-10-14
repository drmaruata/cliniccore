import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Secret-leak gate.
 *
 * Rule 1 — `SUPABASE_SERVICE_ROLE_KEY` may only be referenced from
 *          `lib/supabase/server.ts` or from files under `tests/`.
 * Rule 2 — no file carrying the `"use client"` directive may reference it,
 *          regardless of location.
 * Rule 3 — no source file may contain a literal Supabase secret key
 *          (`sb_secret_...`) or a hard-coded JWT (`eyJ...`).
 *
 * Exported as `check()` so it can be unit-tested with in-memory inputs; the
 * filesystem walk only runs when this module is executed directly.
 */

export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

/** The single source file permitted to read the service role key. */
const ALLOWED_SERVICE_ROLE_FILES = ["lib/supabase/server.ts"];

/** Path prefixes (repo-relative, forward-slash) where references are allowed. */
const ALLOWED_SERVICE_ROLE_PREFIXES = ["tests/"];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"]);

/** Directories walked by the CLI. */
const WALK_ROOTS = ["app", "components", "lib", "scripts"];

const SECRET_LITERAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "hard-coded JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{10,}/ },
];

/**
 * Doc/test placeholders that are safe to mention in source without tripping the
 * gate — e.g. the literal `sb_secret_replace_me` used in `.env.example`.
 */
const PLACEHOLDER_ALLOWLIST = [/replace_me/];

export interface SecretCheckInput {
  /** Repo-relative path, forward-slash separated. */
  path: string;
  /** Full file contents. */
  contents: string;
}

export interface SecretViolation {
  path: string;
  reason: string;
}

/** True when the file declares itself a client component (first statement). */
export function isClientFile(contents: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*(?:"use client"|'use client')/.test(contents);
}

/** True when `path` is permitted to reference the service role key. */
export function isAllowedServiceRolePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (ALLOWED_SERVICE_ROLE_FILES.some((allowed) => normalized === allowed)) {
    return true;
  }
  return ALLOWED_SERVICE_ROLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Evaluate one file. Returns the list of violations found (empty when clean).
 */
export function findViolations(file: SecretCheckInput): SecretViolation[] {
  const violations: SecretViolation[] = [];
  const client = isClientFile(file.contents);

  if (file.contents.includes(SERVICE_ROLE_ENV)) {
    if (client) {
      violations.push({
        path: file.path,
        reason: `"use client" file references ${SERVICE_ROLE_ENV} — the service role key can never reach the browser`,
      });
    } else if (!isAllowedServiceRolePath(file.path)) {
      violations.push({
        path: file.path,
        reason: `${SERVICE_ROLE_ENV} is only readable in ${ALLOWED_SERVICE_ROLE_FILES.join(", ")} or ${ALLOWED_SERVICE_ROLE_PREFIXES.join(", ")}`,
      });
    }
  }

  for (const { name, pattern } of SECRET_LITERAL_PATTERNS) {
    const match = file.contents.match(pattern)?.[0] ?? "";
    if (match && !PLACEHOLDER_ALLOWLIST.some((allowed) => allowed.test(match))) {
      violations.push({ path: file.path, reason: `possible hard-coded secret: ${name}` });
    }
  }

  return violations;
}

/**
 * Brief Step 4 contract: `true` when every file is clean, `false` otherwise.
 * Accepts either tuples or objects.
 */
export type SecretCheckEntry = SecretCheckInput | readonly [string, string];

export function check(files: readonly SecretCheckEntry[]): boolean {
  const normalized: SecretCheckInput[] = files.map((file) =>
    Array.isArray(file)
      ? { path: String(file[0]), contents: String(file[1]) }
      : (file as SecretCheckInput),
  );
  return normalized.every((file) => findViolations(file).length === 0);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function collectFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      collectFiles(full, out);
    } else if ([...SOURCE_EXTENSIONS].some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

export function run(repoRoot: string): string[] {
  const violations: SecretViolation[] = [];
  for (const walkRoot of WALK_ROOTS) {
    const dir = join(repoRoot, walkRoot);
    for (const file of collectFiles(dir)) {
      const rel = relative(repoRoot, file).split(sep).join("/");
      if (rel === "scripts/check-no-secrets.ts") continue;
      violations.push(...findViolations({ path: rel, contents: readFileSync(file, "utf8") }));
    }
  }
  return violations.map((v) => `${v.path}: ${v.reason}`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const violations = run(repoRoot);
  if (violations.length > 0) {
    console.error("check:secrets FAILED — possible secret leak:\n");
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("");
    process.exit(1);
  }
  console.log("check:secrets OK — no service-role or hard-coded secret references found.");
}
