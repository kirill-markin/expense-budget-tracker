-- Drop plaintext password storage: show-once credential model.
--
-- Passwords are now shown only at provision/rotate time, never stored.
-- Postgres handles authentication internally (pg_authid stores the hash).
-- This eliminates plaintext passwords from the database and all backups.
--
-- Also fixes revocation race condition: REVOKE CONNECT first to prevent
-- reconnection between pg_terminate_backend and DROP ROLE.

ALTER TABLE direct_access_roles DROP COLUMN pg_password;

-- Recreate provision function without pg_password storage.
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

-- Recreate rotate function without pg_password update.
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

-- Fix revocation race: revoke CONNECT first so the role cannot reconnect
-- between pg_terminate_backend and DROP ROLE.
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
