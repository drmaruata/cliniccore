/*
 * The public RPC surface, asserted at the CATALOGUE level.
 *
 * WHY A SEPARATE FILE FROM public-rpc.test.ts. That file proves the functions are
 * REACHABLE from a browser, over real HTTPS. This one proves the privilege posture, which
 * is a different question and needs a different instrument: PostgREST cannot return
 * `has_function_privilege`, so it needs a direct connection.
 *
 * WHY THE PRIVILEGE POSTURE MATTERS AT ALL. PostgREST's schema exposure was the ONLY
 * thing containing the `private` functions - and the public schema holds `write_audit` and
 * `next_sequence_value`, which no policy and no trigger calls. A signed-in role could
 * therefore write fabricated rows into its own tenant's audit trail, or burn its identifier
 * space, if the schema setting ever changed. The wrappers are not only about making the
 * browser able to call things; they are about making the private surface unreachable
 * EXCEPT through them.
 *
 * The assertions below are deliberately two-sided. It is easy to revoke a privilege and
 * break every RLS policy in the application, because a policy's expression is evaluated as
 * the QUERYING role and needs EXECUTE on the functions it calls. So the revoked set and
 * the untouched set are both asserted.
 */
import { expect, it } from "vitest";

import { beginSession, dbDescribe } from "./helpers/database";

/** Functions an RLS policy expression calls, evaluated as the querying role. */
const POLICY_REFERENCED = [
  "assigned_to_self",
  "can",
  "can_assign_role",
  "can_grant",
  "clinic_ids",
  "current_org_ids",
  "is_member",
  "is_platform_admin",
  "storage_clinic_id",
  "storage_org_id",
  "storage_path_is_safe",
];

const PUBLIC_WRAPPERS = [
  "accept_invitation",
  "can",
  "create_organization_with_owner",
  "delete_organization",
  "export_patients",
  "grantable_roles",
  "write_audit",
];

/**
 * The wrappers that DELEGATE to a private original, and so must mirror its signature
 * exactly - defaults included.
 *
 * `public.delete_organization` is deliberately not among them: it has no private original
 * because it performs the delete itself, so there is no signature to mirror. That is a
 * real difference, not an oversight, and lumping the two lists together would assert a
 * parity that does not exist.
 *
 * `public.grantable_roles` is not among them for the same reason: it calls
 * `private.can_assign_role`, which is a different function with a different signature.
 */
const DELEGATING_WRAPPERS = [
  "accept_invitation",
  "can",
  "create_organization_with_owner",
  "write_audit",
];

/** No policy, no trigger, and called by nothing. */
const HARDENED = ["write_audit", "next_sequence_value", "create_organization_with_owner"];

dbDescribe("the public RPC surface", () => {
  it("exposes only our own functions in public, and nothing else", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{ fn: string }>(
        `select p.proname as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and not exists (
              select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
               where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                 and d.deptype = 'e'
            )
            -- rls_auto_enable is Supabase's own, and is deliberately EXCLUDED here
            -- rather than counted: it is not ours, it is SECURITY DEFINER, and it carries
            -- a PUBLIC grant, so it is anon-callable. Calling it over HTTP is harmless -
            -- it errors with "cannot display a value of type event_trigger" - but the
            -- claim "the public schema exposes exactly three functions" would be false
            -- because of it, and a false claim in a test's name is worse than a precise
            -- one.
            and p.proname <> 'rls_auto_enable'
          order by p.proname`,
      );
      expect(rows.map((r) => r.fn)).toEqual(PUBLIC_WRAPPERS);
    } finally {
      await session.rollback();
    }
  });

  it("makes every wrapper executable by authenticated and by nobody else", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{
        fn: string;
        secdef: boolean;
        auth: boolean;
        anon: boolean;
      }>(
        `select p.proname as fn, p.prosecdef as secdef,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('anon', p.oid, 'execute') as anon
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1::text[])
          order by p.proname`,
        [PUBLIC_WRAPPERS],
      );
      expect(rows.length).toBe(PUBLIC_WRAPPERS.length);
      for (const row of rows) {
        expect(row.auth, `${row.fn} must be callable by a signed-in browser`).toBe(true);
        expect(row.anon, `${row.fn} must NOT be callable anonymously`).toBe(false);
        // SECURITY DEFINER, so the wrapper can reach the private function it delegates to
        // even where `authenticated` cannot - which is what makes the revocation below
        // possible at all.
        expect(row.secdef, `${row.fn} must be SECURITY DEFINER`).toBe(true);
      }
    } finally {
      await session.rollback();
    }
  });

  it("withholds the private functions that no policy and no trigger calls", async () => {
    const session = await beginSession();
    try {
      const rows = await session.query<{ fn: string; auth: boolean }>(
        `select p.proname as fn,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = any($1::text[])
          order by p.proname`,
        [HARDENED],
      );
      expect(rows.length).toBe(HARDENED.length);
      for (const row of rows) {
        expect(
          row.auth,
          `private.${row.fn} must not be directly callable by a signed-in role - it is reachable only through its public wrapper`,
        ).toBe(false);
      }
    } finally {
      await session.rollback();
    }
  });

  it("gives every wrapper EXACTLY the signature of the function it wraps", async () => {
    // A wrapper that changes the signature is not a thin wrapper - it is a different API,
    // and a stricter one. MEASURED: the first version of
    // public.create_organization_with_owner declared `p_timezone text` with no default
    // while private.create_organization_with_owner declares
    // `p_timezone text DEFAULT 'Asia/Kolkata'`, so every caller that relied on the
    // default broke with "function public.create_organization_with_owner(unknown, unknown,
    // unknown) does not exist".
    //
    // A DEFAULT is part of a function's contract, not an optional extra, so the two
    // signatures are compared INCLUDING their defaults. Both sides use the same parameter
    // names, so the defaulted argument strings are simply equal. This is the assertion
    // that would have caught it, and it covers the next wrapper too.
    const session = await beginSession();
    try {
      const rows = await session.query<{ pub: string; pub_args: string; priv_args: string }>(
        `select pub.proname as pub,
                pg_get_function_arguments(pub.oid) as pub_args,
                pg_get_function_arguments(priv.oid) as priv_args
           from pg_proc pub
           join pg_namespace n on n.oid = pub.pronamespace
           join pg_proc priv on priv.proname = pub.proname
           join pg_namespace n2 on n2.oid = priv.pronamespace and n2.nspname = 'private'
          where n.nspname = 'public' and pub.proname = any($1::text[])
          order by pub.proname`,
        [DELEGATING_WRAPPERS],
      );
      expect(rows.length).toBe(DELEGATING_WRAPPERS.length);
      for (const row of rows) {
        expect(
          row.pub_args,
          `public.${row.pub} must have the same arguments AND defaults as private.${row.pub}`,
        ).toBe(row.priv_args);
      }
    } finally {
      await session.rollback();
    }
  });

  it("leaves the trigger-referenced private functions as they were", async () => {
    // Six more functions are referenced by TRIGGERS, which fire as their table's owner.
    // Two of them are deliberately NOT executable by `authenticated` - they were never
    // granted (01230 and 01240 revoked the PUBLIC grant and did not re-grant to
    // `authenticated`), and the trigger still fires for an `authenticated` caller because
    // a trigger's EXECUTE privilege is checked when the trigger is CREATED, not at fire
    // time.
    //
    // Asserted per function, because the expected values DIFFER - a blanket "all true"
    // would be wrong for two of them, and a blanket "all false" for the other four.
    const expected: Record<string, boolean> = {
      create_profile_for_new_user: true,
      guard_platform_admin: true,
      guard_role_delete: false,
      guard_role_identity: false,
      guard_role_org_scope: true,
      set_updated_at: true,
    };
    const session = await beginSession();
    try {
      const rows = await session.query<{ fn: string; auth: boolean }>(
        `select p.proname as fn,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = any($1::text[])
          order by p.proname`,
        [Object.keys(expected)],
      );
      expect(rows.length).toBe(Object.keys(expected).length);
      for (const row of rows) {
        expect(
          row.auth,
          `private.${row.fn} is called by a trigger and its privilege must not drift`,
        ).toBe(expected[row.fn] ?? false);
      }
    } finally {
      await session.rollback();
    }
  });

  it("leaves the policy-referenced private functions executable, or every RLS policy breaks", async () => {
    // The blast radius of the revocation above. A policy's expression is evaluated as the
    // QUERYING role, so revoking EXECUTE on a function a policy calls would make every
    // row invisible rather than every row denied - a silent, total failure. MEASURED before
    // the revocation: ten functions are referenced by policies.
    const session = await beginSession();
    try {
      const rows = await session.query<{ fn: string; auth: boolean }>(
        `select p.proname as fn,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = any($1::text[])
          order by p.proname`,
        [POLICY_REFERENCED],
      );
      expect(rows.length).toBe(POLICY_REFERENCED.length);
      for (const row of rows) {
        expect(
          row.auth,
          `private.${row.fn} is called by an RLS policy and must stay executable by authenticated`,
        ).toBe(true);
      }
    } finally {
      await session.rollback();
    }
  });
});
