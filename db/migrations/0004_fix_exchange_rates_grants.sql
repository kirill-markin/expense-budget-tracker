-- Fix: grant SELECT on exchange_rates and accounts to all existing direct
-- access roles (ws_xxx). The provision_direct_access() function is idempotent
-- and returns early for already-provisioned roles, so roles created before
-- exchange_rates was in the GRANT list — or whose GRANT failed due to the
-- accounts view not existing — permanently lack these permissions.
-- GRANT is idempotent: a no-op if the privilege already exists.
--
-- NOTE: direct_access_roles and ws_xxx roles were removed in
-- 0008_remove_direct_access.sql. This loop is a no-op on new installs.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT pg_role FROM direct_access_roles LOOP
    EXECUTE format('GRANT SELECT ON TABLE exchange_rates TO %I', r.pg_role);
    EXECUTE format('GRANT SELECT ON accounts TO %I', r.pg_role);
  END LOOP;
END
$$;
