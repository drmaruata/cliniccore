-- Revoke the default PUBLIC EXECUTE on the appointment status-transition trigger
-- function, which 20261029001900 created without a privilege statement.
--
-- MEASURED before this file: private.guard_appointment_status_transition was
-- executable by anon and carried the PUBLIC grant, because PostgreSQL grants
-- EXECUTE to PUBLIC on every new function. The function is INVOKER and only
-- raises, so it is not a data oracle today - but `authenticated` and `anon` hold
-- USAGE on the `private` schema, and what contained the call was the PostgREST
-- schema setting, a configuration value rather than a boundary. Without this
-- revoke, the next change that teaches the function to read a table would
-- inherit the grant.
--
-- This is the posture private.set_updated_at() and private.guard_platform_admin()
-- already have: revoke from PUBLIC and from ANON, grant to authenticated. A
-- trigger's EXECUTE privilege is checked when the trigger is CREATED, not when it
-- fires, so the grant to authenticated is not what makes the trigger work; it is
-- kept so the trigger-function inventory has one explicit, asserted posture.

revoke execute on function private.guard_appointment_status_transition() from public;
revoke execute on function private.guard_appointment_status_transition() from anon;
grant execute on function private.guard_appointment_status_transition() to authenticated;
