-- Create a least-privilege role for the read-only machine SQL endpoint.

DO $$
DECLARE
  existing_role RECORD;
  parent_role_names NAME[];
BEGIN
  SELECT
    oid,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolinherit,
    rolcanlogin,
    rolreplication,
    rolbypassrls
  INTO existing_role
  FROM pg_roles
  WHERE rolname = 'api_sql_reader';

  IF NOT FOUND THEN
    CREATE ROLE api_sql_reader WITH NOLOGIN NOINHERIT;
  ELSIF
    existing_role.rolsuper
    OR existing_role.rolcreatedb
    OR existing_role.rolcreaterole
    OR existing_role.rolinherit
    OR existing_role.rolcanlogin
    OR existing_role.rolreplication
    OR existing_role.rolbypassrls
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Existing role api_sql_reader violates least-privilege requirements.',
      DETAIL = format(
        'Expected NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS; actual values: rolsuper=%s, rolcreatedb=%s, rolcreaterole=%s, rolinherit=%s, rolcanlogin=%s, rolreplication=%s, rolbypassrls=%s.',
        existing_role.rolsuper,
        existing_role.rolcreatedb,
        existing_role.rolcreaterole,
        existing_role.rolinherit,
        existing_role.rolcanlogin,
        existing_role.rolreplication,
        existing_role.rolbypassrls
      ),
      HINT = 'Have a database administrator repair or replace api_sql_reader with the expected attributes, then rerun migration 0066_api_sql_reader.sql.';
  ELSE
    SELECT array_agg(parent_role.rolname ORDER BY parent_role.rolname)
    INTO parent_role_names
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS parent_role
      ON parent_role.oid = membership.roleid
    WHERE membership.member = existing_role.oid;

    IF parent_role_names IS NOT NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = 'Existing role api_sql_reader has unexpected outgoing role memberships.',
        DETAIL = format(
          'Expected no parent roles; actual parent roles: %s.',
          array_to_string(parent_role_names, ', ')
        ),
        HINT = 'Have a database administrator revoke each listed parent role from api_sql_reader, then rerun migration 0066_api_sql_reader.sql.';
    END IF;
  END IF;
END
$$;

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
