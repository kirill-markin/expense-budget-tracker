-- Direct database access: per-workspace Postgres roles with RESTRICTIVE RLS.
--
-- Problem: existing RLS uses GUC variables (app.user_id, app.workspace_id)
-- which are PGC_USERSET — any connected user can SET them, breaking tenant
-- isolation if they connect directly (psql, DBeaver, LLM agents).
--
-- Solution: dual policy layer.
--   1. RESTRICTIVE policy on every workspace-scoped table checks current_user
--      (unfakeable Postgres auth). For the app role it's a transparent pass-through;
--      for ws_xxx roles it locks access to the single mapped workspace.
--   2. PERMISSIVE policies for ws_xxx roles grant row access based on the
--      direct_access_roles mapping (since existing GUC-based policies won't
--      match for roles that don't set app.user_id).
--
-- Security model:
--   app role     → current_user='app' passes RESTRICTIVE, then existing GUC-based
--                  permissive policies filter by membership as before.
--   ws_xxx role  → RESTRICTIVE limits to mapped workspace; PERMISSIVE direct_access
--                  grants rows in that workspace. SET app.user_id='victim' has no
--                  effect because RESTRICTIVE still checks current_user mapping.
--   tracker role → DB owner, runs migrations. FORCE RLS is on but tracker bypasses
--                  RLS as table owner (standard Postgres behavior).
--
-- Attack vectors blocked:
--   SET app.user_id = 'victim'       → RESTRICTIVE still limits to mapped workspace
--   SET app.workspace_id = 'other'   → RESTRICTIVE still limits to mapped workspace
--   SET ROLE other_role              → no cross-role grants, fails with permission error
--   SET SESSION AUTHORIZATION        → requires SUPERUSER, ws_xxx doesn't have it
--   Reading direct_access_roles      → RLS shows only own row
--   Modifying direct_access_roles    → no INSERT/UPDATE/DELETE grant for ws_xxx

-- 1. Mapping table: workspace_id <-> Postgres role.
--
-- One row per workspace with direct access enabled. pg_password is stored in
-- plaintext so the UI can display it (the user already knows it — they generated
-- it). RLS ensures ws_xxx sees only its own row, app sees rows for its user's
-- workspaces.

CREATE TABLE direct_access_roles (
  workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(workspace_id),
  pg_role      TEXT NOT NULL UNIQUE,
  pg_password  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE direct_access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_access_roles FORCE ROW LEVEL SECURITY;

-- Direct access roles see only their own mapping.
CREATE POLICY self_access ON direct_access_roles
  USING (pg_role = current_user);

-- App role sees credentials for user's workspaces (for UI display).
CREATE POLICY app_access ON direct_access_roles
  USING (
    current_user = 'app'
    AND workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = current_setting('app.user_id', true)
    )
  );

-- 2. RESTRICTIVE policies on all workspace-scoped tables.
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

-- 3. PERMISSIVE policies for direct access roles.
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

-- 4. SECURITY DEFINER functions for role provisioning.
--
-- Owned by tracker (RDS master user with rds_superuser), callable by app.
-- These functions run with tracker's privileges to execute CREATE/ALTER/DROP ROLE.
--
-- Security considerations:
--   - SECURITY DEFINER escalates to tracker's privileges for the duration of the
--     function call. search_path is pinned to 'public' to prevent search_path
--     injection attacks.
--   - Each function verifies workspace membership via current_setting('app.user_id')
--     before any privileged operation. The caller (app role) sets this GUC in the
--     transaction before calling the function.
--   - format(%I, ...) is used for all dynamic identifiers to prevent SQL injection.
--   - format(%L, ...) is used for password literals to prevent SQL injection.

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

  v_role := 'ws_' || p_workspace_id;

  -- Create Postgres role with login and password.
  EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', v_role, p_password);

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

  -- Terminate active connections.
  PERFORM pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE usename = v_role;

  -- Remove mapping first (before dropping role).
  DELETE FROM direct_access_roles WHERE workspace_id = p_workspace_id;

  -- Revoke all privileges and drop role.
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', v_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', v_role);
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), v_role);
  EXECUTE format('DROP ROLE IF EXISTS %I', v_role);
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

  -- Change password.
  EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', v_role, p_new_password);

  -- Update stored password.
  UPDATE direct_access_roles
  SET pg_password = p_new_password
  WHERE workspace_id = p_workspace_id;
END;
$$;
