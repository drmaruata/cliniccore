// @vitest-environment node
/*
 * Active-organization resolution.
 *
 * THE INVARIANT UNDER TEST: `getActiveOrg` NEVER trusts the cookie. The cookie is a hint
 * about which org the user last chose; the database decides whether that is still true. A
 * user removed from an organization, or an org suspended, must resolve to `null` rather
 * than to whatever the cookie still claims - which is the difference between "you were
 * removed" and "you are still working in a clinic you left".
 *
 * WHY THE FIXTURE WRITES MEMBERSHIPS THROUGH THE SERVICE ROLE. Task 9 closed INSERT and
 * DELETE on `organization_memberships` by policy, precisely so a signed-in caller cannot
 * enrol itself. Test setup is not that case, and going through service_role exercises the
 * policies honestly: every READ below is made by the real signed-in user, under real RLS.
 *
 * WHY THE FALLBACK IS NARROW. With no cookie at all, a user who belongs to exactly one org
 * resolves to it - unambiguous, and it means a fresh login lands somewhere useful. With two
 * or more, there is no correct answer and it is `null`. But a cookie that was present and no
 * longer resolves NEVER falls back: the user chose, the choice died, and silently moving
 * them to a different clinic would be worse than asking.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  admin,
  createdProbeUserIds,
  createProbeSession,
  deleteProbeUsers,
} from "../helpers/auth-session-fixture";

type Entry = { name: string; value: string } & Record<string, unknown>;

const jar = new Map<string, Entry>();
const cookieWrites: Entry[] = [];

/** What a mocked `cookieStore.set` records, so cookie ATTRIBUTES can be asserted. */
vi.doMock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.values()],
    get: (name: string) => jar.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      const entry = { name, value, ...options };
      cookieWrites.push(entry);
      jar.set(name, entry);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  // Assigning `process.env.X` to itself is not a no-op when X is undefined: Node coerces
  // it to the STRING "undefined", which the auth server rejects as an invalid API key. The
  // symptom is a client that looks configured but authenticates nobody - and because
  // getActiveOrg returns null when there is no user, that presented as "signed out" rather
  // than as a configuration fault. Cost real time; do not repeat it.
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
});

const activeOrg = await import("../../lib/auth/active-org");
const { ACTIVE_ORG_COOKIE } = await import("../../lib/auth/session");

let userId = "";
let authCookie = "";
let orgA = "";
let orgB = "";

/**
 * Every organization this file creates, so cleanup can be exhaustive without being a
 * SWEEP.
 *
 * MEASURED: cleanup that removed rows matching a sentinel - rather than ids this file
 * created - took the seeded platform_super_admin role with it, and nothing failed loudly,
 * because every test that mentions the role asserts it is ABSENT from organization-scoped
 * reads, which trivially passes when the row is missing. A cleanup that can delete state it
 * did not create will eventually delete state it should not, and a seeded row nothing
 * requires to exist disappears silently.
 */
const createdOrgIds: string[] = [];

async function makeOrg(slug: string): Promise<string> {
  const { data, error } = await admin()
    .from("organizations")
    .insert({
      name: `Clinic ${slug}`,
      slug,
      timezone: "Asia/Kolkata",
      currency: "INR",
      locale: "en-IN",
    })
    .select("id")
    .single();
  if (error) throw error;
  createdOrgIds.push(data.id as string);
  return data.id as string;
}

async function join(orgId: string): Promise<void> {
  const { error } = await admin()
    .from("organization_memberships")
    .insert({ organization_id: orgId, user_id: userId, status: "active" });
  if (error) throw error;
}

beforeAll(async () => {
  const probe = await createProbeSession();
  userId = probe.userId;
  authCookie = probe.cookie;
  orgA = await makeOrg(`alpha-${Date.now()}`);
  orgB = await makeOrg(`beta-${Date.now()}`);
  await join(orgA);
  await join(orgB);

  jar.clear();
  setAuth(authCookie);
});

afterAll(async () => {
  // Children before parents, or the delete is refused by its own foreign keys. Scoped to
  // the ids this file created - never a sweep.
  if (createdOrgIds.length > 0) {
    await admin().from("organization_memberships").delete().in("organization_id", createdOrgIds);
    await admin().from("user_role_assignments").delete().in("organization_id", createdOrgIds);
    await admin().from("organizations").delete().in("id", createdOrgIds);
  }

  // Prove it, rather than trusting it - and prove it only about what this file created.
  const { data: leftover } = await admin()
    .from("organizations")
    .select("id")
    .in("id", createdOrgIds);
  expect(leftover ?? []).toEqual([]);
  expect(await deleteProbeUsers(createdProbeUserIds)).toEqual([]);
});

const AUTH_COOKIE = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
const setAuth = (value: string) => jar.set(AUTH_COOKIE, { name: AUTH_COOKIE, value });

/**
 * Every test starts from the same signed-in session with no organization chosen, and
 * states its own preconditions.
 *
 * MEASURED, and this was the fifth time this repository has been bitten by ordering: the
 * signed-out test emptied the auth cookie without restoring it, so every later test ran
 * signed out. The userCan assertions still PASSED in isolation and FAILED in a full-file
 * run - which is the worst shape a test failure can have, because running the file alone
 * appears to clear it.
 */
beforeEach(() => {
  jar.clear();
  setAuth(authCookie);
});

const selectOrg = (orgId: string) => {
  jar.set(ACTIVE_ORG_COOKIE, { name: ACTIVE_ORG_COOKIE, value: orgId });
};
const clearOrg = () => {
  jar.delete(ACTIVE_ORG_COOKIE);
};

it("resolves the organization the cookie names, when the membership is real", async () => {
  selectOrg(orgB);
  const org = await activeOrg.getActiveOrg();
  expect(org?.id).toBe(orgB);
});

it("does NOT resolve an organization the cookie names once the membership is gone", async () => {
  // THE CASE THE BRIEF IS ABOUT. The cookie still says B; the membership does not exist.
  // Returning B would show a clinician the records of a clinic they were removed from.
  const doomed = await makeOrg(`doomed-${Date.now()}`);
  await join(doomed);
  selectOrg(doomed);
  expect((await activeOrg.getActiveOrg())?.id).toBe(doomed);

  await admin()
    .from("organization_memberships")
    .delete()
    .eq("organization_id", doomed)
    .eq("user_id", userId);

  expect(await activeOrg.getActiveOrg()).toBeNull();
  await expect(activeOrg.requireActiveOrg()).rejects.toThrow("No active organization");
});

it("never falls back to another organization when the cookie named a real one that died", async () => {
  // The user belongs to A and B. The cookie says B; B is removed. Falling back to A would
  // silently move them into a different clinic - which is worse than asking.
  const second = await makeOrg(`second-${Date.now()}`);
  await join(second);
  selectOrg(second);
  expect((await activeOrg.getActiveOrg())?.id).toBe(second);

  await admin()
    .from("organization_memberships")
    .delete()
    .eq("organization_id", second)
    .eq("user_id", userId);

  // A is still a membership, and it is still not what we return.
  expect(await activeOrg.getActiveOrg()).toBeNull();
});

it("falls back to the sole membership only when there is no cookie at all", async () => {
  const solo = await makeOrg(`solo-${Date.now()}`);
  await admin().from("organization_memberships").delete().eq("user_id", userId); // leave only `solo`
  await join(solo);

  clearOrg();
  expect((await activeOrg.getActiveOrg())?.id).toBe(solo);

  await join(orgA);
  await join(orgB);
  await admin().from("organization_memberships").delete().eq("organization_id", solo);
});

it("returns null with no cookie and several memberships, rather than picking one", async () => {
  clearOrg();
  expect(await activeOrg.getActiveOrg()).toBeNull();
});

it("returns null for a cookie naming an organization the user was never in", async () => {
  const stranger = await makeOrg(`stranger-${Date.now()}`);
  selectOrg(stranger);
  expect(await activeOrg.getActiveOrg()).toBeNull();
});

it("returns null when signed out", async () => {
  setAuth("");
  selectOrg(orgA);
  expect(await activeOrg.getActiveOrg()).toBeNull();
  await expect(activeOrg.requireActiveOrg()).rejects.toThrow();
});

describe("setActiveOrg", () => {
  it("writes an http-only, same-site cookie scoped to the whole site", async () => {
    cookieWrites.length = 0;
    await activeOrg.setActiveOrg(orgA);

    const written = cookieWrites.find((c) => c.name === ACTIVE_ORG_COOKIE);
    expect(written, "the cookie must actually be written").toBeDefined();
    expect(written?.value).toBe(orgA);
    // A JavaScript-readable cookie would let any XSS on the page choose the tenant, which
    // is the one thing the http-only flag is for.
    expect(written?.httpOnly).toBe(true);
    expect(written?.sameSite).toBe("lax");
    expect(written?.path).toBe("/");
    expect(
      written?.maxAge,
      "a session cookie that dies on browser close is the wrong default",
    ).toBeGreaterThan(0);
  });
});

describe("userCan", () => {
  // A POSITIVE CONTROL, added because the first version of this block was a ratchet.
  //
  // MEASURED: with the probe user holding NO roles, `userCan` returned false for
  // everything via the `roleIds.length === 0` guard, never reaching the permission lookup
  // at all - so replacing that lookup with a hard-coded `return true` left the suite green.
  // A control whose expected value is identical for a permitted and an unpermitted
  // principal proves nothing, and this one had exactly that shape.
  //
  // The fix gives the user a real org-scoped role with a real grant, and asserts the answer
  // MOVES when the grant is removed. A tenant role is created here because the database
  // seeds only the platform role globally - tenant roles are created per organization by
  // onboarding - so the fixture has to create one to have anything to grant.
  let roleId = "";
  const GRANTED = "settings.manage";
  const NOT_GRANTED = "patients.export";

  beforeAll(async () => {
    const { data: role, error } = await admin()
      .from("roles")
      .insert({ key: "active_org_probe", name: "Active org probe", organization_id: orgA })
      .select("id")
      .single();
    if (error) throw error;
    roleId = role.id as string;

    const grant = await admin()
      .from("role_permissions")
      .insert({ role_id: roleId, permission_key: GRANTED });
    if (grant.error) throw new Error(`role_permissions insert: ${grant.error.message}`);
    const assign = await admin()
      .from("user_role_assignments")
      .insert({ organization_id: orgA, user_id: userId, role_id: roleId });
    if (assign.error) throw new Error(`user_role_assignments insert: ${assign.error.message}`);
  });

  afterAll(async () => {
    await admin().from("user_role_assignments").delete().eq("role_id", roleId);
    await admin().from("role_permissions").delete().eq("role_id", roleId);
    await admin().from("roles").delete().eq("id", roleId);
  });

  it("reports a permission the database actually grants", async () => {
    selectOrg(orgA);
    expect(await activeOrg.userCan(GRANTED)).toBe(true);
  });

  it("reports a permission this role does not hold", async () => {
    selectOrg(orgA);
    // Same user, same organization, same role - so the only difference from the case above
    // is the permission. Without both, the test could not tell "reads the grants" from
    // "answers something plausible".
    expect(await activeOrg.userCan(NOT_GRANTED)).toBe(false);
  });

  it("flips when the assignment is withdrawn", async () => {
    selectOrg(orgA);
    expect(await activeOrg.userCan(GRANTED)).toBe(true);

    await admin().from("user_role_assignments").delete().eq("role_id", roleId);

    // The claim changed in the database; the answer must change with it. This is the
    // assertion a hard-coded return cannot survive.
    expect(await activeOrg.userCan(GRANTED)).toBe(false);
  });

  it("never reports a platform-scoped permission to a tenant member", async () => {
    // private.can refuses any key beginning `platform.`, because permissions is one global
    // table and a tenant could otherwise attach one to its own role. A client-side helper
    // that skipped that rule would offer an admin a control the database will refuse.
    selectOrg(orgA);
    expect(await activeOrg.userCan("platform.tenants.manage")).toBe(false);
  });

  it("is false with no active organization", async () => {
    clearOrg();
    expect(await activeOrg.userCan(GRANTED)).toBe(false);
    selectOrg(orgA);
  });
});
