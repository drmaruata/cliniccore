-- Task 16 review, round 3: the private helpers' privileges, measured.
--
-- MEASURED, before this file:
--
--   function                     anon   public   authenticated
--   assignment_target_is_member  true   true     true
--   can_grant                    false  false    true
--
-- TWO PROBLEMS.
--
-- 1. `private.assignment_target_is_member` answers "is user X an active member of
--    organization Y" - the exact shape that was ruled UNREACHABLE when the `*_for`
--    helpers were revoked in 20261014001750. It is a SECURITY DEFINER, so it reads
--    the memberships table as postgres and answers about ANY user and ANY
--    organization. `authenticated` holds USAGE on the `private` schema, and the
--    function carried the DEFAULT grant to PUBLIC, so anon could call it too. What
--    contained it was `db_schemas = public` - a CONFIGURATION SETTING, not a
--    boundary, and one setting change away from a membership oracle for every tenant
--    in the project.
--
--    It IS called by two policies - `user_role_assignments_write` and
--    `user_role_assignments_update` - and a policy's expression is evaluated as the
--    QUERYING role, so `authenticated` must keep EXECUTE on it. Revoking it from
--    `authenticated` would make every assignment write INVISIBLE rather than denied,
--    which is a silent total failure. So: revoke from PUBLIC and from ANON, and
--    GRANT to authenticated explicitly - the posture every other helper has.
--
-- 2. `private.can_grant` is the SUBSET rule on its own - the looser half of the
--    ceiling. Since 20261014001780 no policy calls it: the assignment policies and
--    the invitation policies all call `can_assign_role`, which is the subset rule AND
--    the owner-only clause. So it is a LOOSER rule with no caller, executable by
--    every signed-in role. The next thing to call it would be a policy that means to
--    enforce the ceiling and enforces half of it - which is exactly the hole the
--    first review found. It is revoked from `authenticated` for that reason, and
--    `can_grant_for` keeps the rule for the definer functions that need it.
--
-- THE FAMILY, AND ITS POSTURE. The `*_for` helpers answer about OTHER users, so
-- they are not executable by anyone: only the definer functions that own them call
-- them. `is_member_for`, `can_for`, `can_grant_for` and `can_assign_role_for` are all
-- in that posture already, and this file restates it so the intent is on the record
-- rather than inferred from four separate revokes.

revoke execute on function private.assignment_target_is_member(uuid, uuid) from public;
revoke execute on function private.assignment_target_is_member(uuid, uuid) from anon;
grant execute on function private.assignment_target_is_member(uuid, uuid) to authenticated;

-- The subset rule's caller-bound wrapper. The rule itself lives in
-- `private.can_grant_for`, which the ceiling uses; this wrapper is not called by
-- anything, and a looser rule that is callable is a trap.
revoke execute on function private.can_grant(uuid, uuid) from public;
revoke execute on function private.can_grant(uuid, uuid) from anon;
revoke execute on function private.can_grant(uuid, uuid) from authenticated;

-- The user-parameterised cores. They answer about OTHER users, so only the definer
-- functions that own them may call them.
revoke execute on function private.is_member_for(uuid, uuid) from public;
revoke execute on function private.is_member_for(uuid, uuid) from anon;
revoke execute on function private.is_member_for(uuid, uuid) from authenticated;

revoke execute on function private.can_for(uuid, uuid, text, uuid) from public;
revoke execute on function private.can_for(uuid, uuid, text, uuid) from anon;
revoke execute on function private.can_for(uuid, uuid, text, uuid) from authenticated;

revoke execute on function private.can_grant_for(uuid, uuid, uuid) from public;
revoke execute on function private.can_grant_for(uuid, uuid, uuid) from anon;
revoke execute on function private.can_grant_for(uuid, uuid, uuid) from authenticated;

revoke execute on function private.can_assign_role_for(uuid, uuid, uuid) from public;
revoke execute on function private.can_assign_role_for(uuid, uuid, uuid) from anon;
revoke execute on function private.can_assign_role_for(uuid, uuid, uuid) from authenticated;
