import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Secret-leak gate.
 *
 * Rule 1 — `SUPABASE_SERVICE_ROLE_KEY` may only be *referenced as code* from
 *          `lib/supabase/server.ts` or from files under `tests/`. Comments are
 *          stripped before matching, so prose about the constraint is allowed.
 * Rule 2 — no file carrying the `"use client"` directive may reference it,
 *          regardless of location.
 * Rule 3 — no `"use client"` file may import anything under `lib/supabase/`.
 *          This is the canonical Next.js + Supabase leak:
 *
 *              "use client";
 *              import { adminClient } from "@/lib/supabase/server";
 *
 *          Such a file names neither the env var nor a secret literal, so
 *          rules 1, 2 and 4 cannot see it. Resolution handles `@/lib/supabase/…`,
 *          `lib/supabase/…` and relative `../lib/supabase/…` specifiers.
 * Rule 4 — no scanned file may contain a literal Supabase secret key
 *          (`sb_secret_...`) or a hard-coded JWT (`eyJ...`), subject only to the
 *          placeholder allowlist. There is NO path-based exemption: rule 4 is
 *          the only rule that catches a hard-coded credential, so it applies
 *          everywhere, `tests/` included. Fixtures that need a secret-shaped
 *          literal construct it at runtime rather than embedding it.
 *
 * WHAT IS SCANNED. Source files, `.sql` files, and the tracked env template.
 * Rules 1–3 are *code* rules and apply only to source files; an env file or a
 * migration legitimately names `SUPABASE_SERVICE_ROLE_KEY` in a comment or an
 * assignment, so flagging that would be a false positive on the template. Rule
 * 4 applies to every scanned file — that is the rule that catches a pasted
 * key, and `.env.example` is scanned like anything else.
 *
 * ENFORCEMENT LAYERS. `lib/supabase/server.ts` MUST begin with
 * `import "server-only"`; that is the PRIMARY defence, because it fails at
 * bundle time. CORRECTED after Task 12: the claim that vitest.config.ts does NOT
 * alias "server-only" was wrong — it DOES alias it (to a stub, so tests can
 * import lib/supabase/server.ts), and tests/unit/server-boundary.test.ts is what
 * keeps that alias out of the production config files, not this scanner. This
 * scanner still enforces the SUPABASE_SERVICE_ROLE_KEY path rule and the "use
 * client" rule; the `import "server-only"` line itself is pinned by that test.
 * Rule 3 is the SECONDARY layer: it fails in `npm run lint` even when the
 * bundler would not, and it catches the mistake in review. See
 * docs/IMPLEMENTATION_STATUS.md — the obligation is carried into the later
 * Supabase task.
 *
 * Exported as `check()` so it can be unit-tested with in-memory inputs; the
 * filesystem walk only runs when this module is executed directly.
 */

export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

/** The single source file permitted to read the service role key. */
const ALLOWED_SERVICE_ROLE_FILES = ["lib/supabase/server.ts"];

/** Path prefixes (repo-relative, forward-slash) where references are allowed. */
const ALLOWED_SERVICE_ROLE_PREFIXES = ["tests/"];

/**
 * Repo-relative prefix that must never be imported from a client component.
 * `server-only` plus the bundler is the primary guard; this is the backstop.
 */
const SERVER_MODULE_PREFIX = "lib/supabase/";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"];

/**
 * Extensions scanned for a hard-coded credential (rule 4). A superset of
 * `SOURCE_EXTENSIONS`: a Postgres migration is just as capable of carrying a
 * pasted key as a TypeScript file.
 *
 * `.md`, `.json`, `.yml` and friends are deliberately NOT here. The plan
 * document under `docs/superpowers/plans/` carries illustrative credentials
 * (`postgres://user:hunter2@`, `sb_secret_replace_me`) that are part of its
 * prose, so widening the walk to prose or data files would make those permanent
 * false positives and train people to ignore the gate. `.env*` is handled
 * separately, by name, because it is both the highest-value target and the one
 * case where a blanket rule would be wrong.
 */
const CREDENTIAL_SCAN_EXTENSIONS = [...SOURCE_EXTENSIONS, ".sql"];

/**
 * The `.env*` files that are walked.
 *
 * `.gitignore` is `.env*` with `!.env.example`, so `.env.example` is the only
 * env file that can reach version control - and therefore the only one whose
 * contents are a leak risk. It is scanned like any other file; a real key
 * pasted into it fails the gate.
 *
 * The other `.env*` names are skipped because they are gitignored *by this
 * repo's own policy*: they cannot be committed without `git add -f`, and the
 * gate's entire threat model is a committed leak. They also hold real
 * developer credentials by design - `.env.local` is the file you are told to
 * put the service-role key in - so scanning them would make `check:secrets`
 * permanently red in every correctly configured checkout. A gate people have
 * to disable is not a gate, and that is worse than the gap it closes.
 *
 * The exclusion is checked against the real `.gitignore` by the unit test
 * "skips every env file git ignores and reads every one git does not" in
 * tests/unit/check-no-secrets.test.ts. Scope limit: that test probes a fixed
 * list of env-file names, so it catches drift for those names only. Un-ignoring
 * a DIFFERENT name (e.g. adding `!.env.sample` to .gitignore) would leave this
 * constant stale and the gate blind without failing any test - recorded as a
 * residual in the round-5 report.
 */
const TRACKED_ENV_FILES = [".env.example"];

/**
 * Directory names never walked. The walk starts at the repo root so that
 * root-level sources are covered, and any directory beginning with "." is
 * skipped as well.
 */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  "out",
  "build",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  "blob-report",
  ".turbo",
  ".vercel",
]);

/** This file names the env var in strings and comments; it skips itself. */
const SELF_PATH = "scripts/check-no-secrets.ts";

const SECRET_LITERAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "hard-coded JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{10,}/ },
];

/**
 * Doc/test placeholders that are safe to mention in a scanned file without
 * tripping rule 4.
 *
 * Two files the walk reads carry the literal `sb_secret_replace_me`, and both
 * are load-bearing:
 *
 *   1. `tests/unit/check-no-secrets.test.ts` - the allowlist has to be
 *      exercised against a literal string, or the assertion testing it is
 *      meaningless. Emptied, this fails:
 *        - "allows documented placeholders like sb_secret_replace_me"
 *        - "is clean against the real repository tree"
 *        - "keeps .env.example green because its values are inert, not
 *           because it is exempt"
 *        - "does not apply the code rules to .env or .sql files"
 *   2. `.env.example` line 14 - `SUPABASE_SERVICE_ROLE_KEY=sb_secret_replace_me`.
 *      That file is walked, so it is a SECOND live reason the list must exist.
 *      It was not one before the `.env*` walk change; the comment this replaces
 *      claimed it was not one at all, which was wrong. Re-measured after the
 *      walk widened, not inherited.
 *
 * `replace_me` is a marker, not a credential. If a real key ever reaches either
 * site it does not contain `replace_me` and the gate still fails - see the
 * round-4 report for that end-to-end check on both file types.
 */
const PLACEHOLDER_ALLOWLIST = [/replace_me/];

/** Module specifiers that are rooted at the repo, written without `./`. */
const ROOTED_SPECIFIER_PREFIXES = ["app/", "components/", "lib/", "scripts/", "tests/"];

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

/* ---- Lexical helpers ---- */

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Collapse `.` and `..` segments and drop empty ones. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of toPosix(path).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Remove `//` and block comments while preserving string literals, so that a
 * `//` inside a string does not swallow the rest of the line.
 *
 * Known limitation: a regex literal containing an unbalanced quote can confuse
 * the scanner. That is acceptable for a lint gate - the worst case is a false
 * positive that a human removes - and no source file in this repo does it.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < n && source[i] !== ch) {
        if (source[i] === "\\") {
          out += source[i] ?? "";
          out += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        out += source[i] ?? "";
        i++;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const IMPORT_SPECIFIER_PATTERNS: RegExp[] = [
  // import ... from "x" / export ... from "x"  (stops at ; or a quote)
  /(?:^|[;\n}])\s*(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/g,
  // side-effect import: import "x"
  /(?:^|[;\n}])\s*import\s*["']([^"']+)["']/g,
  // dynamic import("x") and require("x")
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Every static/dynamic module specifier appearing in `contents`. */
export function extractImportSpecifiers(contents: string): string[] {
  const code = stripComments(contents);
  const found = new Set<string>();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * Resolve a module specifier against the importing file, returning a
 * repo-relative POSIX path. Bare package specifiers (`next`, `clsx`) return
 * `null` — they are not repo paths.
 */
export function resolveImportSpecifier(specifier: string, fromPath: string): string | null {
  const spec = toPosix(specifier);
  const base = dirname(toPosix(fromPath));
  if (spec.startsWith("@/") || spec.startsWith("~/")) return normalizePath(spec.slice(2));
  if (spec.startsWith("./") || spec.startsWith("../")) return normalizePath(`${base}/${spec}`);
  if (spec.startsWith("/")) return normalizePath(spec);
  if (ROOTED_SPECIFIER_PREFIXES.some((prefix) => spec.startsWith(prefix)))
    return normalizePath(spec);
  return null;
}

/** True when `specifier`, imported from `fromPath`, reaches `lib/supabase/`. */
export function resolvesIntoServerModule(specifier: string, fromPath: string): boolean {
  const resolved = resolveImportSpecifier(specifier, fromPath);
  return resolved !== null && resolved.startsWith(SERVER_MODULE_PREFIX);
}

/** Server-module specifiers imported by a file, deduped. */
export function findServerModuleImports(file: SecretCheckInput): string[] {
  return extractImportSpecifiers(file.contents).filter((specifier) =>
    resolvesIntoServerModule(specifier, file.path),
  );
}

/* ---- Rules ---- */

/** True when the file declares itself a client component (first statement). */
export function isClientFile(contents: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*(?:"use client"|'use client')/.test(contents);
}

/**
 * True when `path` is a source file, i.e. one the code-shaped rules 1-3 apply
 * to. Data and config files that the walk reads for rule 4 - `.env*` and `.sql`
 * - return false, because naming `SUPABASE_SERVICE_ROLE_KEY` in an env
 * assignment or in a `--` SQL comment is how those files are *supposed* to look.
 * Flagging it would be a false positive, and on `.env.example` a permanent one.
 *
 * Known limitation: adding a new non-source extension to
 * `CREDENTIAL_SCAN_EXTENSIONS` silently opts it out of rules 1-3. Intentional -
 * those rules are about TypeScript/JavaScript shapes - but worth remembering.
 */
export function isSourceFilePath(path: string): boolean {
  const base = toPosix(path).split("/").pop() ?? "";
  return SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/** True when `path` is permitted to reference the service role key. */
export function isAllowedServiceRolePath(path: string): boolean {
  const normalized = normalizePath(path);
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
  const code = stripComments(file.contents);

  // Rules 1–3 read code. `.env*` and `.sql` files are walked for rule 4 only:
  // an env template has to name SUPABASE_SERVICE_ROLE_KEY on its assignment
  // line, and a migration may name it in a `--` comment, so applying the code
  // rules to them would fail on correct files rather than on leaks.
  if (isSourceFilePath(file.path)) {
    if (code.includes(SERVICE_ROLE_ENV)) {
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

    if (client) {
      for (const specifier of findServerModuleImports(file)) {
        violations.push({
          path: file.path,
          reason: `"use client" file imports ${specifier} — ${SERVER_MODULE_PREFIX}* is server-only (see the server-only / rule 3 note in scripts/check-no-secrets.ts)`,
        });
      }
    }
  }

  // Rule 4 is enforced EVERYWHERE, including under tests/. There is no path-based
  // exemption: it is the only rule that catches a hard-coded credential, and a
  // leaked key need not appear under the env-var name or a module path. Test
  // fixtures that need a secret-shaped literal build it at runtime instead —
  // see the note above tests/unit/check-no-secrets.test.ts.
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

/* ---- CLI ---- */

/**
 * True when a file with this basename should be read by the walk.
 *
 * Dot-files used to be skipped wholesale, which meant the gate could not see
 * `.env.example` at all: a real service-role key pasted there produced zero
 * violations and `check:secrets` exited 0. `.env*` is now walked, and `.sql`
 * joined the credential-scanned extensions.
 */
export function isScannableFileName(entry: string): boolean {
  if (entry.startsWith(".env")) return TRACKED_ENV_FILES.includes(entry);
  if (entry.startsWith(".")) return false;
  return CREDENTIAL_SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext));
}

function collectFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const full = join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry.startsWith(".")) continue;
      collectFiles(full, out);
    } else if (isScannableFileName(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Walk the whole repo and return human-readable violation lines. */
export function run(repoRoot: string): string[] {
  const violations: SecretViolation[] = [];
  for (const file of collectFiles(repoRoot)) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    if (rel === SELF_PATH) continue;
    violations.push(...findViolations({ path: rel, contents: readFileSync(file, "utf8") }));
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
