/**
 * `createBrowserClient` - the one brief interface with no coverage until now, and the one
 * whose doc comment turned out to OVERCLAIM.
 *
 * WHY THIS EXISTS. The module claimed a factory rather than a module-level singleton
 * because a singleton "would capture the environment at import time", and the caller would
 * own the returned client. Converting the factory to a singleton left the entire suite
 * green, so nothing pinned either claim.
 *
 * WHAT IS ACTUALLY TRUE, MEASURED. `@supabase/ssr`'s `createBrowserClient` keeps a
 * module-level `cachedBrowserClient` and returns it whenever `isBrowser()` is true -
 * which includes jsdom, so it holds under test as well as in production. Two calls return
 * the SAME object no matter what this module does. The library's memoisation is
 * deliberate and desirable here: one cookie-managed client per browser rather than a fresh
 * one per component render. So the honest statement of what the factory buys is narrower
 * than the comment claimed, and both facts are pinned below rather than asserted in prose.
 *
 * No signup and no network.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_KEY = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
const GOOD_URL = "https://project-ref.supabase.co";
const GOOD_KEY = "sb_publishable_placeholder";

const previous = new Map<string, string | undefined>();

beforeEach(() => {
  // Save and set rather than delete on the way out: another suite's beforeAll may have set
  // these, and deleting them during cleanup would corrupt its run.
  previous.set(URL_KEY, process.env[URL_KEY]);
  previous.set(KEY_KEY, process.env[KEY_KEY]);
  process.env[URL_KEY] = GOOD_URL;
  process.env[KEY_KEY] = GOOD_KEY;
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
});

it("reads the public environment when called, not when imported", async () => {
  // A fresh module graph, because the underlying library memoises its client per module
  // instance - without the reset the first test to call it would populate the cache and
  // every later assertion would be reading someone else's client.
  vi.resetModules();
  process.env[URL_KEY] = "not-a-url";
  const { createBrowserClient } = await import("../../lib/supabase/client");
  // Defeated by hoisting the client to a module-level constant: it would have been built
  // at import time, with whatever the environment said then.
  expect(() => createBrowserClient()).toThrow();
});

it("memoises through the library, so every caller shares one client", async () => {
  // Pinned because it is the opposite of what the module's comment used to claim. If a
  // future @supabase/ssr stops caching, that is a behaviour change worth seeing rather
  // than discovering in production.
  vi.resetModules();
  const { createBrowserClient } = await import("../../lib/supabase/client");
  expect(createBrowserClient()).toBe(createBrowserClient());
});

it("returns a client with the auth and query surface the app uses", async () => {
  vi.resetModules();
  const { createBrowserClient } = await import("../../lib/supabase/client");
  const client = createBrowserClient();
  expect(typeof client.auth.getSession).toBe("function");
  expect(typeof client.auth.signOut).toBe("function");
  expect(typeof client.from).toBe("function");
});
