// @vitest-environment node
/*
 * The public RPC surface: the browser's only door into the authorization primitives.
 *
 * WHY THIS FILE EXISTS. The plan carried a note that was explicitly UNRESOLVED and had to be
 * settled before Task 12: whether PostgREST exposes the `private` schema could not be
 * measured, and "if that default holds, none of these functions is callable from the browser
 * and Task 12 needs `public` wrappers". The default holds - measured twice, and
 * `types/database.types.ts` recorded the consequence as `Functions: { [_ in never]: never }`.
 *
 * So a signed-in browser could not ask the database whether it held a permission, could not
 * create its own organization, and could not write an audit row. The permission rule had to
 * be reimplemented in TypeScript on the client, which is how it came to exist twice and how
 * it drifted once already.
 *
 * WHY THE HTTP HALF MATTERS MOST. Every other assertion in this file could be satisfied by
 * a function that exists but is not actually REACHABLE from a browser - and that was
 * exactly the bug being fixed, for seven tasks. So the decisive assertions go over real
 * HTTPS to PostgREST, with the publishable key and a real signed-in user's JWT, because
 * that is the only path a browser has. A `pg` connection is not the product.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { envValue } from "./helpers/database";

const SUPABASE_URL = envValue("NEXT_PUBLIC_SUPABASE_URL") ?? "";
const PUBLISHABLE_KEY = envValue("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ?? "";

import {
  admin,
  createdProbeUserIds,
  createProbeSession,
  decodeCookie,
} from "../helpers/auth-session-fixture";

let userId = "";
let accessToken = "";
let orgId = "";
const createdOrgIds: string[] = [];

/**
 * The adversarial rows this file creates, so cleanup removes exactly those. A blanket
 * delete by key or by permission would strip other organizations' grants - which an
 * earlier version of this file's cleanup did, and which would have been a data-loss bug
 * in the test suite.
 */
const createdPermissionKeys: string[] = [];
const createdRoleIds: string[] = [];

const rpc = async (
  fn: string,
  body: unknown,
  token: string | null = accessToken,
): Promise<{ status: number; text: string }> => {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
};

beforeAll(async () => {
  const probe = await createProbeSession();
  userId = probe.userId;
  accessToken = String(decodeCookie(probe.cookie).access_token ?? "");

  const client = admin();
  const { data: org, error: orgError } = await client
    .from("organizations")
    .insert({ name: "Public RPC probe", slug: `rpc-probe-${Date.now()}`, timezone: "Asia/Kolkata" })
    .select("id")
    .single();
  if (orgError) throw orgError;
  orgId = org.id as string;
  createdOrgIds.push(orgId);

  const { error: clinicError } = await client
    .from("clinics")
    .insert({ organization_id: orgId, name: "Probe clinic", timezone: "Asia/Kolkata" })
    .select("id")
    .single();
  if (clinicError) throw clinicError;

  const { error: membershipError } = await client
    .from("organization_memberships")
    .insert({ organization_id: orgId, user_id: userId, status: "active" });
  if (membershipError) throw membershipError;

  // A role the probe user holds, so `can` has something true to say.
  const { data: role, error: roleError } = await client
    .from("roles")
    .insert({ key: "rpc_probe_role", name: "RPC probe", organization_id: orgId })
    .select("id")
    .single();
  if (roleError) throw roleError;
  await client
    .from("role_permissions")
    .insert({ role_id: role.id, permission_key: "patients.read" })
    .select();
  await client
    .from("role_permissions")
    .insert({ role_id: role.id, permission_key: "settings.manage" });
  await client
    .from("user_role_assignments")
    .insert({ organization_id: orgId, user_id: userId, role_id: role.id });
});

afterAll(async () => {
  const client = admin();

  // audit_logs DELIBERATELY carry no foreign keys - so that a deleted tenant or actor
  // cannot erase the trail - which means the rows this test writes have to be removed by
  // hand, and the fact that they can be is itself the point.
  await client.from("audit_logs").delete().eq("action", "rpc_probe");

  // The adversarial rows this file created, and ONLY those. A blanket delete by key or by
  // permission would strip other organizations' grants - which an earlier version of this
  // cleanup did, and which would have been a data-loss bug in the test suite.
  for (const id of createdRoleIds) {
    await client.from("user_role_assignments").delete().eq("role_id", id);
    await client.from("role_permissions").delete().eq("role_id", id);
    await client.from("roles").delete().eq("id", id);
  }
  for (const key of createdPermissionKeys) {
    await client.from("role_permissions").delete().eq("permission_key", key);
    await client.from("permissions").delete().eq("key", key);
  }

  if (createdOrgIds.length > 0) {
    // The roles have to be UNUSED before the organization can go, because
    // private.guard_role_delete refuses to delete a role that still has grants or
    // assignments - and it fires on a CASCADE delete of the organization just the same.
    //
    // MEASURED: deleting the organization directly fails with "role rpc_probe_role is
    // still in use". That is a real finding about the schema and not about this test - an
    // organization that has roles CANNOT be deleted, because the cascade hits the same
    // guard a deliberate role deletion hits. Recorded in docs/IMPLEMENTATION_STATUS.md as
    // an open item for whoever builds tenant offboarding; worked around here by removing
    // the roles first, which is what the guard is asking for.
    const { data: orgRoles } = await client
      .from("roles")
      .select("id")
      .in("organization_id", createdOrgIds);
    const roleIds = (orgRoles ?? []).map((role) => role.id as string);

    if (roleIds.length > 0) {
      await client.from("user_role_assignments").delete().in("role_id", roleIds);
      await client.from("role_permissions").delete().in("role_id", roleIds);
      const { error: roleError } = await client.from("roles").delete().in("id", roleIds);
      if (roleError) throw new Error(`role cleanup failed: ${roleError.message}`);
    }

    // Everything under organizations CASCADES, so deleting the organization is enough
    // once its roles are out of the way.
    //
    // The earlier version of this cleanup ALSO deleted `role_permissions` by
    // permission_key - a BLANKET delete that would have stripped every OTHER
    // organization's grant of patients.read. It was unnecessary as well as destructive, and
    // it is worth naming because a test cleanup that can delete rows it did not create
    // will eventually do so.
    const { error } = await client.from("organizations").delete().in("id", createdOrgIds);
    if (error) throw new Error(`organization cleanup failed: ${error.message}`);
  }
  const { data: leftover } = await client
    .from("organizations")
    .select("id")
    .in("id", createdOrgIds);
  expect(leftover ?? []).toEqual([]);
  for (const id of createdProbeUserIds) {
    const { error } = await client.auth.admin.deleteUser(id);
    if (error) throw new Error(`cleanup failed for ${id}: ${error.message}`);
  }
});

describe("the browser can reach the authorization rule", () => {
  it("calls public.can over PostgREST and gets the database's answer", async () => {
    const response = await rpc("can", { p_org_id: orgId, p_permission: "patients.read" });
    expect(response.status).toBe(200);
    expect(response.text).toBe("true");
  });

  it("says no for a permission the user does not hold", async () => {
    const response = await rpc("can", { p_org_id: orgId, p_permission: "billing.manage" });
    expect(response.status).toBe(200);
    expect(response.text).toBe("false");
  });

  // The ARMING lives in a beforeAll, not in an `it`. That is the whole point:
  // MEASURED, with the arming inside a test, removing that test left the suite green -
  // the control had quietly become vacuous again, because the test both CREATED the
  // grant and ASSERTED it, so deleting the test deleted the check along with the setup.
  // A beforeAll cannot be removed by removing a test, so a test that asserts the arming
  // is present now actually holds the refusal below to account.
  //
  // NOTE: "platform.tenants.read" is already one of the twenty-one seeded permissions,
  // so the row exists and must NOT be inserted - and must not be deleted on cleanup
  // either, or the next run would find a missing permission.
  beforeAll(async () => {
    const { error: permError } = await admin()
      .from("permissions")
      .upsert({ key: "platform.tenants.read", description: "Adversarial platform key" });
    if (permError) throw new Error(`permissions upsert: ${permError.message}`);

    const { data: platformRole, error: platformRoleError } = await admin()
      .from("roles")
      .insert({ key: "rpc_probe_platform", name: "RPC platform probe", organization_id: orgId })
      .select("id")
      .single();
    if (platformRoleError) throw new Error(`roles insert: ${platformRoleError.message}`);
    createdRoleIds.push(platformRole.id as string);

    const { error: grantError } = await admin()
      .from("role_permissions")
      .insert({ role_id: platformRole.id, permission_key: "platform.tenants.read" });
    if (grantError) throw new Error(`role_permissions insert: ${grantError.message}`);
    const { error: assignError } = await admin()
      .from("user_role_assignments")
      .insert({ organization_id: orgId, user_id: userId, role_id: platformRole.id });
    if (assignError) throw new Error(`user_role_assignments insert: ${assignError.message}`);
  });

  it("the fixture REALLY holds a platform key, so the refusal is the rule and not the absence of a grant", async () => {
    // The arming, asserted. Without this the refusal below is satisfied by a user who
    // simply holds no platform key - a control whose expected value is identical for a
    // permitted and an unpermitted principal, which is the standing failure in this
    // repository.
    const { data: platformRole } = await admin()
      .from("roles")
      .select("id")
      .eq("key", "rpc_probe_platform")
      .eq("organization_id", orgId)
      .maybeSingle();
    const held = platformRole
      ? await admin()
          .from("role_permissions")
          .select("permission_key")
          .eq("role_id", platformRole.id)
      : { data: [] };
    expect(held.data?.map((r) => r.permission_key)).toContain("platform.tenants.read");
  });

  it("refuses a platform-scoped key, in any case, EVEN WHEN THE ROLE REALLY HOLDS ONE", async () => {
    // private.can compares lower(p_permission), so the public wrapper must too - or the
    // rule drifts again the moment it is exposed a second way. The arming is the test
    // above, and it comes first on purpose.
    for (const permission of [
      "platform.tenants.read",
      "Platform.tenants.read",
      "PLATFORM.TENANTS.READ",
    ]) {
      const response = await rpc("can", { p_org_id: orgId, p_permission: permission });
      expect(response.text, permission).toBe("false");
    }
  });

  it("says no for an organization the user does not belong to", async () => {
    const { data: stranger } = await admin()
      .from("organizations")
      .insert({ name: "Stranger", slug: `stranger-${Date.now()}`, timezone: "UTC" })
      .select("id")
      .single();
    createdOrgIds.push(stranger?.id as string);
    const response = await rpc("can", { p_org_id: stranger?.id, p_permission: "patients.read" });
    expect(response.text).toBe("false");
  });

  it("is refused to an anonymous caller", async () => {
    const response = await rpc("can", { p_org_id: orgId, p_permission: "patients.read" }, null);
    // Either refused outright, or answered false because there is no caller. Both are
    // correct; what is NOT correct is a 200 with `true`.
    if (response.status === 200) expect(response.text).toBe("false");
    else expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the browser can onboard", () => {
  it("creates an organization with the calling user as owner", async () => {
    const slug = `onboard-${Date.now()}`;
    const response = await rpc("create_organization_with_owner", {
      p_name: "Onboarded clinic",
      p_slug: slug,
      p_clinic_name: "Main clinic",
      p_timezone: "Asia/Kolkata",
    });
    expect(response.status, response.text).toBe(200);
    const newOrgId = response.text.replace(/"/g, "");
    createdOrgIds.push(newOrgId);

    const { data: membership } = await admin()
      .from("organization_memberships")
      .select("user_id, status")
      .eq("organization_id", newOrgId);
    expect(membership?.length).toBe(1);
    expect(membership?.[0]?.user_id).toBe(userId);
    expect(membership?.[0]?.status).toBe("active");

    const { data: roles } = await admin()
      .from("roles")
      .select("key")
      .eq("organization_id", newOrgId);
    expect(roles?.map((r) => r.key)).toContain("organization_owner");
  });

  it("refuses a slug that would break routing, and lengths that would break the table", async () => {
    // The application's own schema says the slug "is the tenant key used in URLs, so it
    // is constrained to lowercase kebab-case rather than left free - a slug containing a
    // slash or an uppercase letter breaks routing later, far from here." That comment was
    // true only while the CLIENT was the only way in. MEASURED against the public RPC
    // before the fix: a slug of 'a/b/../1792483964879' was accepted and stored VERBATIM,
    // a 2 000 000-character name was accepted, and an unknown time zone was accepted - and
    // an unknown zone makes Intl.DateTimeFormat THROW, so it would break clinicDayBounds
    // inside billing-window code.
    const bad = [
      { label: "a path separator in the slug", slug: `a/b/${Date.now()}` },
      { label: "an uppercase slug", slug: `Northside-${Date.now()}` },
      { label: "an underscore in the slug", slug: `north_side_${Date.now()}` },
      { label: "a two-character slug", slug: "ab" },
      { label: "a 100 000-character slug", slug: "a".repeat(100000) },
    ];
    for (const item of bad) {
      const response = await rpc("create_organization_with_owner", {
        p_name: "Should not exist",
        p_slug: item.slug,
        p_clinic_name: "Clinic",
        p_timezone: "Asia/Kolkata",
      });
      expect(response.status, item.label).toBeGreaterThanOrEqual(400);
    }

    for (const item of [
      { label: "an unknown time zone", p_timezone: "Not/AZone" },
      { label: "a two-million-character name", p_name: "x".repeat(2000000) },
      { label: "a two-million-character clinic name", p_clinic_name: "x".repeat(2000000) },
    ]) {
      const response = await rpc("create_organization_with_owner", {
        p_name: item.p_name ?? "Clinic",
        p_slug: `ok-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        p_clinic_name: item.p_clinic_name ?? "Clinic",
        p_timezone: item.p_timezone ?? "Asia/Kolkata",
      });
      expect(response.status, item.label).toBeGreaterThanOrEqual(400);
    }
  });

  it("is refused to an anonymous caller", async () => {
    const response = await rpc(
      "create_organization_with_owner",
      {
        p_name: "Should not exist",
        p_slug: `nope-${Date.now()}`,
        p_clinic_name: "Clinic",
        p_timezone: "UTC",
      },
      null,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the SETTINGS path validates too, not only the create path", () => {
  // 01630 validated the time zone only in the CREATE wrapper, and the review found the
  // gap by MEASUREMENT: a settings UPDATE accepted anything.
  //
  //   PATCH /rest/v1/organizations?id=eq.<org>  {"timezone":"Not/AZone"}  ->  200, stored
  //
  // A CHECK constraint cannot close it - the zone list is a view, and a check may not call
  // a function that reads a table - so 01640 adds a TRIGGER, which fires on every write
  // path. The consequence of leaving it open was concrete: clinicDayBounds and
  // formatInClinicTz THROW on an unknown zone, inside billing-window code.
  it("refuses an unknown time zone on an update", async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/organizations?id=eq.${orgId}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ timezone: "Not/AZone" }),
    });
    expect(response.status, await response.text()).toBeGreaterThanOrEqual(400);
  });

  it("refuses a time zone ICU does not know, on an update", async () => {
    // MEASURED over the full zone list: of the 598 names in pg_timezone_names, ICU accepts
    // 597 and rejects exactly one - 'Factory', PostgreSQL's own placeholder for a machine
    // with no configured zone. So "the database knows the name" is NOT the same as "the
    // application can use it".
    const response = await fetch(`${SUPABASE_URL}/rest/v1/organizations?id=eq.${orgId}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ timezone: "Factory" }),
    });
    expect(response.status, await response.text()).toBeGreaterThanOrEqual(400);
  });

  it("refuses a zone abbreviation, which is ambiguous for a billing day", async () => {
    // 'CST' is Central or China Standard; 'IST' is India or Israel. A clinic whose BILLING
    // DAY is computed in that zone cannot afford an abbreviation, and a legacy alias
    // ('Cuba', 'Zulu', 'Universal') is no better.
    const response = await fetch(`${SUPABASE_URL}/rest/v1/organizations?id=eq.${orgId}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ timezone: "CST" }),
    });
    expect(response.status, await response.text()).toBeGreaterThanOrEqual(400);
  });

  it("POSITIVE CONTROL: accepts a valid update, so the refusals above are the guard and not RLS", async () => {
    // Without this, every refusal above would also be satisfied by an RLS policy that
    // refuses all updates - which is exactly the vacuous control this repository keeps
    // catching.
    const response = await fetch(`${SUPABASE_URL}/rest/v1/organizations?id=eq.${orgId}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ timezone: "Asia/Kolkata" }),
    });
    expect(response.status, await response.text()).toBe(204);
  });

  it("refuses a hostile slug even for service_role, because the constraint is on the table", async () => {
    // The constraint, not the wrapper. A service_role insert is not the browser's path, and
    // it is the path a careless migration or script would take.
    const { error } = await admin()
      .from("organizations")
      .insert({ name: "Hostile", slug: `a/b/${Date.now()}`, timezone: "Asia/Kolkata" });
    expect(error, "the table constraint must refuse a hostile slug whoever writes it").toBeTruthy();
    expect(error?.code).toBe("23514");
  });
});

describe("the browser can write the audit trail", () => {
  it("appends a row attributed to the calling user", async () => {
    const response = await rpc("write_audit", {
      p_org_id: orgId,
      p_action: "rpc_probe",
      p_resource_type: "probe",
      p_resource_id: null,
      p_metadata: { note_count: 0 },
    });
    // A void-returning RPC answers 204, not 200. Either is success; a 4xx is not.
    expect([200, 204], response.text).toContain(response.status);

    const { data } = await admin()
      .from("audit_logs")
      .select("actor_user_id, action, organization_id")
      .eq("action", "rpc_probe")
      .eq("organization_id", orgId);
    expect(data?.length).toBe(1);
    expect(data?.[0]?.actor_user_id).toBe(userId);
  });

  it("accepts an event with no resource, which is a normal thing to record", async () => {
    // The resource id is optional: a sign-in or a settings change is not about one row.
    // PostgREST matches a function on the exact set of supplied parameter names, so a
    // four-key body needs the parameter to carry a default - which is what
    // 20261014001610_public_rpc_wrapper_signature.sql added.
    const response = await rpc("write_audit", {
      p_org_id: orgId,
      p_action: "rpc_probe",
      p_resource_type: "probe",
    });
    expect([200, 204], response.text).toContain(response.status);
  });

  it("refuses clinical free-text in the metadata", async () => {
    // private.write_audit owns this rule, and the public wrapper must not widen it.
    const response = await rpc("write_audit", {
      p_org_id: orgId,
      p_action: "rpc_probe",
      p_resource_type: "probe",
      p_metadata: { note: "Patient complains of chest pain" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
