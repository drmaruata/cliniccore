/**
 * Stub for the `server-only` package, aliased in `vitest.config.ts`.
 *
 * WHY IT IS NEEDED. `server-only`'s entry point throws on import outside a React Server
 * Component bundler context - `node_modules/server-only/index.js` is literally a `throw`.
 * That is the real boundary, not a lint convention, and it is why it must stay the first
 * line of `lib/supabase/server.ts`.
 *
 * It also means that module cannot be imported by a test at all without this alias, which
 * is not a hypothetical: `createServerClient`, `getUser` and `getClaims` had ZERO
 * coverage for exactly that reason, and a live contract violation sat in `getUser`
 * undetected - it threw where its own `Promise<User | null>` promised `null`, on every
 * anonymous page render.
 *
 * This stub keeps the suite able to exercise the module while leaving the production
 * boundary untouched. It does NOT weaken anything: the real import still fails a genuine
 * client-component build, which is the case the boundary exists for.
 */
export {};
