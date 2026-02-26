-- Direct database access: per-workspace Postgres roles with RESTRICTIVE RLS.
--
-- Existing RLS uses GUC variables (app.user_id, app.workspace_id) which are
-- PGC_USERSET — any connected user can SET them, breaking tenant isolation if
-- they connect directly (psql, DBeaver, LLM agents).
--
-- Solution: dual policy layer.
--   1. RESTRICTIVE policy on every workspace-scoped table checks current_user
--      (unfakeable Postgres auth). For the app role it's a transparent
--      pass-through; for ws_xxx roles it locks access to the single mapped
--      workspace.
--   2. PERMISSIVE policies for ws_xxx roles grant row access based on the
--      direct_access_roles mapping (since existing GUC-based policies won't
--      match for roles that don't set app.user_id).
--
-- Passwords are never stored — shown only at provision/rotate time (show-once
-- model). Postgres handles authentication internally (pg_authid stores the hash).
--
-- Role names are opaque (ws_ + md5 hash) to prevent workspace_id enumeration
-- via pg_roles system catalog.

-- ==========================================================================
-- 1. Mapping table
-- ==========================================================================

CREATE TABLE direct_access_roles (
  workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(workspace_id),
  pg_role      TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE direct_access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_access_roles FORCE ROW LEVEL SECURITY;

-- Direct access roles see only their own mapping.
CREATE POLICY self_access ON direct_access_roles
  USING (pg_role = current_user);

-- ==========================================================================
-- 2. RLS recursion fix helper
-- ==========================================================================
--
-- Without this, workspace_members.role_restriction → direct_access_roles and
-- direct_access_roles.app_access → workspace_members creates an infinite
-- recursion cycle at query rewrite time. SECURITY DEFINER breaks the cycle
-- by bypassing RLS on workspace_members.

CREATE OR REPLACE FUNCTION get_user_workspace_ids(p_user_id TEXT)
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wm.workspace_id
  FROM workspace_members wm
  WHERE wm.user_id = p_user_id;
$$;

-- App role sees credentials for user's workspaces (for UI display).
CREATE POLICY app_access ON direct_access_roles
  USING (
    current_user = 'app'
    AND workspace_id IN (
      SELECT get_user_workspace_ids(current_setting('app.user_id', true))
    )
  );

-- ==========================================================================
-- 3. RESTRICTIVE policies on all workspace-scoped tables
-- ==========================================================================
--
-- RESTRICTIVE policies AND with all PERMISSIVE policies. Non-app roles can
-- ONLY access rows in their mapped workspace, regardless of GUC manipulation.

CREATE POLICY role_restriction ON ledger_entries AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY role_restriction ON budget_lines AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY role_restriction ON budget_comments AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY role_restriction ON workspace_settings AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY role_restriction ON workspace_members AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY role_restriction ON workspaces AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

-- ==========================================================================
-- 4. PERMISSIVE policies for direct access roles
-- ==========================================================================
--
-- Existing GUC-based permissive policies won't pass for ws_xxx roles (no valid
-- app.user_id). These policies grant access based on current_user mapping.

CREATE POLICY direct_access ON ledger_entries
  USING (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY direct_access ON budget_lines
  USING (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY direct_access ON budget_comments
  USING (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY direct_access ON workspace_settings
  USING (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY direct_access ON workspaces
  USING (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

CREATE POLICY direct_access ON workspace_members
  USING (
    workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

-- ==========================================================================
-- 5. SECURITY DEFINER functions for role provisioning
-- ==========================================================================
--
-- Owned by tracker (RDS master user with rds_superuser), callable by app.
-- These functions run with tracker's privileges to execute CREATE/ALTER/DROP ROLE.

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

  -- Record mapping (no password stored — Postgres handles auth via pg_authid).
  INSERT INTO direct_access_roles (workspace_id, pg_role)
  VALUES (p_workspace_id, v_role);

  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION rotate_direct_access_password(
  p_workspace_id TEXT,
  p_new_password TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  -- Verify caller is a member of this workspace.
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = current_setting('app.user_id', true)
  ) THEN
    RAISE EXCEPTION 'User is not a member of workspace %', p_workspace_id;
  END IF;

  SELECT pg_role INTO v_role
  FROM direct_access_roles
  WHERE workspace_id = p_workspace_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'No direct access role found for workspace %', p_workspace_id;
  END IF;

  -- Change password in Postgres (only pg_authid stores the hash, not us).
  EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', v_role, p_new_password);
END;
$$;

-- Revocation: REVOKE CONNECT first to prevent reconnection between
-- pg_terminate_backend and DROP ROLE.
CREATE OR REPLACE FUNCTION revoke_direct_access(
  p_workspace_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  -- Verify caller is a member of this workspace.
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = current_setting('app.user_id', true)
  ) THEN
    RAISE EXCEPTION 'User is not a member of workspace %', p_workspace_id;
  END IF;

  SELECT pg_role INTO v_role
  FROM direct_access_roles
  WHERE workspace_id = p_workspace_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'No direct access role found for workspace %', p_workspace_id;
  END IF;

  -- 1. Revoke CONNECT first — prevents new connections.
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), v_role);

  -- 2. Terminate existing connections (now safe — no reconnection possible).
  PERFORM pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE usename = v_role;

  -- 3. Remove mapping.
  DELETE FROM direct_access_roles WHERE workspace_id = p_workspace_id;

  -- 4. Revoke remaining privileges and drop role.
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', v_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', v_role);
  EXECUTE format('DROP ROLE IF EXISTS %I', v_role);
END;
$$;

-- ==========================================================================
-- 6. Auto-revoke direct access on workspace member removal
-- ==========================================================================
--
-- A removed member may still know the ws_xxx password. Revoking the Postgres
-- role ensures the credential becomes useless immediately.

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
