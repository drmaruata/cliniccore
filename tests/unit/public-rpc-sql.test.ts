/*
 * The public RPC surface, asserted in the MIGRATION SOURCE.
 *
 * WHY THIS FILE EXISTS. The integration suite proves the LIVE DATABASE behaves. It does not
 * prove the SOURCE says so, and there is no applied-versus-source checksum anywhere in the
 * repository - `npm run migrations:check` validates filenames and emptiness only.
 *
 * MEASURED: with the four CHECK constraints removed from 20261014001630, or the time zone
 * guard removed from 20261014001640, or the wrapper's own validation removed, THE ENTIRE
 * SUITE STAYS GREEN. A future migration - or a careless edit to an applied file - can
 * remove the rules with nothing failing.
 *
 * That is the same failure mode the Task 12 work fixed for the three hardened functions:
 * a source-level test can document a posture the database no longer has. This is that
 * test, for the validation rules.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

const migrationSource = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), "utf8");

const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
  .join("\n");

describe("the public RPC surface is asserted in the migration source", () => {
  it("keeps the table constraints that hold for every write path", () => {
    const source = migrationSource("20261014001630_public_rpc_input_validation.sql");
    // A CONSTRAINT, not a function check, so it holds for a migration, for service_role,
    // and for anything else that writes the table.
    expect(source).toContain("add constraint organizations_slug_format_check");
    expect(source).toContain("add constraint organizations_slug_length_check");
    expect(source).toContain("add constraint organizations_name_length_check");
    expect(source).toContain("add constraint clinics_name_length_check");
    // The rule the application already enforced, in the database now.
    expect(source).toContain("'^[a-z0-9]+(-[a-z0-9]+)*$'");
  });

  it("keeps the time zone guard, which is a trigger and not a constraint", () => {
    const source = migrationSource("20261014001640_timezone_guard.sql");
    // A CHECK constraint may not call a function that reads a table, and the zone list is
    // a view - so this has to be a trigger, and the trigger is what covers the UPDATE path.
    expect(source).toContain("create or replace function private.guard_timezone()");
    expect(source).toContain("create trigger organizations_guard_timezone");
    expect(source).toContain("create trigger clinics_guard_timezone");
    expect(source).toContain("before insert or update on public.organizations");
    expect(source).toContain("before insert or update on public.clinics");
    // And the rule: a canonical IANA name, or UTC.
    expect(source).toContain("pg_catalog.pg_timezone_names");
    expect(source).toContain("not in ('UTC', 'GMT')");
  });

  it("keeps the NULL-zone rule the schema permits, and refuses the one it does not", () => {
    // 01640 refused a NULL zone on BOTH tables, and clinics.timezone is NULLABLE BY
    // DESIGN - so 50 security tests failed with "a time zone is required". The guard was
    // wrong, not the tests, and 01650 corrected it: NULL is refused for organizations,
    // whose column is NOT NULL, and permitted for clinics, whose column is nullable.
    const source = migrationSource("20261014001650_timezone_guard_nullable_clinics.sql");
    expect(source).toContain("create or replace function private.guard_timezone()");
    expect(source).toContain("TG_TABLE_NAME = 'organizations'");
    // And the rule that matters on both tables: a PRESENT zone must be canonical.
    expect(source).toContain("pg_catalog.pg_timezone_names");
    expect(source).toContain("not in ('UTC', 'GMT')");
  });

  it("keeps the wrapper's own validation, so the CREATE door refuses clearly", () => {
    // The wrapper is defined in 01640; 01650 only replaced the TRIGGER function.
    const source = migrationSource("20261014001640_timezone_guard.sql");
    expect(source).toContain("create or replace function public.create_organization_with_owner");
    expect(source).toContain("organization slug must be lowercase kebab-case");
    expect(source).toContain("organization name must be 1 to 120 characters");
    expect(source).toContain("clinic name must be 1 to 120 characters");
    expect(source).toContain("unknown time zone");
  });

  it("keeps the wrapper's signature mirroring the private original, defaults included", () => {
    // A wrapper that changes the signature is not a thin wrapper. The private original
    // declares `p_timezone text DEFAULT 'Asia/Kolkata'`, and a wrapper that dropped the
    // default broke every caller that relied on it.
    const source = migrationSource("20261014001640_timezone_guard.sql");
    expect(source).toContain("p_timezone text default 'Asia/Kolkata'");
  });

  it("keeps the revocations, and does not re-grant what it revoked", () => {
    // The three private functions that no policy and no trigger calls must stay
    // unreachable by a signed-in role. Migrations are append-only, so the historical
    // GRANT legitimately remains in 00600/00700/00800 - what matters is that the LAST
    // privilege statement about each function is the revoke.
    const lastPrivilege = (signature: string) => {
      const grant = `grant execute on function private.${signature} to authenticated;`;
      const revoke = `revoke execute on function private.${signature} from authenticated;`;
      const g = ALL.lastIndexOf(grant);
      const r = ALL.lastIndexOf(revoke);
      if (g < 0 && r < 0) return "none";
      return r > g ? "revoke" : "grant";
    };
    expect(lastPrivilege("next_sequence_value(uuid, text)")).toBe("revoke");
    expect(lastPrivilege("write_audit(uuid, text, text, uuid, jsonb)")).toBe("revoke");
    expect(lastPrivilege("create_organization_with_owner(text, text, text, text)")).toBe("revoke");
  });

  it("keeps every public wrapper SECURITY DEFINER with an empty search path", () => {
    // A SECURITY DEFINER function with a caller-controlled search path is the classic
    // escalation shape, and `set search_path = ''` with fully qualified references is
    // what closes it.
    for (const name of [
      "20261014001600_public_rpc_wrappers.sql",
      "20261014001610_public_rpc_wrapper_signature.sql",
      "20261014001620_public_rpc_wrapper_defaults.sql",
      "20261014001630_public_rpc_input_validation.sql",
      "20261014001640_timezone_guard.sql",
      // NOT 01650: that file replaces the TRIGGER function, which runs as the invoker and
      // is deliberately not SECURITY DEFINER. Only the public wrappers are.
    ]) {
      const source = migrationSource(name);
      expect(source, name).toContain("security definer");
      expect(source, name).toContain("set search_path = ''");
    }
  });
});
