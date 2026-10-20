-- Give public.create_organization_with_owner the same p_timezone default its private
-- original has.
--
-- WHY A SEPARATE FILE. 01600 and 01610 are applied, and an applied migration is never
-- edited.
--
-- WHAT WAS WRONG, AND HOW IT WAS FOUND. The public wrapper declared `p_timezone text` with
-- NO default, while `private.create_organization_with_owner` declares
-- `p_timezone text DEFAULT 'Asia/Kolkata'`. A caller that relied on the private
-- function's default - and tests/integration/onboarding-rpc.test.ts did exactly that, with
-- three arguments - got:
--
--   error: function public.create_organization_with_owner(unknown, unknown, unknown) does
--          not exist
--
-- The wrapper was supposed to be a THIN one, and it was not: it had quietly become a
-- DIFFERENT API, with a stricter signature than the function it delegates to. The general
-- rule this file exists to record: a wrapper must mirror the signature it wraps, DEFAULTS
-- INCLUDED. A default is part of the contract, and dropping one changes what every caller
-- can pass.
--
-- The other two wrappers were checked against the same yardstick and were already right:
-- public.can has `p_clinic_id DEFAULT NULL::uuid`, matching private.can, and
-- public.write_audit has `p_resource_id DEFAULT NULL::uuid` and
-- `p_metadata DEFAULT '{}'::jsonb`, matching private.write_audit - the latter added by
-- 20261014001610_public_rpc_wrapper_signature.sql for the same reason.

create or replace function public.create_organization_with_owner(
  p_name text,
  p_slug text,
  p_clinic_name text,
  p_timezone text default 'Asia/Kolkata'
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
  'Creates an organization, its first clinic and the calling user as owner. The caller must be authenticated; private.create_organization_with_owner owns every rule. The signature mirrors the private function exactly, defaults included.';

revoke execute on function public.create_organization_with_owner(text, text, text, text) from public;
revoke execute on function public.create_organization_with_owner(text, text, text, text) from anon;
grant execute on function public.create_organization_with_owner(text, text, text, text) to authenticated;
