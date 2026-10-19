/**
 * Browser-side Supabase client.
 *
 * WHY A FACTORY RATHER THAN A SINGLETON. A module-level client would be constructed once
 * per bundle and would capture the environment at import time, which is the shape that
 * breaks under server rendering and makes a signed-out user hard to reason about. A
 * factory returns a client the caller owns.
 *
 * WHY THE ENV VARS ARE READ AT CALL TIME. `NEXT_PUBLIC_*` is inlined by Next at build
 * time in the browser, but reading it inside the function keeps this module importable
 * from a test that sets `process.env` itself, rather than depending on whether a prefixed
 * variable reaches a test through `process.env` or only through `import.meta.env` - a
 * Vite-version detail the database helper already refuses to depend on.
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
