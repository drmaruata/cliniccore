-- Task 6 addendum: indexes and privilege hardening.
--
-- Two gaps the Task 6 review found in 00300, applied as a separate file because
-- 00300 is already applied (README: never edit an applied migration).
--
-- Indexes. private.current_org_ids() filters organization_memberships on
-- user_id, and Task 9 puts that call in an RLS policy on every tenant table, so
-- without an index on user_id every authenticated query seq-scans memberships.
-- The two clinic_memberships indexes cover the composite-FK cascade paths (the
-- unique (membership_id, clinic_id) index cannot serve them - wrong leading
-- column); invitations(organization_id) backs the org-scoped invite listing.
--
-- Privilege hardening. RLS does not apply to table-wide operations: TRUNCATE,
-- REFERENCES and TRIGGER bypass row security entirely. Supabase grants all of
-- them to anon and authenticated by default, and does the same to every future
-- table (the public default ACL). Row operations are RLS-controlled; these three
-- are defence in depth and are revoked here. create_profile_for_new_user() also
-- gains the revoke-from-public its sibling functions already carry.

create index if not exists organization_memberships_user_id_idx
  on public.organization_memberships (user_id);

create index if not exists clinic_memberships_membership_fkey_idx
  on public.clinic_memberships (organization_id, membership_id);

create index if not exists clinic_memberships_clinic_fkey_idx
  on public.clinic_memberships (organization_id, clinic_id);

create index if not exists invitations_organization_id_idx
  on public.invitations (organization_id);

revoke execute on function private.create_profile_for_new_user() from public;
grant execute on function private.create_profile_for_new_user() to authenticated;

revoke truncate, references, trigger on public.profiles from anon, authenticated;
revoke truncate, references, trigger on public.organizations from anon, authenticated;
revoke truncate, references, trigger on public.organization_memberships from anon, authenticated;
revoke truncate, references, trigger on public.clinics from anon, authenticated;
revoke truncate, references, trigger on public.clinic_memberships from anon, authenticated;
revoke truncate, references, trigger on public.invitations from anon, authenticated;
