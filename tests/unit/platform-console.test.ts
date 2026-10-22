/**
 * The platform console's DATA-LAYER refusal, asserted with the database replaced.
 *
 * WHY THIS FILE EXISTS. `readTenantDirectory` is the check AGENTS.md calls "the
 * data-layer one - the one that matters": the layout's `notFound()` produces the 404
 * RESPONSE, and this module decides whether the directory is read at all. Nothing
 * tested it, and the hole is the repository's recurring failure class: with the
 * refusal line deleted, `readTenantDirectory` would return the rows to anybody, and
 * EVERY other test would still pass - the integration suite proves the SQL refuses, and
 * the E2E proves the route 404s, but the route never reaches the page for an
 * unauthorised caller, so the page's own refusal is never exercised.
 *
 * WHY THE DATABASE IS REPLACED. The refusal is a control-flow decision made BEFORE a
 * query, so what has to be observed is WHICH CALLS WERE MADE - not what the database
 * said. A stub answers the two RPCs and records that they were called, and the
 * assertion that matters is that `tenant_directory` was NOT among them: a directory
 * that was fetched and then discarded has still left the server.
 *
 * THE `server-only` ALIAS IS WHAT MAKES THIS POSSIBLE. `lib/auth/platform.ts` imports
 * it as its first line, and the package's entry point THROWS outside a React Server
 * Component bundler - which is the real boundary, and which would otherwise make the
 * module unimportable from a test. `vitest.config.ts` aliases it to an inert stub;
 * the production boundary is untouched.
 */
import { beforeEach, expect, it, vi } from "vitest";

/** What the stub answers for one RPC. */
type Answer = { data: unknown; error: { message: string } | null };

/** The RPC names the module asked for, in order. */
let calls: string[] = [];

/** The scripted answers, keyed by RPC name. */
let answers: Record<string, Answer> = {};

const client = {
  rpc: async (fn: string): Promise<Answer> => {
    calls.push(fn);
    return answers[fn] ?? { data: null, error: { message: `no answer scripted for ${fn}` } };
  },
};

vi.doMock("../../lib/supabase/server", () => ({
  createServerClient: async () => client,
}));

const { readTenantDirectory } = await import("../../lib/auth/platform");

beforeEach(() => {
  calls = [];
  answers = {};
});

it("refuses the directory for a caller who is not a platform administrator", async () => {
  answers = {
    is_platform_admin: { data: false, error: null },
    tenant_directory: {
      data: [{ name: "A tenant", status: "active", member_count: 1 }],
      error: null,
    },
  };

  await expect(readTenantDirectory()).resolves.toBeNull();
});

it("refuses BEFORE it reads, so an unauthorised caller never fetches the directory", async () => {
  // THE CONTROL THAT CAN FAIL. The refusal is a decision made before the query, and a
  // directory that was fetched and then thrown away has still left the server - and a
  // leak is a leak whatever the caller does with the rows afterwards. Deleting the
  // refusal line makes this fail with "expected null but got rows" AND with the RPC
  // having been called.
  answers = {
    is_platform_admin: { data: false, error: null },
    tenant_directory: {
      data: [{ name: "A tenant", status: "active", member_count: 1 }],
      error: null,
    },
  };

  await expect(readTenantDirectory()).resolves.toBeNull();
  expect(calls).toEqual(["is_platform_admin"]);
  expect(calls).not.toContain("tenant_directory");
});

it("reads the directory for a platform administrator", async () => {
  answers = {
    is_platform_admin: { data: true, error: null },
    tenant_directory: {
      data: [{ name: "A tenant", status: "active", member_count: 3 }],
      error: null,
    },
  };

  await expect(readTenantDirectory()).resolves.toEqual([
    { name: "A tenant", status: "active", memberCount: 3 },
  ]);
  expect(calls).toContain("tenant_directory");
});

it("fails CLOSED when the read itself errors", async () => {
  // A failed read is not a directory, and half a directory is worse than none: the
  // caller cannot tell a truncated answer from a whole one.
  answers = {
    is_platform_admin: { data: true, error: null },
    tenant_directory: { data: null, error: { message: "the database is unreachable" } },
  };

  await expect(readTenantDirectory()).resolves.toBeNull();
});

it("fails CLOSED when the PREDICATE cannot be asked", async () => {
  // An unreachable database is not an answer, and `true` would open the console.
  answers = { is_platform_admin: { data: null, error: { message: "unreachable" } } };

  await expect(readTenantDirectory()).resolves.toBeNull();
  expect(calls).not.toContain("tenant_directory");
});
