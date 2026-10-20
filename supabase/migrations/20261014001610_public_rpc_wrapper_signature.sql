-- Give public.write_audit an optional resource id, so a caller can record an audit event
-- that is not about one specific row.
--
-- WHY A SEPARATE FILE. 01600 is applied, and an applied migration is never edited.
--
-- WHAT WAS WRONG, AND HOW IT WAS FOUND. The first run of tests/integration/public-rpc.test.ts
-- called the wrapper with four of its five arguments and PostgREST answered PGRST202:
--
--   "Searched for the function public.write_audit with parameters p_action, p_metadata,
--    p_org_id, p_resource_type, but no matches were found in the schema cache.
--    Perhaps you meant to call the function
--    public.write_audit(p_action, p_metadata, p_org_id, p_resource_id, p_resource_type)"
--
-- The function existed and was reachable - the earlier four calls to public.can and
-- public.create_organization_with_owner had already gone green over real HTTPS. What
-- PostgREST could not do was MATCH a four-key body against a five-parameter function.
-- `p_metadata` had a default and `p_resource_id` did not, so the two were not equivalent
-- to PostgREST, which matches on the exact set of supplied parameter names.
--
-- `p_resource_id` is nullable in `audit_logs` and in private.write_audit, and an audit
-- event legitimately has no particular resource - a sign-in, a failed export, a settings
-- change. Requiring every caller to pass a null is an API shaped by a limitation rather
-- than by the domain, so the parameter gets the default it should have had from the start.
--
-- The alternative - making every caller pass `p_resource_id: null` explicitly - would also
-- work, and is what the test now does as well, so the wrapper is usable BOTH ways. The
-- default is added because an audit event with no resource is a normal thing to record,
-- and a function that cannot express it is a function that will be worked around.

create or replace function public.write_audit(
  p_org_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid default null,
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
  'Appends one row to the audit trail for the calling user. The resource id is optional: an audit event need not be about one specific row. private.write_audit owns the membership check, the length caps and the refusal of clinical free-text keys.';

revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from public;
revoke execute on function public.write_audit(uuid, text, text, uuid, jsonb) from anon;
grant execute on function public.write_audit(uuid, text, text, uuid, jsonb) to authenticated;
