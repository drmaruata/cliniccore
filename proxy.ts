import type { NextRequest } from "next/server";

import { updateSession } from "./lib/supabase/proxy";

/**
 * Next.js 16 request proxy. Renamed from `middleware.ts`/`middleware` in Next 16, and a
 * leftover `middleware` export is silently IGNORED - the session refresh would simply
 * never run and the symptom would be users being logged out at random. Verified against
 * node_modules/next/dist/docs for this exact version: the file must live at the project
 * root, export `proxy` (or a default), and runs on the Node.js runtime.
 *
 * NOTE: the `runtime` config option is NOT available here. Setting it throws.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Without a matcher the proxy runs on EVERY request including CSS, JS and images, where
  // an auth redirect would block the page from rendering at all. The negative lookahead
  // skips Next's static output and anything that looks like a file.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map|ico|woff2?)$).*)",
  ],
};
