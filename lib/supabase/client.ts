/**
 * Browser-side Supabase client.
 *
 * WHY A FACTORY RATHER THAN A MODULE-LEVEL CLIENT IN THIS FILE. A module-level client
 * would read the environment at IMPORT time. Reading it inside the function instead keeps
 * this module importable from a test that sets `process.env` itself, rather than
 * depending on whether a prefixed variable reaches a test through `process.env` or only
 * through `import.meta.env` - a Vite-version detail the database helper already refuses
 * to depend on.
 *
 * MEASURED AND CORRECTED: an earlier version of this comment claimed the caller "owns"
 * the returned client, which is not what happens. `@supabase/ssr`'s `createBrowserClient`
 * keeps a module-level `cachedBrowserClient` and returns it whenever `isBrowser()` is
 * true - which includes jsdom, so it is true under test as well as in production. Two
 * calls here therefore return the SAME object. That is the library's deliberate design and
 * it is the desirable one here: one cookie-managed client per browser, not a fresh one per
 * component render. `tests/unit/supabase-browser-client.test.ts` pins both facts.
 *
 * The publishable key is browser-safe by construction; `SUPABASE_SERVICE_ROLE_KEY` must
 * never appear in anything reachable from this file.
 */
import { createBrowserClient as createSsrBrowserClient } from "@supabase/ssr";

import type { Database } from "../../types/database.types";

/** A Supabase client for use in Client Components. */
export function createBrowserClient() {
  return createSsrBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  );
}
