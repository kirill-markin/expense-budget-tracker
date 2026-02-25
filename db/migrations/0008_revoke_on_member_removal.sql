-- Auto-revoke direct access when a workspace member is removed.
--
-- A removed member may still know the ws_xxx password. Revoking the Postgres
-- role ensures the credential becomes useless immediately. Remaining members
-- can re-provision if needed.
--
-- The trigger fires AFTER DELETE on workspace_members. It runs as SECURITY
-- DEFINER (tracker) to execute REVOKE/DROP ROLE.

CREATE OR REPLACE FUNCTION on_workspace_member_removed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  -- Check if this workspace has direct access provisioned.
  SELECT pg_role INTO v_role
  FROM direct_access_roles
  WHERE workspace_id = OLD.workspace_id;

  IF v_role IS NULL THEN
    RETURN OLD;
  END IF;

  -- Revoke CONNECT first to prevent reconnection.
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), v_role);

  -- Terminate existing connections.
  PERFORM pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE usename = v_role;

  -- Remove mapping.
  DELETE FROM direct_access_roles WHERE workspace_id = OLD.workspace_id;

  -- Revoke privileges and drop role.
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', v_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', v_role);
  EXECUTE format('DROP ROLE IF EXISTS %I', v_role);

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_revoke_direct_access_on_member_removal
  AFTER DELETE ON workspace_members
  FOR EACH ROW
  EXECUTE FUNCTION on_workspace_member_removed();
