-- Create a least-privilege role for the read-only machine SQL endpoint.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_sql_reader') THEN
    CREATE ROLE api_sql_reader WITH
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE api_sql_reader WITH
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;
GRANT api_sql_reader TO app;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM api_sql_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM api_sql_reader;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM api_sql_reader;

GRANT USAGE ON SCHEMA public TO api_sql_reader;
GRANT SELECT ON TABLE
  ledger_entries,
  budget_lines,
  workspace_settings,
  account_metadata,
  fx_rates_raw,
  fx_rates_daily
TO api_sql_reader;

GRANT EXECUTE ON FUNCTION current_app_user_has_selected_workspace_access()
TO api_sql_reader;
