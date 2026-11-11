-- Read-only login role for the owner's investigations of production chats.
--
-- admin_reader reads every user's rows in exactly the tables below and nothing
-- else. It does not bypass row level security: each table gets its own
-- permissive SELECT policy for this role, so access stays visible in pg_policy
-- and no other policy changes. Its sessions default to read-only transactions.
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
  WHERE rolname = 'admin_reader';

  IF NOT FOUND THEN
    CREATE ROLE admin_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
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
      MESSAGE = 'Existing role admin_reader violates least-privilege requirements.',
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
      HINT = 'Have a database administrator repair or replace admin_reader with the expected attributes, then rerun migration 0089_admin_reader_role.sql.';
  ELSE
    SELECT array_agg(parent_role.rolname ORDER BY parent_role.rolname)
    INTO parent_role_names
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS parent_role
      ON parent_role.oid = membership.roleid
    WHERE membership.member = existing_role.oid;

    IF parent_role_names IS NOT NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = 'Existing role admin_reader has unexpected outgoing role memberships.',
        DETAIL = format(
          'Expected no parent roles; actual parent roles: %s.',
          array_to_string(parent_role_names, ', ')
        ),
        HINT = 'Have a database administrator revoke each listed parent role from admin_reader, then rerun migration 0089_admin_reader_role.sql.';
    END IF;
  END IF;
END
$$;

ALTER ROLE admin_reader SET default_transaction_read_only = on;
ALTER ROLE admin_reader SET statement_timeout = '30s';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO admin_reader', current_database());
END
$$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM admin_reader;

GRANT USAGE ON SCHEMA public TO admin_reader;
GRANT SELECT ON TABLE
  public.users,
  public.workspaces,
  public.workspace_members,
  public.chat_sessions,
  public.chat_items,
  public.chat_files,
  public.llm_telemetry_spans
TO admin_reader;

CREATE POLICY users_admin_reader_select
  ON public.users FOR SELECT TO admin_reader USING (true);
CREATE POLICY workspaces_admin_reader_select
  ON public.workspaces FOR SELECT TO admin_reader USING (true);
CREATE POLICY workspace_members_admin_reader_select
  ON public.workspace_members FOR SELECT TO admin_reader USING (true);
CREATE POLICY chat_sessions_admin_reader_select
  ON public.chat_sessions FOR SELECT TO admin_reader USING (true);
CREATE POLICY chat_items_admin_reader_select
  ON public.chat_items FOR SELECT TO admin_reader USING (true);
CREATE POLICY chat_files_admin_reader_select
  ON public.chat_files FOR SELECT TO admin_reader USING (true);
CREATE POLICY llm_telemetry_spans_admin_reader_select
  ON public.llm_telemetry_spans FOR SELECT TO admin_reader USING (true);

-- Verify before commit, so a role that can read more, or write anything,
-- cannot be recorded as applied.
DO $$
DECLARE
  v_expected_tables REGCLASS[] := ARRAY[
    'public.users',
    'public.workspaces',
    'public.workspace_members',
    'public.chat_sessions',
    'public.chat_items',
    'public.chat_files',
    'public.llm_telemetry_spans'
  ]::REGCLASS[];
  v_role_config TEXT[];
  v_member_names NAME[];
  v_violation RECORD;
  v_table REGCLASS;
BEGIN
  SELECT rolconfig INTO v_role_config FROM pg_catalog.pg_roles WHERE rolname = 'admin_reader';

  IF v_role_config IS NULL
    OR NOT v_role_config @> ARRAY['default_transaction_read_only=on', 'statement_timeout=30s']
  THEN
    RAISE EXCEPTION
      'admin_reader invariant failed: role settings must include default_transaction_read_only=on and statement_timeout=30s, found %',
      v_role_config;
  END IF;

  -- PostgreSQL grants the creating role an ADMIN-only membership; any member
  -- that can SET or INHERIT admin_reader would read every user's chats.
  SELECT array_agg(member_role.rolname ORDER BY member_role.rolname)
    INTO v_member_names
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE membership.roleid = 'admin_reader'::regrole
      AND (membership.inherit_option OR membership.set_option);

  IF v_member_names IS NOT NULL THEN
    RAISE EXCEPTION
      'admin_reader invariant failed: no role may SET or INHERIT admin_reader, found %',
      array_to_string(v_member_names, ', ');
  END IF;

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
          pg_catalog.has_table_privilege('admin_reader', relation.oid, privilege.name)
          OR CASE
            WHEN privilege.name IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              THEN pg_catalog.has_any_column_privilege('admin_reader', relation.oid, privilege.name)
            ELSE false
          END
        )
        AND NOT (privilege.name = 'SELECT' AND relation.oid = ANY (v_expected_tables::OID[]))
      ORDER BY 1, 2
  LOOP
    RAISE EXCEPTION
      'admin_reader invariant failed: unexpected % privilege on %',
      v_violation.privilege_name,
      v_violation.relation_name;
  END LOOP;

  FOREACH v_table IN ARRAY v_expected_tables LOOP
    IF NOT pg_catalog.has_table_privilege('admin_reader', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'admin_reader invariant failed: missing SELECT on %', v_table;
    END IF;

    PERFORM 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_table
        AND policy.polcmd = 'r'
        AND policy.polpermissive
        AND policy.polroles = ARRAY['admin_reader'::regrole::oid]
        AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true';

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'admin_reader invariant failed: % must have a permissive SELECT policy for admin_reader using (true)',
        v_table;
    END IF;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
