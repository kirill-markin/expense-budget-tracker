-- Remove direct database access infrastructure.
--
-- The SQL Query API (api_keys + /api/sql) replaces direct Postgres connections.
-- This migration cleans up: ws_xxx roles, triggers, functions, RLS policies,
-- and the direct_access_roles table.
--
-- Order: drop dependents before dependencies.
-- IMPORTANT: get_user_workspace_ids() is NOT dropped — used by api_keys RLS.

-- ==========================================================================
-- 1. Revoke and drop all existing ws_xxx Postgres roles
-- ==========================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT pg_role FROM direct_access_roles LOOP
    -- Revoke CONNECT first to prevent reconnection.
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), r.pg_role);
    -- Terminate existing connections.
    PERFORM pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE usename = r.pg_role;
    -- Revoke all privileges.
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', r.pg_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', r.pg_role);
    -- Drop the role.
    EXECUTE format('DROP ROLE IF EXISTS %I', r.pg_role);
  END LOOP;
END;
$$;

-- ==========================================================================
-- 2. Drop triggers
-- ==========================================================================

DROP TRIGGER IF EXISTS trg_revoke_direct_access_on_member_removal ON workspace_members;

-- ==========================================================================
-- 3. Drop functions
-- ==========================================================================

DROP FUNCTION IF EXISTS on_workspace_member_removed();
DROP FUNCTION IF EXISTS provision_direct_access(TEXT, TEXT);
DROP FUNCTION IF EXISTS revoke_direct_access(TEXT);
DROP FUNCTION IF EXISTS rotate_direct_access_password(TEXT, TEXT);

-- ==========================================================================
-- 4. Drop RLS policies referencing direct_access_roles
-- ==========================================================================

-- RESTRICTIVE "role_restriction" policies on all workspace-scoped tables.
DROP POLICY IF EXISTS role_restriction ON ledger_entries;
DROP POLICY IF EXISTS role_restriction ON budget_lines;
DROP POLICY IF EXISTS role_restriction ON budget_comments;
DROP POLICY IF EXISTS role_restriction ON workspace_settings;
DROP POLICY IF EXISTS role_restriction ON workspace_members;
DROP POLICY IF EXISTS role_restriction ON workspaces;
DROP POLICY IF EXISTS role_restriction ON account_metadata;
DROP POLICY IF EXISTS role_restriction ON api_keys;

-- PERMISSIVE "direct_access" policies on workspace-scoped tables.
DROP POLICY IF EXISTS direct_access ON ledger_entries;
DROP POLICY IF EXISTS direct_access ON budget_lines;
DROP POLICY IF EXISTS direct_access ON budget_comments;
DROP POLICY IF EXISTS direct_access ON workspace_settings;
DROP POLICY IF EXISTS direct_access ON workspaces;
DROP POLICY IF EXISTS direct_access ON workspace_members;
DROP POLICY IF EXISTS direct_access ON account_metadata;

-- Policies on the direct_access_roles table itself.
DROP POLICY IF EXISTS self_access ON direct_access_roles;
DROP POLICY IF EXISTS app_access ON direct_access_roles;

-- ==========================================================================
-- 5. Drop the table
-- ==========================================================================

DROP TABLE IF EXISTS direct_access_roles;
