// @vitest-environment node
/**
 * The §8.3 mutation-verification loop, on a transaction that is always rolled back.
 *
 * A green isolation suite can pass for the wrong reason, and the three ways it does are
 * all about the ORDER of operations: reverting before the test runs, a mutation that
 * silently failed to apply, and a test that cannot reach the mutated path. So this
 * harness owns the order rather than trusting each caller to get it right:
 *
 *   1. apply the mutation,
 *   2. PROVE it applied, by reading `pg_policies` / `pg_constraint` / `pg_proc` rather
 *      than by assuming the statement worked - a silently failed mutation is
 *      indistinguishable from a passing test and is the most dangerous outcome here,
 *   3. run the assertion and require it to FAIL,
 *   4. restore, always, in a path that runs whether or not step 3 threw,
 *   5. run the assertion again and require it to PASS.
 *
 * WHY THE MUTATION LIVES IN A ROLLED-BACK TRANSACTION, AND WHY IT IS ONE TRANSACTION PER
 * MUTATION. Dropping or altering a policy takes an AccessExclusiveLock and is
 * DATABASE-wide, not session-wide: a committed change would be visible to every other
 * suite running in another vitest worker, and a SELECT policy altered to `using (true)`
 * is a LEAK, not a refusal. Inside a transaction the change is invisible to every other
 * connection until commit, and it never commits - so a crashed run is self-healing. A
 * single long-lived transaction would hold that AccessExclusiveLock across every
 * mutation in the file, which blocks a neighbouring worker's ordinary reads and writes
 * on those tables for the whole duration; one short transaction per mutation bounds the
 * lock window to the statements inside it.
 *
 * WHY THE MEASUREMENT IS `set local role authenticated`. The connection is `postgres`,
 * which owns the tables and bypasses RLS, so a measurement made before impersonating
 * would measure the table owner. `set local role` plus
 * `set_config('request.jwt.claim.sub', …, true)` is exactly the principal PostgREST
 * builds from a JWT, and both are transaction-local so the rollback restores them.
 *
 * WHY THE CATALOGUE IS READ ON THE SAME CONNECTION. The step-2 proof must see an
 * UNCOMMITTED `drop policy`, and `pg_policies` is a plain view - a second connection
 * would see the committed catalogue and report the mutation as having failed when in
 * fact it is simply not visible yet. MEASURED: `authenticated` reads the same catalogue
 * rows, with the same qual and with_check, as the owner - so reading as the
 * impersonated role loses nothing.
 *
 * WHY MOST MUTATIONS HERE LOOSEN A POLICY RATHER THAN DROP IT. Dropping a policy is the
 * blunt mutation: it makes the operation fail for EVERYONE, including the tenant that
 * owns the rows, so what a drop breaks is the positive control - it proves the policy
 * was needed, not that the refusal was. Loosening the predicate to `true` is the
 * mutation that isolates a REFUSAL: the row set is no longer filtered, the cross-tenant
 * statement lands, and the assertion that says it must not is demonstrated to be able to
 * fail. The SELECT drops in this suite are the plan's literal instruction, and they
 * break the assertion through the control that A can still see its own rows.
 *
 * WHY SOME MUTATIONS ALSO DISABLE A TRIGGER. The cross-tenant role grant is refused by
 * TWO independent layers - the RLS with-check and the `guard_role_org_scope` BEFORE
 * trigger, which fires before the with-check is even evaluated. Loosening the policy
 * alone leaves the trigger refusing, so the assertion would not move and the mutation
 * would prove nothing. Composing the policy mutation with a trigger disable in one
 * `withMutation` is the honest form: the break then shows the cross-tenant write
 * actually going through, and the restore re-proves BOTH layers.
 */
import { expect } from "vitest";

import type { DbSession } from "../integration/helpers/database";
import { beginSession } from "../integration/helpers/database";

/**
 * One row of `pg_policies`, enough to rebuild the policy exactly.
 *
 * The index signature is required by `DbSession.query`, whose generic is constrained to
 * `Record<string, unknown>` - a plain interface has no index signature and is rejected.
 */
export interface PolicyRow extends Record<string, unknown> {
  policyname: string;
  tablename: string;
  schemaname: string;
  cmd: string;
  permissive: string;
  roles: string;
  qual: string | null;
  with_check: string | null;
}

/** One mutation, the catalogue state it produced, and the assertion message it broke. */
export interface MutationRecord {
  label: string;
  cataloguedAs: string;
  brokeWith: string;
}

/** Every mutation applied, verified, and observed to break its assertion, in order. */
export const mutationReport: MutationRecord[] = [];

/** The composite unique key that stops one account holding two memberships in a tenant. */
const MEMBERSHIP_UNIQUE = "organization_memberships_organization_id_user_id_key";

export interface MutationHarness {
  /**
   * Apply the mutation, then PROVE from the catalogue that it applied. The `verify`
   * callback is expected to throw when it did not, which stops the loop at step 2
   * instead of reporting a test that cannot catch anything.
   */
  withMutation<T>(fn: () => Promise<T>, verify: () => Promise<void>): Promise<T>;
  /** Drop a policy, having first captured it for the restore. */
  dropPolicy(table: string, policyName: string): Promise<string>;
  /** Recreate a dropped policy from its captured catalogue row, and prove the round trip. */
  restorePolicy(name: string): Promise<void>;
  /**
   * Set every clause a policy has to a permissive expression, captured for restore.
   *
   * This is the mutation that isolates a refusal: the policy stops refusing and
   * whatever is left - a composite foreign key, a unique constraint, a trigger - is the
   * only thing still holding. `using` is set only where the policy HAS one, because an
   * INSERT policy may not carry a USING clause and Postgres rejects the statement; the
   * same applies to `with check` on a DELETE policy.
   */
  openPolicy(table: string, policyName: string): Promise<string>;
  /** Read the catalogue rows matching a table and policy, for the step-2 proof. */
  readPolicies(table: string, policyName?: string): Promise<PolicyRow[]>;
  /** Replace a public function with the definition given, captured for restore. */
  replaceFunction(name: string, definition: string): Promise<string>;
  /** Restore a replaced function from `pg_get_functiondef`, and prove it matches. */
  restoreFunction(name: string): Promise<void>;
  /** Disable a named trigger, captured for restore; the undo re-proves its state. */
  disableTrigger(table: string, triggerName: string): Promise<string>;
  /** Narrow `organization_memberships`' unique key to `user_id` alone, captured for restore. */
  narrowMembershipUniqueness(): Promise<string>;
  /**
   * The whole ordered loop in one call, so no mutation test can skip the restore.
   *
   * `apply` may return a short description of what it did, which is what the report
   * records as the catalogue action. `assertion` is the isolation assertion itself -
   * the same body the plain suite runs - and it MUST throw once the mutation is applied.
   * A mutation that applies, verifies, and leaves the assertion passing proves the
   * assertion nothing, and is a failure of the TEST rather than of the database.
   */
  mutationBreaks(
    label: string,
    apply: () => Promise<unknown>,
    verify: () => Promise<void>,
    assertion: () => Promise<void>,
  ): Promise<void>;
  /** Impersonate a principal the way PostgREST builds one from a JWT. */
  become(userId: string): Promise<void>;
  /** Back to the session user - the table owner. Staging and DDL only, never a measurement. */
  resetRole(): Promise<void>;
  /** The query runner for the transaction in flight, for bodies a test stages and measures. */
  readonly owned: DbSession;
  rollback(): Promise<void>;
}

/** Open a transaction that the file-level catalogue work runs within. */
export async function openHarness(): Promise<MutationHarness> {
  const session = await beginSession();
  return harnessFor(session);
}

/**
 * The harness, over a session it can swap.
 *
 * `active` is the session every method runs on. `mutationBreaks` replaces it with a
 * fresh transaction for the duration of one mutation and puts it back afterwards, which
 * is what bounds the AccessExclusiveLock window; `rollback` closes the outer one.
 * Because the swap is internal, the callers in `apply` and `assertion` keep writing
 * `harness.dropPolicy(...)` against a single object.
 */
function harnessFor(outer: DbSession): MutationHarness {
  let active = outer;

  /**
   * Undo closures, in the order they were applied, so a restore is exactly the inverse.
   *
   * THE STACK IS DRAINED TO A MARK, NOT TO ZERO: a mutation that pushes two undos (the
   * opened policy and the dropped foreign key) must pop exactly those two, and must not
   * disturb one a later mutation has already queued.
   */
  const undoStack: Array<() => Promise<void>> = [];

  const readPolicies = async (table: string, policyName?: string): Promise<PolicyRow[]> => {
    const rows = await active.query<PolicyRow>(
      `select policyname, tablename, schemaname, cmd, permissive, roles, qual, with_check
         from pg_catalog.pg_policies
        where tablename = $1 and schemaname = $2
          and ($3::text is null or policyname = $3)`,
      [bareName(table), schemaOf(table), policyName ?? null],
    );
    return rows;
  };

  const withMutation = async <T>(fn: () => Promise<T>, verify: () => Promise<void>): Promise<T> => {
    const applied = await fn();
    await verify();
    return applied;
  };

  const restorePolicy = async (name: string): Promise<void> => {
    const row = capturedPolicies.get(name);
    if (!row) {
      throw new Error(`cannot restore ${name}: it was never captured, so it cannot be proved`);
    }
    await active.query(`drop policy if exists "${name}" on ${qualified(row)}`);
    await recreatePolicy(active, row);

    // THE PROOF. The restored catalogue row must equal the captured one field for
    // field; anything less is a restore that silently changed the live policy set.
    // The table is passed as schema-qualified because `readPolicies` resolves a bare
    // name to the public schema - which reads the WRONG schema for storage.objects
    // and made the proof fail a restore that had worked.
    const after = await readPolicies(`${row.schemaname}.${row.tablename}`, name);
    expect(after, `restoring ${name} must leave exactly that one policy`).toEqual([row]);
  };

  const dropPolicy = async (table: string, policyName: string): Promise<string> => {
    const row = (await readPolicies(table, policyName))[0];
    if (!row) {
      throw new Error(`cannot drop ${policyName}: no such policy on ${table}`);
    }
    capturedPolicies.set(row.policyname, row);
    await active.query(`drop policy "${policyName}" on ${qualified(row)}`);
    undoStack.push(() => restorePolicy(policyName));
    return `dropped policy ${policyName} on ${qualified(row)}`;
  };

  const openPolicy = async (table: string, policyName: string): Promise<string> => {
    const row = (await readPolicies(table, policyName))[0];
    if (!row) {
      throw new Error(`cannot open ${policyName}: no such policy on ${table}`);
    }
    capturedPolicies.set(row.policyname, row);
    // An INSERT policy has no USING clause and Postgres rejects `alter policy ... using`
    // for one, so each clause is loosened only where the capture shows it exists.
    const using = row.qual === null ? "" : " using (true)";
    const withCheck = row.with_check === null ? "" : " with check (true)";
    await active.query(`alter policy "${policyName}" on ${qualified(row)}${using}${withCheck}`);
    undoStack.push(() => restorePolicy(policyName));
    return `loosened policy ${policyName} on ${qualified(row)} to${using || withCheck}`;
  };

  const replaceFunction = async (name: string, definition: string): Promise<string> => {
    const captured = await functionDefinition(active, name);
    capturedFunctions.set(name, captured);
    await active.query(definition);
    undoStack.push(() => restoreFunction(name));
    return `replaced public.${name}`;
  };

  const restoreFunction = async (name: string): Promise<void> => {
    const definition = capturedFunctions.get(name);
    if (!definition) {
      throw new Error(`cannot restore public.${name}: it was never captured`);
    }
    await active.query(definition);
    const after = await functionDefinition(active, name);
    expect(after, `restoring public.${name} must leave that definition`).toBe(definition);
  };

  const triggerEnabled = async (table: string, name: string): Promise<string> => {
    const rows = await active.query<{ tgenabled: string }>(
      `select t.tgenabled::text as tgenabled
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
        where c.relname = $1 and t.tgname = $2`,
      [bareName(table), name],
    );
    const state = rows[0]?.tgenabled;
    if (state === undefined) {
      throw new Error(`cannot find trigger ${name} on ${table}`);
    }
    return state;
  };

  const disableTrigger = async (table: string, name: string): Promise<string> => {
    const before = await triggerEnabled(table, name);
    const target = `${schemaOf(table)}.${bareName(table)}`;
    await active.query(`alter table ${target} disable trigger "${name}"`);
    const applied = await triggerEnabled(table, name);
    if (applied !== "D") {
      throw new Error(`disabling ${name} on ${table} did not apply (tgenabled ${applied})`);
    }
    undoStack.push(async () => {
      await active.query(`alter table ${target} enable trigger "${name}"`);
      const back = await triggerEnabled(table, name);
      expect(back, `re-enabling ${name} on ${table} must restore tgenabled`).toBe(before);
    });
    return `disabled trigger ${name} on ${target}`;
  };

  const narrowMembershipUniqueness = async (): Promise<string> => {
    const before = await constraintColumns(active, MEMBERSHIP_UNIQUE);
    if (before !== "organization_id,user_id") {
      throw new Error(
        `the membership unique key is "${before ?? "absent"}", not the expected pair - refusing to narrow an unknown constraint`,
      );
    }
    await active.query(
      `alter table public.organization_memberships
         drop constraint ${MEMBERSHIP_UNIQUE},
         add constraint ${MEMBERSHIP_UNIQUE} unique (user_id)`,
    );
    undoStack.push(async () => {
      await active.query(
        `alter table public.organization_memberships
           drop constraint ${MEMBERSHIP_UNIQUE},
           add constraint ${MEMBERSHIP_UNIQUE} unique (organization_id, user_id)`,
      );
      const restored = await constraintColumns(active, MEMBERSHIP_UNIQUE);
      expect(restored, "the membership unique key must be the pair again").toBe(
        "organization_id,user_id",
      );
    });
    return `narrowed ${MEMBERSHIP_UNIQUE} to (user_id)`;
  };

  /**
   * Back to the session user, which is the table OWNER and therefore bypasses RLS.
   * DDL and the restore need it; a measurement must never be taken in this state, which
   * is the trap this repository has already been bitten by once.
   */
  const resetRole = async (): Promise<void> => {
    await active.query("reset role");
  };

  /**
   * THE ORDERED LOOP, on a transaction of its own.
   *
   * The assertion runs inside a savepoint, so an assertion that FAILED expectedly AND a
   * statement that raised both leave the transaction usable for the restore - which is
   * the state `expectRejection` exists for, one level up.
   */
  const mutationBreaks = async (
    label: string,
    apply: () => Promise<unknown>,
    verify: () => Promise<void>,
    assertion: () => Promise<void>,
  ): Promise<void> => {
    const previous = active;
    const mark = undoStack.length;
    const session = await beginSession();
    active = session;
    try {
      // DDL and the restore both need the table owner, and a fresh connection has not
      // impersonated anybody - but this is also the state in which nothing may be
      // measured, so it is staging only.
      await resetRole();
      const applied = await withMutation(apply, verify);

      let brokeWith = "";
      await session.query("savepoint mutation_assertion");
      try {
        await assertion();
      } catch (error) {
        brokeWith = error instanceof Error ? error.message : String(error);
      }
      await session.query("rollback to savepoint mutation_assertion");

      // Step 4, on the path that runs whether or not step 3 threw - a failed assertion
      // is the OUTCOME this loop is looking for, so it must not skip the restore.
      await resetRole();
      while (undoStack.length > mark) {
        const undo = undoStack.pop();
        if (undo) await undo();
      }

      if (brokeWith === "") {
        throw new Error(
          `${label}: the mutation applied and verified, and the assertion still passed. ` +
            `The assertion cannot catch this, so it is evidence of nothing.`,
        );
      }

      // Step 5. If the restore did not work this fails here rather than leaking a
      // mutated policy into the next test, which is the one unrecoverable outcome.
      await session.query("savepoint mutation_restored");
      let restored = "";
      try {
        await assertion();
      } catch (error) {
        restored = error instanceof Error ? error.message : String(error);
      }
      await session.query("rollback to savepoint mutation_restored");
      if (restored !== "") {
        throw new Error(
          `${label}: after the restore the assertion failed again, so the restore changed ` +
            `the policy set: ${restored}`,
        );
      }

      mutationReport.push({ label, cataloguedAs: describeMutation(applied), brokeWith });
    } finally {
      // Everything the mutation did is discarded with the transaction, so the next
      // mutation starts from the shipped definition and a crash cannot leak one.
      active = previous;
      await session.rollback();
    }
  };

  return {
    withMutation,
    dropPolicy,
    restorePolicy,
    openPolicy,
    readPolicies,
    replaceFunction,
    restoreFunction,
    disableTrigger,
    narrowMembershipUniqueness,
    mutationBreaks,
    become: async (userId: string) => {
      await active.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await active.query("set local role authenticated");
    },
    resetRole,
    get owned(): DbSession {
      return active;
    },
    rollback: async () => {
      await outer.rollback();
    },
  };
}

/** Catalogue rows captured before each mutation, so a restore never re-reads a mutation. */
const capturedPolicies = new Map<string, PolicyRow>();

/** Function definitions captured before a replacement, so a restore is the original. */
const capturedFunctions = new Map<string, string>();

/**
 * Rebuild a policy from its captured catalogue row.
 *
 * `pg_policies.roles` arrives as the TEXT `{authenticated}`, because `pg` parses the
 * `name[]` as a string rather than an array; the braces are stripped and what is left
 * is used as a role list. MEASURED: this reconstructs the public policies such that the
 * catalogue is identical to the capture, field for field - and that identity is exactly
 * what the restore step asserts, so a policy this could not round-trip fails the
 * mutation rather than being silently wrong afterwards.
 */
async function recreatePolicy(session: DbSession, row: PolicyRow): Promise<void> {
  const command = row.cmd === "ALL" ? "all" : row.cmd.toLowerCase();
  const roles = row.roles
    .replace(/^\{|\}$/g, "")
    .split(",")
    .join(", ");
  const using = row.qual ? ` using (${row.qual})` : "";
  const withCheck = row.with_check ? ` with check (${row.with_check})` : "";
  await session.query(
    `create policy "${row.policyname}" on ${row.schemaname}.${row.tablename}
       as ${row.permissive} for ${command} to ${roles}${using}${withCheck}`,
  );
}

async function functionDefinition(session: DbSession, name: string): Promise<string> {
  const rows = await session.query<{ def: string }>(
    `select pg_get_functiondef(p.oid) as def
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
      order by p.oid`,
    [name],
  );
  const def = rows[0]?.def;
  if (def === undefined) {
    throw new Error(`public.${name} is not a function this project owns`);
  }
  return def;
}

async function constraintColumns(session: DbSession, name: string): Promise<string | null> {
  const rows = await session.query<{ cols: string }>(
    `select (select string_agg(a.attname, ',' order by a.attnum)
                from pg_catalog.pg_attribute a
               where a.attrelid = con.conrelid and a.attnum = any(con.conkey)) as cols
          from pg_catalog.pg_constraint con
          join pg_catalog.pg_class c on c.oid = con.conrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'organization_memberships'
           and con.conname = $1`,
    [name],
  );
  return rows[0]?.cols ?? null;
}

/** The table without its schema, for the `pg_policies.tablename` comparison. */
function bareName(table: string): string {
  return table.includes(".") ? table.split(".")[1]! : table;
}

function schemaOf(table: string): string {
  return table.includes(".") ? table.split(".")[0]! : "public";
}

/** A policy's schema-qualified table, taken from the row it was read with. */
function qualified(row: PolicyRow): string {
  return `${row.schemaname}.${row.tablename}`;
}

/** What the mutation looked like, for the report. */
function describeMutation(applied: unknown): string {
  if (applied === undefined || applied === null) return "applied";
  if (typeof applied === "string") return applied;
  return JSON.stringify(applied).slice(0, 120);
}

/** The report as text. Silence unless a caller asks for it. */
export function renderMutationReport(): string {
  return mutationReport
    .map((r) => `  ${r.label}\n    catalogue: ${r.cataloguedAs}\n    broke with: ${r.brokeWith}`)
    .join("\n");
}
