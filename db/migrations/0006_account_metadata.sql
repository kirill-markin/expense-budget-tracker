-- Account metadata sidecar table.
--
-- Accounts are a derived VIEW (no physical table). This table stores
-- per-account attributes (e.g. liquidity) without changing the core design.
-- No FK on account_id — accounts is a VIEW, not a table.
-- Orphaned rows (account renamed/removed) are harmless and ignored by JOINs.

-- ==========================================================================
-- 1. Table
-- ==========================================================================

CREATE TABLE account_metadata (
  workspace_id TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  liquidity    TEXT NOT NULL DEFAULT 'high'
                    CHECK (liquidity IN ('high', 'medium', 'low')),
  PRIMARY KEY (workspace_id, account_id)
);

-- ==========================================================================
-- 2. RLS
-- ==========================================================================

ALTER TABLE account_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_metadata FORCE ROW LEVEL SECURITY;

-- Layer 1 (PERMISSIVE): GUC-based, for the app role.
CREATE POLICY workspace_isolation ON account_metadata
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = current_setting('app.user_id', true)
    )
    AND (
      current_setting('app.workspace_id', true) IS NULL
      OR workspace_id = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = current_setting('app.user_id', true)
    )
    AND (
      current_setting('app.workspace_id', true) IS NULL
      OR workspace_id = current_setting('app.workspace_id', true)
    )
  );

-- Layer 2 (RESTRICTIVE): Postgres-role-based, blocks GUC spoofing.
CREATE POLICY role_restriction ON account_metadata AS RESTRICTIVE
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

-- Layer 2 (PERMISSIVE): direct access for ws_xxx roles.
CREATE POLICY direct_access ON account_metadata
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

-- ==========================================================================
-- 3. Grants
-- ==========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account_metadata TO app;

-- Update provision_direct_access to include account_metadata for new roles.
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
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = current_setting('app.user_id', true)
  ) THEN
    RAISE EXCEPTION 'User is not a member of workspace %', p_workspace_id;
  END IF;

  SELECT pg_role INTO v_existing
  FROM direct_access_roles
  WHERE workspace_id = p_workspace_id;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_role := 'ws_' || left(md5(p_workspace_id), 12);

  EXECUTE format(
    'CREATE ROLE %I WITH LOGIN PASSWORD %L CONNECTION LIMIT 5',
    v_role, p_password
  );

  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', v_role, '30s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', v_role, '60s');
  EXECUTE format('ALTER ROLE %I SET temp_file_limit = %L', v_role, '256MB');

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);

  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ledger_entries, budget_lines, budget_comments, workspace_settings, account_metadata TO %I',
    v_role
  );

  EXECUTE format(
    'GRANT SELECT ON TABLE workspaces, workspace_members, exchange_rates, accounts, direct_access_roles TO %I',
    v_role
  );

  INSERT INTO direct_access_roles (workspace_id, pg_role)
  VALUES (p_workspace_id, v_role);

  RETURN v_role;
END;
$$;

-- Retroactive grants for existing direct access roles.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT pg_role FROM direct_access_roles LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account_metadata TO %I', r.pg_role);
  END LOOP;
END;
$$;
