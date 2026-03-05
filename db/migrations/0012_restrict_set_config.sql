-- Restrict set_config to prevent SQL API users from overriding RLS context.
--
-- The SQL API (apps/sql-api) accepts arbitrary SQL from authenticated users.
-- Without this restriction, a user could call set_config('app.user_id', ...)
-- inside a subquery to override the server-set RLS context and access other
-- users' data within the same transaction.
--
-- Solution:
--   1. Revoke set_config from PUBLIC (only app + superuser need it).
--   2. Create a restricted api_sql_executor role for user-provided SQL.
--   3. SQL API server sets RLS context as app, then SET LOCAL ROLE to
--      api_sql_executor before executing user SQL.

-- ==========================================================================
-- 1. Revoke set_config from PUBLIC, grant to app
-- ==========================================================================

REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO app;

-- ==========================================================================
-- 2. Create restricted role for SQL API user queries
-- ==========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_sql_executor') THEN
    CREATE ROLE api_sql_executor WITH NOLOGIN;
  END IF;
END
$$;

-- Allow app to SET ROLE api_sql_executor
GRANT api_sql_executor TO app;

-- ==========================================================================
-- 3. Table grants (mirrors app role, minus api_keys)
-- ==========================================================================

GRANT USAGE ON SCHEMA public TO api_sql_executor;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  ledger_entries, budget_lines, budget_comments,
  workspace_settings, account_metadata
TO api_sql_executor;

GRANT SELECT, INSERT, UPDATE ON TABLE user_settings TO api_sql_executor;
GRANT SELECT, INSERT ON TABLE workspaces, workspace_members TO api_sql_executor;
GRANT SELECT ON TABLE exchange_rates TO api_sql_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_sql_executor;

-- api_keys: intentionally not granted. Key management is via web app endpoints.
-- set_config: intentionally not granted. This is the whole point of this migration.
