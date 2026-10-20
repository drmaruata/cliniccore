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
const { UnauthorizedError } = await import("../../lib/errors");

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

/** Clinics this file created, so cleanup removes exactly those. */
const createdClinicIds: string[] = [];

/**
 * Roles this file created, so cleanup removes exactly those. A role left holding a grant
 * is "in use", and private.guard_role_delete then refuses the organization's delete -
 * which is the defect this change records, biting the cleanup of the test that records it.
 */
const createdRoleIds: string[] = [];

/**
 * Permission keys this file created, so cleanup can remove exactly those. The
 * adversarial "Platform.tenants.read" row is one: it is a global permission, and leaving
 * it behind would put a platform key in the permissions table for every future test.
 */
const createdPermissionKeys: string[] = [];

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
  // The roles FIRST, and this is not tidiness.
  //
  // private.guard_role_delete refuses to delete a role that still holds grants or
  // assignments, and it fires on a CASCADE delete of the organization just the same - so
  // an organization that still has a role in use CANNOT be deleted. That is the defect this
  // change records, and it bites the cleanup of the test that records it: a single delete
  // statement covering every organization is ABORTED IN FULL if one of them still has an
  // in-use role, so all of them survive.
  for (const roleId of createdRoleIds) {
    await admin().from("user_role_assignments").delete().eq("role_id", roleId);
    await admin().from("role_permissions").delete().eq("role_id", roleId);
    await admin().from("roles").delete().eq("id", roleId);
  }
  for (const key of createdPermissionKeys) {
    await admin().from("role_permissions").delete().eq("permission_key", key);
    await admin().from("permissions").delete().eq("key", key);
  }

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
  // The CLASS and the CODE, not the message. A plain Error with the same text satisfied
  // the previous assertion, and the brief asks for the class specifically - Task 15/17
  // branch on it to decide between a sign-in prompt and a generic 500.
  await expect(activeOrg.requireActiveOrg()).rejects.toThrow(UnauthorizedError);
  await expect(activeOrg.requireActiveOrg()).rejects.toMatchObject({ code: "no_active_org" });
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

it("does not fall back when the cookie named a real org that died and exactly one remains", async () => {
  // THE ONE STATE THE FALLBACK CAN ACTUALLY FIRE IN, and the seventh ratchet this
  // repository has caught. MEASURED: both shipped dead-cookie tests left TWO memberships
  // behind, where the sole-survivor fallback branch cannot run - so replacing that branch
  // with "fall back to the only one left" kept the entire suite green. The shipped code is
  // right; only this test could see it.
  const doomed = await makeOrg(`lone-${Date.now()}`);
  await join(doomed);
  selectOrg(doomed);
  expect((await activeOrg.getActiveOrg())?.id).toBe(doomed);

  await admin()
    .from("organization_memberships")
    .delete()
    .eq("organization_id", doomed)
    .eq("user_id", userId);

  // orgA and orgB memberships still exist... temporarily remove orgA so exactly ONE
  // membership (orgB) remains, which is the state the fallback could fire in.
  await admin()
    .from("organization_memberships")
    .delete()
    .eq("organization_id", orgA)
    .eq("user_id", userId);

  const resolved = await activeOrg.getActiveOrg();
  expect(resolved).toBeNull();

  await join(orgA);
});

it("returns null for a SUSPENDED organization, however the cookie points at it", async () => {
  // The header claims "an organization that is suspended resolves to null". Nothing tested
  // it. MEASURED against the applied policies: this is carried entirely by RLS -
  // private.is_member requires organizations.status = 'active' - and the code has NO
  // status logic of its own. If the SELECT policy is ever "simplified" to
  // user_id = auth.uid(), this resolves to a suspended tenant with nothing failing loudly,
  // so the behaviour is pinned here.
  const suspended = await makeOrg(`susp-${Date.now()}`);
  await join(suspended);
  selectOrg(suspended);
  expect((await activeOrg.getActiveOrg())?.id).toBe(suspended);

  await admin().from("organizations").update({ status: "suspended" }).eq("id", suspended);
  // POSITIVE CONTROL: the suspension must have HAPPENED. Without this, a guard that
  // silently refused the update would leave the organization active and the assertion
  // below would fail for the wrong reason. MEASURED: private.guard_organization_status
  // refused the suspension when it ran as service_role, because service_role carries no
  // user JWT, and this test failed on the wrong assertion with no explanation.
  const check = await admin()
    .from("organizations")
    .select("status")
    .eq("id", suspended)
    .maybeSingle();
  expect(check.data?.status, "the organization must really be suspended").toBe("suspended");

  expect(await activeOrg.getActiveOrg()).toBeNull();
});

it("returns null for a REVOKED membership, not the organization it points at", async () => {
  // Same mechanism, other half: the membership row still EXISTS but is not active, so
  // the unique (organization_id, user_id) constraint makes it the user's only row for
  // that org - and RLS makes it invisible to them.
  const revoked = await makeOrg(`revoked-${Date.now()}`);
  await join(revoked);
  selectOrg(revoked);
  expect((await activeOrg.getActiveOrg())?.id).toBe(revoked);

  await admin()
    .from("organization_memberships")
    .update({ status: "revoked" })
    .eq("organization_id", revoked)
    .eq("user_id", userId);

  expect(await activeOrg.getActiveOrg()).toBeNull();
});

it("returns null with no cookie and several memberships, rather than picking one", async () => {
  clearOrg();
  expect(await activeOrg.getActiveOrg()).toBeNull();
});

it("returns null for a user with NO memberships at all", async () => {
  // The brief's "a user with no memberships gets null". It was true EMERGENTLY - the
  // empty-array case fell through two other branches - and MEASURED: removing the
  // `memberships.length === 0` guard changed nothing, so no test could see it. A
  // membership the user does not have is not a different code path; it is the same
  // answer, and it is worth stating.
  await admin().from("organization_memberships").delete().eq("user_id", userId);
  selectOrg(orgA);
  expect(await activeOrg.getActiveOrg()).toBeNull();
  await expect(activeOrg.requireActiveOrg()).rejects.toThrow(UnauthorizedError);

  await join(orgA);
  await join(orgB);
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
  await expect(activeOrg.requireActiveOrg()).rejects.toThrow(UnauthorizedError);
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

  it("marks the cookie Secure in production", async () => {
    // The plan says "secure in production", and the flag was never asserted - so
    // hard-coding `secure: false` left the suite green. Derived from NODE_ENV rather
    // than hard-coded, because a hard-coded true would stop the cookie being set at all
    // during local development over http://localhost.
    // NODE_ENV is typed read-only by Next's ambient types, hence the cast.
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      cookieWrites.length = 0;
      await activeOrg.setActiveOrg(orgA);
      const written = cookieWrites.find((c) => c.name === ACTIVE_ORG_COOKIE);
      expect(written?.secure, "a production session cookie must be Secure").toBe(true);
    } finally {
      env.NODE_ENV = previous;
    }
  });
});

describe("userCan", () => {
  // A POSITIVE CONTROL, added because the first version of this block was a ratchet.
  //
  // MEASURED: with the probe user holding NO roles, userCan returned false for everything
  // via the empty-assignment guard, never reaching the permission lookup at all - so
  // replacing that lookup with a hard-coded 'return true' left the suite green. A control
  // whose expected value is identical for a permitted and an unpermitted principal proves
  // nothing, and this one had exactly that shape.
  //
  // A SECOND reason this block was rebuilt: the fixture granted roles in exactly ONE
  // organization, so dropping the organization scoping from the assignment query was also
  // unobservable - the seventh ratchet this repository has caught. The probe user now holds
  // a DIFFERENT grant in a SECOND organization, and the two must never agree.
  let roleA = "";
  let roleB = "";
  const IN_A = "settings.manage";
  const IN_B = "patients.read";

  beforeAll(async () => {
    const mk = async (orgId: string, key: string, name: string, grant: string) => {
      const { data: role, error } = await admin()
        .from("roles")
        .insert({ key, name, organization_id: orgId })
        .select("id")
        .single();
      if (error) throw new Error(`roles insert: ${error.message}`);
      const g = await admin()
        .from("role_permissions")
        .insert({ role_id: role.id, permission_key: grant });
      if (g.error) throw new Error(`role_permissions insert: ${g.error.message}`);
      const a = await admin()
        .from("user_role_assignments")
        .insert({ organization_id: orgId, user_id: userId, role_id: role.id });
      if (a.error) throw new Error(`user_role_assignments insert: ${a.error.message}`);
      return role.id as string;
    };
    roleA = await mk(orgA, "active_org_probe_a", "Probe A", IN_A);

    // orgB is also a real membership (created in the outer beforeAll), so a role there is a
    // legitimate thing for this user to hold - and exactly what makes cross-org leakage in
    // the query observable.
    // A platform key attached to a TENANT role - the exact shape the review's F5
    // described. permissions is one global table with no scope column, so a tenant can
    // attach one to its own role, and the assignment policy constrains only
    // organization_id, not the role's own organization. private.can refuses such keys
    // server-side; the helper must refuse them too, and this row is what makes the
    // refusal observable instead of dead code.
    const platformGrant = await admin()
      .from("role_permissions")
      .insert({ role_id: roleA, permission_key: "platform.tenants.read" });
    if (platformGrant.error)
      throw new Error(`platform grant insert: ${platformGrant.error.message}`);

    roleB = await mk(orgB, "active_org_probe_b", "Probe B", IN_B);
  });

  afterAll(async () => {
    for (const roleId of [roleA, roleB].filter(Boolean)) {
      await admin().from("user_role_assignments").delete().eq("role_id", roleId);
      await admin().from("role_permissions").delete().eq("role_id", roleId);
      await admin().from("roles").delete().eq("id", roleId);
    }
  });

  it("reports the grant held in the organization being acted in", async () => {
    selectOrg(orgA);
    expect(await activeOrg.userCan(IN_A)).toBe(true);
  });

  it("scopes the answer to the active organization, never the user's other roles", async () => {
    // The assertion that makes the organization filter load-bearing. The user genuinely
    // holds IN_B - in orgB - so a query that forgot the organization scope would answer
    // true here, and the UI would render a control the database would refuse.
    selectOrg(orgA);
    expect(await activeOrg.userCan(IN_B)).toBe(false);
    selectOrg(orgB);
    expect(await activeOrg.userCan(IN_B)).toBe(true);
    expect(await activeOrg.userCan(IN_A)).toBe(false);
    selectOrg(orgA);
  });

  it("flips when the assignment is withdrawn", async () => {
    selectOrg(orgA);
    expect(await activeOrg.userCan(IN_A)).toBe(true);

    await admin().from("user_role_assignments").delete().eq("role_id", roleA);

    // The claim changed in the database; the answer must change with it. This is the
    // assertion a hard-coded return cannot survive.
    expect(await activeOrg.userCan(IN_A)).toBe(false);

    // RESTORED, deliberately. An earlier version deleted the assignment and left it
    // deleted, so the two tests after it ran with zero assignments and their 'false'
    // expectations were satisfied by the fixture rather than by the guard they name.
    const restore = await admin()
      .from("user_role_assignments")
      .insert({ organization_id: orgA, user_id: userId, role_id: roleA });
    if (restore.error) throw new Error(`restore: ${restore.error.message}`);
    expect(await activeOrg.userCan(IN_A)).toBe(true);
  });

  it("answers about a GRANT's scope, not the caller's access", async () => {
    // The parameter is named `assignmentClinicId` because that is what it asks: whether a
    // GRANT of this permission exists for that clinic. It does NOT ask whether the caller
    // can REACH that clinic - private.can does not consult private.clinic_ids, which is
    // the separate conjunct RLS adds to every clinic-scoped policy.
    //
    // MEASURED, and the reason the name matters: a user whose MEMBERSHIP is restricted to
    // one clinic, holding an ORG-WIDE grant, answers true for a clinic they cannot read.
    // The database still refuses them the rows; but a helper answering "may I access this
    // clinic's data" would be answering a different question, and a careless caller
    // `if (await userCan("patients.read", patient.clinic_id))` would disclose another
    // clinic's data to the UI.
    //
    // So a permission granted ONLY for one clinic answers true for that clinic, false
    // org-wide, and false for a clinic it was never granted for.
    const { data: clinic, error: clinicError } = await admin()
      .from("clinics")
      .insert({ organization_id: orgA, name: "Grant scope clinic", timezone: "Asia/Kolkata" })
      .select("id")
      .single();
    if (clinicError) throw new Error(`clinics insert: ${clinicError.message}`);
    const clinicId = clinic.id as string;
    createdClinicIds.push(clinicId);

    const { data: other, error: otherError } = await admin()
      .from("clinics")
      .insert({ organization_id: orgA, name: "Other clinic", timezone: "Asia/Kolkata" })
      .select("id")
      .single();
    if (otherError) throw new Error(`clinics insert: ${otherError.message}`);
    const otherClinicId = other.id as string;
    createdClinicIds.push(otherClinicId);

    const { data: role, error: roleError } = await admin()
      .from("roles")
      .insert({ key: "scoped_grant_role", name: "Scoped grant", organization_id: orgA })
      .select("id")
      .single();
    if (roleError) throw new Error(`roles insert: ${roleError.message}`);
    // Registered for cleanup: a role left holding a grant is "in use", and the role guard
    // then refuses the organization's delete - which is the very defect this change
    // records, biting the cleanup of the test that records it.
    createdRoleIds.push(role.id as string);
    const { error: grantError } = await admin()
      .from("role_permissions")
      .insert({ role_id: role.id, permission_key: "appointments.manage" });
    if (grantError) throw new Error(`role_permissions insert: ${grantError.message}`);
    const { error: assignError } = await admin()
      .from("user_role_assignments")
      .insert({ organization_id: orgA, user_id: userId, role_id: role.id, clinic_id: clinicId });
    if (assignError) throw new Error(`user_role_assignments insert: ${assignError.message}`);

    selectOrg(orgA);
    // The grant's own clinic: true.
    expect(await activeOrg.userCan("appointments.manage", clinicId)).toBe(true);
    // The organization-wide question: false - the grant is not org-wide.
    expect(await activeOrg.userCan("appointments.manage")).toBe(false);
    // A clinic the grant was never given for: false.
    expect(await activeOrg.userCan("appointments.manage", otherClinicId)).toBe(false);
  });

  it("never reports a platform-scoped permission, even one the database really grants", async () => {
    // MEASURED, twice. The first version of this test asserted userCan("platform.*") is
    // false while the fixture held NO platform grants, so the answer was false with or
    // without the refusal - a control whose expected value is identical for a permitted
    // and an unpermitted principal, the sixth time this repository has caught exactly
    // that shape. The fixture now REALLY grants platform.tenants.read to the probe user's
    // tenant role, so the refusal is the only thing standing between the database and a
    // "true" that would render a control the database would refuse.
    //
    // Prove the fixture first, so the assertion below cannot pass vacuously.
    const held = await admin()
      .from("role_permissions")
      .select("permission_key")
      .eq("role_id", roleA);
    expect(held.data?.map((r) => r.permission_key)).toContain("platform.tenants.read");

    selectOrg(orgA);
    expect(await activeOrg.userCan("platform.tenants.read")).toBe(false);
    expect(await activeOrg.userCan("platform.tenants.manage")).toBe(false);
    // The CASE variant. private.can compares `lower(p_permission)`, and PermissionKey is
    // an open template type, so "Platform.tenants.read" is type-valid and a
    // case-sensitive check here would let it through.
    //
    // The fixture creates the ADVERSARIAL row - a permission key spelled with a capital
    // P - because a case-sensitive check would otherwise find nothing to match and
    // return false for the wrong reason. The lowercase grant alone cannot tell the two
    // implementations apart, which is why this test needed a real trap to be
    // discriminating.
    const { error: permError } = await admin()
      .from("permissions")
      .insert({ key: "Platform.tenants.read", description: "Adversarial case variant" });
    if (permError) throw new Error(`permissions insert: ${permError.message}`);
    const { error: grantError } = await admin()
      .from("role_permissions")
      .insert({ role_id: roleA, permission_key: "Platform.tenants.read" });
    if (grantError) throw new Error(`role_permissions insert: ${grantError.message}`);
    createdPermissionKeys.push("Platform.tenants.read");

    expect(await activeOrg.userCan("Platform.tenants.read")).toBe(false);

    // And the trap really was armed: remove the refusal and this WOULD answer true.
    const heldVariant = await admin()
      .from("role_permissions")
      .select("permission_key")
      .eq("role_id", roleA)
      .eq("permission_key", "Platform.tenants.read");
    expect(heldVariant.data?.length ?? 0).toBe(1);
    expect(await activeOrg.userCan("Platform.tenants.read")).toBe(false);
    expect(await activeOrg.userCan("PLATFORM.TENANTS.READ")).toBe(false);
  });

  it("is false with no active organization", async () => {
    clearOrg();
    expect(await activeOrg.userCan(IN_A)).toBe(false);
    selectOrg(orgA);
  });
});
