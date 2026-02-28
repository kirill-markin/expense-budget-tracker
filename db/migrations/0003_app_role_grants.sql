-- Create the app role for RLS-restricted access.
-- Password is set by migrate.sh after this migration runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app WITH LOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  ledger_entries, budget_lines, budget_comments, workspace_settings
TO app;
GRANT SELECT, INSERT ON TABLE workspaces, workspace_members TO app;
GRANT SELECT, INSERT ON TABLE exchange_rates TO app;
-- accounts is a view created after migrations (db/views/accounts.sql);
-- its grant lives in that file to avoid ordering issues.
-- Direct access: app needs SELECT to display credentials in UI,
-- and EXECUTE on SECURITY DEFINER functions that manage Postgres roles.
-- NOTE: These grants are now no-ops — the table and functions were dropped
-- in 0008_remove_direct_access.sql.
GRANT SELECT ON TABLE direct_access_roles TO app;
GRANT EXECUTE ON FUNCTION provision_direct_access(TEXT, TEXT) TO app;
GRANT EXECUTE ON FUNCTION revoke_direct_access(TEXT) TO app;
GRANT EXECUTE ON FUNCTION rotate_direct_access_password(TEXT, TEXT) TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
