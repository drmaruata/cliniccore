-- The public RPC surface: the browser's only door into the authorization primitives.
--
-- WHY THIS FILE EXISTS. The plan carried a note that was explicitly UNRESOLVED and had to be
-- settled before Task 12: "`authenticated` holds USAGE on `private` with EXECUTE granted per
-- function ... whether PostgREST exposes `private` could not be measured. Supabase's default
-- exposed set is `public, graphql_public`. If that default holds, none of these functions is
-- callable from the browser and Task 12 needs `public` wrappers."
--
-- IT IS NOW MEASURED, TWICE, AND THE DEFAULT HOLDS. `GET /rest/v1/` reports
-- `info.title = "standard public schema"` and lists only the public tables. A `POST` to
-- `/rest/v1/rpc/<fn>` naming any `private.*` function returns PGRST202 naming `public` as
-- the schema it searched. So the browser cannot call `private.can`,
-- `private.create_organization_with_owner`, or `private.write_audit` - and
-- `types/database.types.ts` recorded the consequence exactly: `Functions: { [_ in never]:
-- never }`.
--
-- The consequence was not cosmetic. A signed-in browser could not ask the database whether
-- it holds a permission, could not create its own organization, and could not write an audit
-- row. Task 17's onboarding was blocked outright, and the permission rule had to be
-- REIMPLEMENTED in TypeScript on the client - which is how it came to be implemented twice,
-- in SQL and in TypeScript, and how it drifted once already (the platform-key clause).
--
-- THE THREE FUNCTIONS, AND WHY EXACTLY THREE.
--
--   public.can                             the authorization rule, in one place
--   public.create_organization_with_owner  onboarding
--   public.write_audit                     the audit trail
--
-- Each is a THIN wrapper. Every rule - the platform-key refusal, the membership check, the
-- clinic scope, the audit metadata rules - stays in `private`, where it already is, and the
-- public function adds no decision of its own. That is the point: a wrapper that re-implemented
-- the rule would drift from it again, which is precisely what happened on the client side.
--
-- SECURITY DEFINER on all three, deliberately. Two reasons. First, `create_organization_with_owner`
-- must write rows the caller cannot write directly - `organization_memberships` INSERT is
-- closed by policy - and `write_audit` must write into a table whose INSERT is revoked from
-- `authenticated`. Second, and more usefully, it is what makes the hardening below possible:
-- the wrappers run as the owner, so the private functions they need no longer have to be
-- executable by `authenticated` at all.
--
-- `set search_path = ''` on every one, and every reference fully qualified, so nothing here
-- can be redirected by a caller-controlled search path.
--
-- ---------------------------------------------------------------------------
-- THE HARDENING, WHICH IS THE PART THAT MATTERS IF PostgREST's SET EVER CHANGES.
--
-- MEASURED: of the twenty functions in `private`, ten are referenced by RLS POLICIES and
-- must stay executable by `authenticated`, because a policy's expression is evaluated as the
-- QUERYING role, not as the table owner. Those are `assigned_to_self`, `can`, `can_grant`,
-- `clinic_ids`, `current_org_ids`, `is_member`, `is_platform_admin`, `storage_clinic_id`,
-- `storage_org_id` and `storage_path_is_safe`, and this file does not touch them.
--
-- Three more are referenced by TRIGGERS, which fire as their table's owner: the
-- `set_updated_at` and `guard_role_*` family and `create_profile_for_new_user`. Trigger
-- EXECUTE is checked when the trigger is CREATED, and this file does not touch those either.
--
-- That leaves exactly three: `write_audit`, `next_sequence_value` and
-- `create_organization_with_owner`. Nothing calls them, no policy calls them, no trigger calls
-- them - MEASURED, including by reading `pg_trigger` and every `pg_get_expr` of every
-- policy. They were reachable by any `authenticated` role over SQL, and the ONLY thing
-- containing them was PostgREST's schema setting.
--
-- That is one configuration change away from audit forgery: a member of a tenant could
-- write fabricated rows into that tenant's audit trail, or bump its MRN counter at will.
-- `private.write_audit` and `private.next_sequence_value` already check membership
-- internally - Task 8 hardened both - so the blast radius was "your own tenant", which is
-- still a tampered audit trail. Revoking EXECUTE from `authenticated` removes the capability
-- entirely, and the public wrappers still reach both functions because they run as the owner.
--
-- `private.next_sequence_value` gets NO public wrapper, and that is deliberate rather than
-- an oversight: a raw counter BUMPER is an abuse vector - a client could burn a tenant's
-- identifier space. The correct public shape, if a later task needs one, is a function that
-- RETURNS the next value for the caller's own tenant rather than one that increments on
-- demand. Recorded in docs/IMPLEMENTATION_STATUS.md as an open item, because
-- `patient_identifiers` INSERT is granted to `authenticated` and the column has no default
-- that calls the counter - so whoever builds patient registration will need to settle how
-- the number is obtained. It is not a Task 12 obligation and it is not a gap in THIS file.

-- ---------------------------------------------------------------------------
-- 1. public.can - the authorization rule, exposed once.

create or replace function public.can(
  p_org_id uuid,
  p_permission text,
  p_clinic_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.can(p_org_id, p_permission, p_clinic_id);
$fn$;

comment on function public.can(uuid, text, uuid) is
  'Whether the calling user holds a permission in an organization, optionally scoped to a clinic. Delegates to private.can, which owns the rule.';

revoke execute on function public.can(uuid, text, uuid) from public;
revoke execute on function public.can(uuid, text, uuid) from anon;
grant execute on function public.can(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. public.create_organization_with_owner - onboarding.

create or replace function public.create_organization_with_owner(
  p_name text,
  p_slug text,
  p_clinic_name text,
  p_timezone text
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.create_organization_with_owner(p_name, p_slug, p_clinic_name, p_timezone);
$fn$;

comment on function public.create_organization_with_owner(text, text, text, text) is
  'Creates an organization, its first clinic and the calling user as owner. The caller must be authenticated; private.create_organization_with_owner owns every rule.';

revoke execute on function public.create_organization_with_owner(text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. public.write_audit - the audit trail.

create or replace function public.write_audit(
  p_org_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $fn$
  select private.write_audit(p_org_id, p_action, p_resource_type, p_resource_id, p_metadata);
$fn$;

comment on function public.write_audit(uuid, text, text, uuid, jsonb) is
  'Appends one row to the audit trail for the calling user. private.write_audit owns the membership check, the length caps and the refusal of clinical free-text keys.';

revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from public;
revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from anon;
grant execute on function public.write_audit(uuid, text, text, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The hardening. These three are in no policy, in no trigger, and called by nothing.

-- private.write_audit is now reachable only through public.write_audit, which runs as the
-- owner. The direct grant to `authenticated` is what let any signed-in role call it.
revoke execute on function private.write_audit(uuid, text, text, uuid, jsonb) from authenticated;

-- private.next_sequence_value is a counter BUMPER. Nothing calls it, so nothing breaks; and
-- it must not be directly callable, because a client that could increment a tenant's
-- identifier space could exhaust it. The public wrappers above do not need it.
revoke execute on function private.next_sequence_value(uuid, text) from authenticated;

-- private.create_organization_with_owner is now reachable only through its public wrapper.
revoke execute on function private.create_organization_with_owner(text, text, text, text) from authenticated;
