-- Read-only login role for the admin app's product analytics.
--
-- admin_analytics reads the analytics activity tables and a few identity
-- columns of every user, and no financial data. It does not bypass row level
-- security: users gets a permissive SELECT policy for this role, so access
-- stays visible in pg_policy. Its sessions default to read-only transactions.
-- scripts/migrate.sh sets the password after the migrations run.

SET LOCAL lock_timeout = '30s';

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
  WHERE rolname = 'admin_analytics';

  IF NOT FOUND THEN
    CREATE ROLE admin_analytics WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF
    existing_role.rolsuper
    OR existing_role.rolcreatedb
    OR existing_role.rolcreaterole
    OR existing_role.rolinherit
    OR NOT existing_role.rolcanlogin
    OR existing_role.rolreplication
    OR existing_role.rolbypassrls
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Existing role admin_analytics violates least-privilege requirements.',
      DETAIL = format(
        'Expected LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; actual values: rolsuper=%s, rolcreatedb=%s, rolcreaterole=%s, rolinherit=%s, rolcanlogin=%s, rolreplication=%s, rolbypassrls=%s.',
        existing_role.rolsuper,
        existing_role.rolcreatedb,
        existing_role.rolcreaterole,
        existing_role.rolinherit,
        existing_role.rolcanlogin,
        existing_role.rolreplication,
        existing_role.rolbypassrls
      ),
      HINT = 'Have a database administrator repair or replace admin_analytics with the expected attributes, then rerun migration 0091_admin_analytics_role.sql.';
  ELSE
    SELECT array_agg(parent_role.rolname ORDER BY parent_role.rolname)
    INTO parent_role_names
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS parent_role
      ON parent_role.oid = membership.roleid
    WHERE membership.member = existing_role.oid;

    IF parent_role_names IS NOT NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = 'Existing role admin_analytics has unexpected outgoing role memberships.',
        DETAIL = format(
          'Expected no parent roles; actual parent roles: %s.',
          array_to_string(parent_role_names, ', ')
        ),
        HINT = 'Have a database administrator revoke each listed parent role from admin_analytics, then rerun migration 0091_admin_analytics_role.sql.';
    END IF;
  END IF;
END
$$;

ALTER ROLE admin_analytics SET default_transaction_read_only = on;
ALTER ROLE admin_analytics SET statement_timeout = '15s';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO admin_analytics', current_database());
END
$$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM admin_analytics;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA analytics FROM admin_analytics;

GRANT USAGE ON SCHEMA analytics TO admin_analytics;
GRANT SELECT ON TABLE
  analytics.user_open_days,
  analytics.user_track_days
TO admin_analytics;

GRANT USAGE ON SCHEMA public TO admin_analytics;
GRANT SELECT (user_id, email, created_at, first_seen_at, last_seen_at)
  ON TABLE public.users
  TO admin_analytics;

CREATE POLICY users_admin_analytics_select
  ON public.users FOR SELECT TO admin_analytics USING (true);

-- Verify before commit, so a role that can read more, or write anything,
-- cannot be recorded as applied.
DO $$
DECLARE
  v_expected_tables REGCLASS[] := ARRAY[
    'analytics.user_open_days',
    'analytics.user_track_days'
  ]::REGCLASS[];
  v_expected_user_columns NAME[] := ARRAY[
    'user_id',
    'email',
    'created_at',
    'first_seen_at',
    'last_seen_at'
  ]::NAME[];
  v_role_config TEXT[];
  v_member_names NAME[];
  v_violation RECORD;
  v_table REGCLASS;
BEGIN
  SELECT rolconfig INTO v_role_config FROM pg_catalog.pg_roles WHERE rolname = 'admin_analytics';

  IF v_role_config IS NULL
    OR NOT v_role_config @> ARRAY['default_transaction_read_only=on', 'statement_timeout=15s']
  THEN
    RAISE EXCEPTION
      'admin_analytics invariant failed: role settings must include default_transaction_read_only=on and statement_timeout=15s, found %',
      v_role_config;
  END IF;

  -- PostgreSQL grants the creating role an ADMIN-only membership; any member
  -- that can SET or INHERIT admin_analytics would read every user's identity.
  SELECT array_agg(member_role.rolname ORDER BY member_role.rolname)
    INTO v_member_names
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE membership.roleid = 'admin_analytics'::regrole
      AND (membership.inherit_option OR membership.set_option);

  IF v_member_names IS NOT NULL THEN
    RAISE EXCEPTION
      'admin_analytics invariant failed: no role may SET or INHERIT admin_analytics, found %',
      array_to_string(v_member_names, ', ');
  END IF;

  -- public.users is read through its column grant, which this loop leaves to
  -- the column check below; a table-level SELECT on it is still a violation.
  FOR v_violation IN
    SELECT relation.oid::regclass AS relation_name, privilege.name AS privilege_name
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN (
        VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
      ) AS privilege(name)
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\_toast%'
        AND (
          pg_catalog.has_table_privilege('admin_analytics', relation.oid, privilege.name)
          OR CASE
            WHEN privilege.name IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              AND NOT (privilege.name = 'SELECT' AND relation.oid = 'public.users'::regclass)
              THEN pg_catalog.has_any_column_privilege('admin_analytics', relation.oid, privilege.name)
            ELSE false
          END
        )
        AND NOT (privilege.name = 'SELECT' AND relation.oid = ANY (v_expected_tables::OID[]))
      ORDER BY 1, 2
  LOOP
    RAISE EXCEPTION
      'admin_analytics invariant failed: unexpected % privilege on %',
      v_violation.privilege_name,
      v_violation.relation_name;
  END LOOP;

  FOR v_violation IN
    SELECT attribute.attname AS column_name,
           attribute.attname = ANY (v_expected_user_columns) AS expected
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.users'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND pg_catalog.has_column_privilege('admin_analytics', attribute.attrelid, attribute.attnum, 'SELECT')
          IS DISTINCT FROM (attribute.attname = ANY (v_expected_user_columns))
      ORDER BY attribute.attnum
  LOOP
    IF v_violation.expected THEN
      RAISE EXCEPTION 'admin_analytics invariant failed: missing SELECT on public.users.%', v_violation.column_name;
    END IF;
    RAISE EXCEPTION 'admin_analytics invariant failed: unexpected SELECT on public.users.%', v_violation.column_name;
  END LOOP;

  FOREACH v_table IN ARRAY v_expected_tables LOOP
    IF NOT pg_catalog.has_table_privilege('admin_analytics', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'admin_analytics invariant failed: missing SELECT on %', v_table;
    END IF;
  END LOOP;

  -- The analytics functions write activity rows as their definer.
  FOR v_violation IN
    SELECT procedure.oid::regprocedure AS function_name
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.pronamespace = 'analytics'::regnamespace
        AND pg_catalog.has_function_privilege('admin_analytics', procedure.oid, 'EXECUTE')
      ORDER BY 1
  LOOP
    RAISE EXCEPTION
      'admin_analytics invariant failed: unexpected EXECUTE privilege on %',
      v_violation.function_name;
  END LOOP;

  PERFORM 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.users'::regclass
      AND policy.polname = 'users_admin_analytics_select'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND policy.polroles = ARRAY['admin_analytics'::regrole::oid]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'admin_analytics invariant failed: public.users must have permissive SELECT policy users_admin_analytics_select for admin_analytics using (true)';
  END IF;
END;
$$;

SET LOCAL lock_timeout = '0';
