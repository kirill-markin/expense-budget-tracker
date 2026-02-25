-- Harden direct access roles:
--
-- 1. Opaque role names: ws_ + md5(workspace_id) truncated to 12 hex chars.
--    Prevents workspace_id enumeration via pg_roles system catalog (readable
--    by all Postgres roles, cannot be restricted).
--    Collision risk: 48-bit space → birthday collision at ~16M workspaces.
--
-- 2. Resource limits on provisioned roles:
--    - CONNECTION LIMIT 5         — prevent connection pool exhaustion
--    - statement_timeout = 30s    — prevent long-running queries from hogging CPU
--    - idle_in_transaction_session_timeout = 60s — prevent stale locks blocking VACUUM
--    - temp_file_limit = 256MB    — prevent disk exhaustion via TEMP tables
--
-- Only provision_direct_access changes (CREATE OR REPLACE). revoke and rotate
-- read pg_role from the mapping table, so they work with any naming scheme.

CREATE OR REPLACE FUNCTION provision_direct_access(
  p_workspace_id TEXT,
  p_password TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_existing TEXT;
BEGIN
  -- Verify caller is a member of this workspace (uses RLS via app.user_id).
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = current_setting('app.user_id', true)
  ) THEN
    RAISE EXCEPTION 'User is not a member of workspace %', p_workspace_id;
  END IF;

  -- Idempotent: return existing role if already provisioned.
  SELECT pg_role INTO v_existing
  FROM direct_access_roles
  WHERE workspace_id = p_workspace_id;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Opaque name: md5 hash prevents workspace_id enumeration via pg_roles.
  v_role := 'ws_' || left(md5(p_workspace_id), 12);

  -- Create Postgres role with login, password, and connection limit.
  EXECUTE format(
    'CREATE ROLE %I WITH LOGIN PASSWORD %L CONNECTION LIMIT 5',
    v_role, p_password
  );

  -- Resource limits: prevent CPU/disk/lock exhaustion.
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', v_role, '30s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', v_role, '60s');
  EXECUTE format('ALTER ROLE %I SET temp_file_limit = %L', v_role, '256MB');

  -- Grant connection and schema usage.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);

  -- Grant CRUD on workspace-scoped data tables.
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ledger_entries, budget_lines, budget_comments, workspace_settings TO %I',
    v_role
  );

  -- Grant SELECT on reference/membership tables.
  EXECUTE format(
    'GRANT SELECT ON TABLE workspaces, workspace_members, exchange_rates, accounts, direct_access_roles TO %I',
    v_role
  );

  -- Record mapping.
  INSERT INTO direct_access_roles (workspace_id, pg_role, pg_password)
  VALUES (p_workspace_id, v_role, p_password);

  RETURN v_role;
END;
$$;
