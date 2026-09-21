-- Let the web app issue an agent API key for the browser-authenticated user.
--
-- In AUTH_MODE=proxy_jwt the auth service registers no OTP route, so the only
-- issuing path (POST /api/agent/verify-code) does not exist and the /v1
-- machine API is unreachable. The app role already reads and revokes these
-- rows under the agent_api_keys_app_self_access policy, which constrains every
-- statement to user_id = current_setting('app.user_id'); the INSERT below is
-- covered by the same policy's WITH CHECK clause.

SET LOCAL lock_timeout = '30s';

GRANT INSERT ON TABLE auth.agent_api_keys TO app;

-- Pin the bounds this grant rests on. Row-level security on the table stays
-- enabled and forced; app holds no role membership outside the permitted set
-- listed below, so it cannot act as a role that escapes the policy; the policy
-- set still pins user_id to app.user_id on the INSERT path; and the grant
-- widens nothing beyond app's INSERT, so app keeps exactly SELECT, INSERT and
-- UPDATE here while the restricted SQL roles keep no privilege at all on the
-- credential table and no way to reach the auth schema that contains it.
-- Write paths that do not run as app, SECURITY DEFINER routines and updatable
-- views among them, are outside what this block can see.
DO $$
DECLARE
  -- The memberships the shipped schema grants app, and why each is safe for it
  -- to hold:
  --   app               every role is reported as a member of itself
  --   api_sql_reader    granted by 0066_api_sql_reader.sql
  --   api_sql_executor  granted by 0012_restrict_set_config.sql
  -- Neither restricted SQL role carries an escape of its own: the guard below
  -- keeps every permitted role NOSUPERUSER, NOBYPASSRLS and not the owner of
  -- auth.agent_api_keys, and the assertions at the end of this block keep both
  -- of them without any privilege on that table or on the auth schema.
  c_permitted_memberships CONSTANT NAME[] := ARRAY[
    'app'::NAME,
    'api_sql_reader'::NAME,
    'api_sql_executor'::NAME
  ];
  v_column_name NAME;
  v_escape_reason TEXT;
  v_escape_remediation TEXT;
  v_escape_target RECORD;
  v_expected_app_expression TEXT;
  v_expected_auth_service_expression TEXT;
  v_expected_privilege BOOLEAN;
  v_has_privilege BOOLEAN;
  v_permitted_role RECORD;
  v_policy RECORD;
  v_policy_names_found NAME[] := ARRAY[]::NAME[];
  v_privilege_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_role_name NAME;
  v_schema_privilege_name TEXT;
  v_table_owner_name NAME;
BEGIN
  SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'auth.agent_api_keys'::regclass;

  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'agent API key app INSERT invariant failed: row-level security on auth.agent_api_keys must be enabled and forced; enabled %, forced %',
      v_rls_enabled,
      v_rls_forced;
  END IF;

  -- Enabled and forced row-level security binds nothing for a role that can
  -- act as some other role, and a role that skips the policy can insert a row
  -- carrying any user_id, forging a credential for another account. Naming the
  -- dangerous roles does not hold: superuser and BYPASSRLS roles, auth_service
  -- (the second policy admits it for every row), the table owner, and every
  -- pg_* predefined role -- pg_execute_server_program alone turns COPY ... FROM
  -- PROGRAM into command execution as the server OS user -- each escape in
  -- their own way, and the next such role does not exist yet. So the test is
  -- inverted: app may be a member of nothing outside c_permitted_memberships.
  -- MEMBER is the widest sense of membership, covering inherited privileges,
  -- SET ROLE and admin-option chains alike; migration 0054 already treats
  -- membership as part of this same invariant for app. An operator-managed
  -- database is exactly where app's memberships are not guaranteed, so the
  -- grant above is refused unless app is still subject to the policy.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_record
    WHERE role_record.rolname = 'app'
  )
  THEN
    RAISE EXCEPTION
      'agent API key app INSERT invariant failed: required role app does not exist';
  END IF;

  SELECT relation.relowner::REGROLE::NAME
    INTO v_table_owner_name
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'auth.agent_api_keys'::regclass;

  -- A permitted membership is only permitted while it stays harmless.
  FOR v_permitted_role IN
    SELECT role_record.rolname, role_record.rolsuper, role_record.rolbypassrls
    FROM pg_catalog.pg_roles AS role_record
    WHERE role_record.rolname = ANY (c_permitted_memberships)
    ORDER BY role_record.rolname
  LOOP
    IF v_permitted_role.rolsuper OR v_permitted_role.rolbypassrls THEN
      RAISE EXCEPTION
        'agent API key app INSERT invariant failed: role % is one of the roles app is allowed to act as, so it must be NOSUPERUSER and NOBYPASSRLS for the agent_api_keys_app_self_access policy to still constrain the INSERT granted here; rolsuper %, rolbypassrls %. Run ALTER ROLE % NOSUPERUSER NOBYPASSRLS, then re-run this migration',
        v_permitted_role.rolname,
        v_permitted_role.rolsuper,
        v_permitted_role.rolbypassrls,
        pg_catalog.quote_ident(v_permitted_role.rolname);
    END IF;

    IF v_permitted_role.rolname = v_table_owner_name THEN
      RAISE EXCEPTION
        'agent API key app INSERT invariant failed: role % is one of the roles app is allowed to act as and owns auth.agent_api_keys, so app could drop the policy or run ALTER TABLE auth.agent_api_keys NO FORCE ROW LEVEL SECURITY. Reassign auth.agent_api_keys to a role app cannot act as, then re-run this migration',
        v_permitted_role.rolname;
    END IF;
  END LOOP;

  FOR v_escape_target IN
    SELECT role_record.rolname
    FROM pg_catalog.pg_roles AS role_record
    WHERE NOT (role_record.rolname = ANY (c_permitted_memberships))
      AND pg_catalog.pg_has_role('app'::NAME, role_record.oid, 'MEMBER')
    -- Only the first offender is reported, so the two roles with a bespoke
    -- explanation are reported ahead of the generic ones.
    ORDER BY
      (
        role_record.rolname = 'auth_service'
        OR role_record.rolname = v_table_owner_name
      ) DESC,
      role_record.rolname
  LOOP
    IF v_escape_target.rolname = 'auth_service' THEN
      v_escape_reason :=
        'the agent_api_keys_auth_service_access policy admits that role for every row, which would let app insert a key carrying any user_id and read every user''s rows';
      v_escape_remediation :=
        'Run REVOKE auth_service FROM app, or revoke the intermediate membership that reaches it, then re-run this migration';
    ELSIF v_escape_target.rolname = v_table_owner_name THEN
      v_escape_reason :=
        'that role owns auth.agent_api_keys and can therefore drop the policy or run ALTER TABLE auth.agent_api_keys NO FORCE ROW LEVEL SECURITY';
      v_escape_remediation := pg_catalog.format(
        'Revoke the membership that reaches %I, directly or through a chain, or reassign auth.agent_api_keys to a role app cannot act as, then re-run this migration',
        v_escape_target.rolname
      );
    ELSE
      v_escape_reason :=
        'no migration grants app that membership, and a role reached this way carries whatever the operator gave it -- superuser or BYPASSRLS, privileges on the credential table, or an OS-level capability such as pg_execute_server_program -- any of which writes a row with any user_id';
      v_escape_remediation := pg_catalog.format(
        'Run REVOKE %I FROM app, or revoke the intermediate membership that reaches it, then re-run this migration',
        v_escape_target.rolname
      );
    END IF;

    RAISE EXCEPTION
      'agent API key app INSERT invariant failed: role app can act as role %, which escapes the agent_api_keys_app_self_access policy because %. %',
      v_escape_target.rolname,
      v_escape_reason,
      v_escape_remediation;
  END LOOP;

  -- The policy set is the other half of the bound: app's own policy must still
  -- pin user_id to app.user_id on every statement, including the WITH CHECK
  -- clause the new INSERT passes through, and no second permissive policy may
  -- admit a wider INSERT alongside it.
  v_expected_app_expression :=
    '((CURRENT_USER = ''app''::name) AND (user_id = current_setting(''app.user_id''::text, true)))';
  v_expected_auth_service_expression := '(CURRENT_USER = ''auth_service''::name)';

  FOR v_policy IN
    SELECT
      policy.polname AS policy_name,
      policy.polcmd::TEXT AS command,
      policy.polroles AS role_oids,
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'auth.agent_api_keys'::regclass
      AND policy.polpermissive
    ORDER BY policy.polname
  LOOP
    IF v_policy.role_oids IS DISTINCT FROM ARRAY[0::OID] THEN
      RAISE EXCEPTION
        'agent API key app INSERT invariant failed: permissive policy % applies to roles % instead of PUBLIC. Restore the policies as db/migrations/0018_agent_auth.sql creates them, then re-run this migration',
        v_policy.policy_name,
        v_policy.role_oids;
    END IF;

    IF NOT (
      (
        v_policy.policy_name = 'agent_api_keys_app_self_access'
        AND v_policy.command = '*'
        AND v_policy.using_expression IS NOT DISTINCT FROM v_expected_app_expression
        AND v_policy.check_expression IS NOT DISTINCT FROM v_expected_app_expression
      )
      OR (
        v_policy.policy_name = 'agent_api_keys_auth_service_access'
        AND v_policy.command = '*'
        AND v_policy.using_expression IS NOT DISTINCT FROM v_expected_auth_service_expression
        AND v_policy.check_expression IS NOT DISTINCT FROM v_expected_auth_service_expression
      )
    )
    THEN
      RAISE EXCEPTION
        'agent API key app INSERT invariant failed: permissive policy % (command %) has USING % and WITH CHECK %; expected agent_api_keys_app_self_access FOR ALL requiring % or agent_api_keys_auth_service_access FOR ALL requiring %. Restore the policies as db/migrations/0018_agent_auth.sql creates them, then re-run this migration',
        v_policy.policy_name,
        v_policy.command,
        v_policy.using_expression,
        v_policy.check_expression,
        v_expected_app_expression,
        v_expected_auth_service_expression;
    END IF;

    v_policy_names_found := v_policy_names_found || v_policy.policy_name;
  END LOOP;

  IF v_policy_names_found IS DISTINCT FROM ARRAY[
    'agent_api_keys_app_self_access'::NAME,
    'agent_api_keys_auth_service_access'::NAME
  ]
  THEN
    RAISE EXCEPTION
      'agent API key app INSERT invariant failed: auth.agent_api_keys has permissive policies %; expected exactly agent_api_keys_app_self_access and agent_api_keys_auth_service_access. Restore the policies as db/migrations/0018_agent_auth.sql creates them, then re-run this migration',
      v_policy_names_found;
  END IF;

  -- app gains INSERT and keeps SELECT and UPDATE from migration 0018. It must
  -- hold nothing else: no DELETE, so a key can only ever be revoked, never
  -- erased, and no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
  FOREACH v_privilege_name IN ARRAY ARRAY[
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
    'MAINTAIN'
  ]
  LOOP
    v_has_privilege := pg_catalog.has_table_privilege(
      'app'::NAME,
      'auth.agent_api_keys',
      v_privilege_name
    );
    v_expected_privilege := v_privilege_name IN ('SELECT', 'INSERT', 'UPDATE');

    IF v_has_privilege IS DISTINCT FROM v_expected_privilege THEN
      RAISE EXCEPTION
        'agent API key app INSERT invariant failed: role app has table-level % privilege state % on auth.agent_api_keys, expected %; app may hold exactly SELECT, INSERT and UPDATE',
        v_privilege_name,
        v_has_privilege,
        v_expected_privilege;
    END IF;
  END LOOP;

  -- A column grant does not show at table level, so the column form is checked
  -- too: INSERT must be whole-table, and REFERENCES must be absent everywhere.
  FOR v_column_name IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.agent_api_keys'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  LOOP
    FOREACH v_privilege_name IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'REFERENCES'
    ]
    LOOP
      v_has_privilege := pg_catalog.has_column_privilege(
        'app'::NAME,
        'auth.agent_api_keys',
        v_column_name,
        v_privilege_name
      );
      v_expected_privilege := v_privilege_name IN ('SELECT', 'INSERT', 'UPDATE');

      IF v_has_privilege IS DISTINCT FROM v_expected_privilege THEN
        RAISE EXCEPTION
          'agent API key app INSERT invariant failed: role app has % privilege state % on column %, expected %',
          v_privilege_name,
          v_has_privilege,
          v_column_name,
          v_expected_privilege;
      END IF;
    END LOOP;
  END LOOP;

  -- The restricted SQL roles that run agent-authored statements must remain
  -- unable to see or touch credentials, at table level, at column level, and
  -- at the schema that holds the table.
  FOREACH v_role_name IN ARRAY ARRAY['api_sql_reader'::NAME, 'api_sql_executor'::NAME]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_record
      WHERE role_record.rolname = v_role_name
    )
    THEN
      RAISE EXCEPTION
        'agent API key app INSERT invariant failed: required role % does not exist',
        v_role_name;
    END IF;

    FOREACH v_schema_privilege_name IN ARRAY ARRAY['USAGE', 'CREATE']
    LOOP
      IF pg_catalog.has_schema_privilege(v_role_name, 'auth', v_schema_privilege_name) THEN
        RAISE EXCEPTION
          'agent API key app INSERT invariant failed: role % has % on schema auth, including inherited or PUBLIC grants; the restricted SQL roles must not be able to reach the auth schema',
          v_role_name,
          v_schema_privilege_name;
      END IF;
    END LOOP;

    FOREACH v_privilege_name IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN'
    ]
    LOOP
      IF pg_catalog.has_table_privilege(v_role_name, 'auth.agent_api_keys', v_privilege_name) THEN
        RAISE EXCEPTION
          'agent API key app INSERT invariant failed: role % has table-level % privilege on auth.agent_api_keys, including inherited or PUBLIC grants; the restricted SQL roles must hold no privilege on the credential table',
          v_role_name,
          v_privilege_name;
      END IF;
    END LOOP;

    FOR v_column_name IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'auth.agent_api_keys'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege_name IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role_name,
          'auth.agent_api_keys',
          v_column_name,
          v_privilege_name
        )
        THEN
          RAISE EXCEPTION
            'agent API key app INSERT invariant failed: role % has % privilege on column % of auth.agent_api_keys, including inherited or PUBLIC grants',
            v_role_name,
            v_privilege_name,
            v_column_name;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
