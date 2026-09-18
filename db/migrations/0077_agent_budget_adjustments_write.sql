-- Let the agent SQL executor write budget adjustments of the selected workspace.
--
-- budget_adjustments becomes an ordinary agent-writable relation, like
-- ledger_entries and budget_lines: api_sql_executor receives the column grants
-- the app holds, minus the internal origin marker and minus the
-- INSERT (adjustment_id) grant that migration 0056 gave the web app for
-- client-generated identifiers, so agent rows keep the 'user' origin default
-- and the database-generated adjustment_id, and origin stays unreadable and
-- unwritable. Withholding adjustment_id is deliberate: the invariant at the end
-- pins its absence, so granting it to the executor fails this migration.
-- api_sql_reader keeps its column-level SELECT only. Migration 0054 already
-- recreated the UPDATE and DELETE policies without an origin term, so the
-- legacy rows imported by the 0053-0056 series were never frozen against a
-- plain UPDATE or DELETE; the last origin = 'user' term lived in
-- budget_adjustments_insert_access, where it only forced every new row to be
-- user-origin, and this migration removes it. All three mutation policies are
-- recreated together so they state the same terms. Workspace isolation keeps
-- resting only on the selected-workspace membership terms of the policies
-- below, never on the absence of a grant; the invariant at the end pins both
-- together.

SET LOCAL lock_timeout = '30s';

GRANT INSERT (
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note
) ON TABLE public.budget_adjustments TO api_sql_executor;

GRANT UPDATE (
  budget_month,
  direction,
  category,
  amount,
  note
) ON TABLE public.budget_adjustments TO api_sql_executor;

GRANT DELETE ON TABLE public.budget_adjustments TO api_sql_executor;

DROP POLICY budget_adjustments_insert_access
  ON public.budget_adjustments;
DROP POLICY budget_adjustments_update_access
  ON public.budget_adjustments;
DROP POLICY budget_adjustments_delete_access
  ON public.budget_adjustments;

CREATE POLICY budget_adjustments_insert_access
  ON public.budget_adjustments
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_adjustments_update_access
  ON public.budget_adjustments
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_adjustments_delete_access
  ON public.budget_adjustments
  AS PERMISSIVE
  FOR DELETE
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

-- The opposite of the invariant of migration 0074: agent writes are expected
-- now, so the block pins the exact grants that carry them, the internal origin
-- column that stays outside every grant, and the policies that keep every read
-- and every write inside the selected workspace.
DO $$
DECLARE
  v_column_name NAME;
  v_expected_privilege BOOLEAN;
  v_expected_workspace_expression TEXT;
  v_has_privilege BOOLEAN;
  v_insert_columns NAME[] := ARRAY[
    'workspace_id'::NAME,
    'budget_month'::NAME,
    'direction'::NAME,
    'category'::NAME,
    'amount'::NAME,
    'note'::NAME
  ];
  v_policy RECORD;
  v_policy_names_found NAME[] := ARRAY[]::NAME[];
  v_privilege_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_role_bypass_rls BOOLEAN;
  v_role_name NAME;
  v_role_superuser BOOLEAN;
  v_select_columns NAME[] := ARRAY[
    'adjustment_id'::NAME,
    'workspace_id'::NAME,
    'budget_month'::NAME,
    'direction'::NAME,
    'category'::NAME,
    'amount'::NAME,
    'note'::NAME,
    'created_at'::NAME,
    'updated_at'::NAME
  ];
  v_update_columns NAME[] := ARRAY[
    'budget_month'::NAME,
    'direction'::NAME,
    'category'::NAME,
    'amount'::NAME,
    'note'::NAME
  ];
BEGIN
  SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.budget_adjustments'::regclass;

  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'agent budget_adjustments write invariant failed: row-level security on public.budget_adjustments must be enabled and forced; enabled %, forced %',
      v_rls_enabled,
      v_rls_forced;
  END IF;

  -- Every permissive policy of the table must be one of the four
  -- selected-workspace membership policies, so no policy can admit a read or a
  -- write outside the selected workspace and none carries an origin term.
  v_expected_workspace_expression :=
    '((current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access())';

  FOR v_policy IN
    SELECT
      policy.polname AS policy_name,
      policy.polcmd::TEXT AS command,
      policy.polroles AS role_oids,
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.budget_adjustments'::regclass
      AND policy.polpermissive
    ORDER BY policy.polname
  LOOP
    IF v_policy.role_oids IS DISTINCT FROM ARRAY[0::OID] THEN
      RAISE EXCEPTION
        'agent budget_adjustments write invariant failed: permissive policy % applies to roles % instead of PUBLIC',
        v_policy.policy_name,
        v_policy.role_oids;
    END IF;

    IF NOT (
      (
        v_policy.policy_name = 'budget_adjustments_select_access'
        AND v_policy.command = 'r'
        AND v_policy.using_expression IS NOT DISTINCT FROM v_expected_workspace_expression
        AND v_policy.check_expression IS NULL
      )
      OR (
        v_policy.policy_name = 'budget_adjustments_insert_access'
        AND v_policy.command = 'a'
        AND v_policy.using_expression IS NULL
        AND v_policy.check_expression IS NOT DISTINCT FROM v_expected_workspace_expression
      )
      OR (
        v_policy.policy_name = 'budget_adjustments_update_access'
        AND v_policy.command = 'w'
        AND v_policy.using_expression IS NOT DISTINCT FROM v_expected_workspace_expression
        AND v_policy.check_expression IS NOT DISTINCT FROM v_expected_workspace_expression
      )
      OR (
        v_policy.policy_name = 'budget_adjustments_delete_access'
        AND v_policy.command = 'd'
        AND v_policy.using_expression IS NOT DISTINCT FROM v_expected_workspace_expression
        AND v_policy.check_expression IS NULL
      )
    )
    THEN
      RAISE EXCEPTION
        'agent budget_adjustments write invariant failed: permissive policy % (command %) has USING % and WITH CHECK %; expected one of the four budget_adjustments access policies requiring %',
        v_policy.policy_name,
        v_policy.command,
        v_policy.using_expression,
        v_policy.check_expression,
        v_expected_workspace_expression;
    END IF;

    v_policy_names_found := v_policy_names_found || v_policy.policy_name;
  END LOOP;

  IF v_policy_names_found IS DISTINCT FROM ARRAY[
    'budget_adjustments_delete_access'::NAME,
    'budget_adjustments_insert_access'::NAME,
    'budget_adjustments_select_access'::NAME,
    'budget_adjustments_update_access'::NAME
  ]
  THEN
    RAISE EXCEPTION
      'agent budget_adjustments write invariant failed: public.budget_adjustments has permissive policies %; expected exactly budget_adjustments_select_access, budget_adjustments_insert_access, budget_adjustments_update_access and budget_adjustments_delete_access',
      v_policy_names_found;
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['api_sql_reader'::NAME, 'api_sql_executor'::NAME]
  LOOP
    SELECT role_record.rolsuper, role_record.rolbypassrls
      INTO v_role_superuser, v_role_bypass_rls
      FROM pg_catalog.pg_roles AS role_record
      WHERE role_record.rolname = v_role_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'agent budget_adjustments write invariant failed: required role % does not exist',
        v_role_name;
    END IF;

    IF v_role_superuser OR v_role_bypass_rls THEN
      RAISE EXCEPTION
        'agent budget_adjustments write invariant failed: role % must be NOSUPERUSER and NOBYPASSRLS so row-level security applies; rolsuper %, rolbypassrls %',
        v_role_name,
        v_role_superuser,
        v_role_bypass_rls;
    END IF;

    -- The internal origin marker stays outside every grant, so neither role can
    -- read it, set it on INSERT, or change it on UPDATE.
    FOREACH v_privilege_name IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'REFERENCES'
    ]
    LOOP
      IF pg_catalog.has_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        'origin',
        v_privilege_name
      )
      THEN
        RAISE EXCEPTION
          'agent budget_adjustments write invariant failed: role % has % privilege on the internal budget_adjustments.origin column, including inherited or PUBLIC grants; revoke it because agent roles must never read or write the origin marker',
          v_role_name,
          v_privilege_name;
      END IF;
    END LOOP;

    -- DELETE has no column form, so it is the only table-level privilege either
    -- role may hold, and only api_sql_executor may hold it. Every other
    -- privilege must come from a column grant.
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
        v_role_name,
        'public.budget_adjustments',
        v_privilege_name
      );
      v_expected_privilege :=
        v_role_name = 'api_sql_executor' AND v_privilege_name = 'DELETE';

      IF v_has_privilege IS DISTINCT FROM v_expected_privilege THEN
        RAISE EXCEPTION
          'agent budget_adjustments write invariant failed: role % has table-level % privilege state % on public.budget_adjustments, expected %; only api_sql_executor may hold table-level DELETE and every other privilege must be a column grant',
          v_role_name,
          v_privilege_name,
          v_has_privilege,
          v_expected_privilege;
      END IF;
    END LOOP;

    FOR v_column_name IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.budget_adjustments'::regclass
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
          v_role_name,
          'public.budget_adjustments',
          v_column_name,
          v_privilege_name
        );
        v_expected_privilege := CASE v_privilege_name
          WHEN 'SELECT' THEN v_column_name = ANY(v_select_columns)
          WHEN 'INSERT' THEN
            v_role_name = 'api_sql_executor' AND v_column_name = ANY(v_insert_columns)
          WHEN 'UPDATE' THEN
            v_role_name = 'api_sql_executor' AND v_column_name = ANY(v_update_columns)
          ELSE false
        END;

        IF v_has_privilege IS DISTINCT FROM v_expected_privilege THEN
          RAISE EXCEPTION
            'agent budget_adjustments write invariant failed: role % has % privilege state % on column %, expected %; api_sql_reader keeps the nine app-readable columns as SELECT only, api_sql_executor adds INSERT on % and UPDATE on %, and neither role may reference any column',
            v_role_name,
            v_privilege_name,
            v_has_privilege,
            v_column_name,
            v_expected_privilege,
            v_insert_columns,
            v_update_columns;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Deliberately outside the loop above, because the app role keeps its own
  -- read and write grants on this table and only its expectation for the
  -- internal origin marker is asserted here. The INSERT policy recreated above
  -- no longer carries origin = 'user', the last check that made a
  -- legacy-origin INSERT impossible for every non-owner role regardless of
  -- grants, so the absence of this column grant is now the only thing that
  -- keeps the web app from minting legacy rows.
  FOREACH v_privilege_name IN ARRAY ARRAY[
    'SELECT',
    'INSERT',
    'UPDATE',
    'REFERENCES'
  ]
  LOOP
    IF pg_catalog.has_column_privilege(
      'app'::NAME,
      'public.budget_adjustments',
      'origin',
      v_privilege_name
    )
    THEN
      RAISE EXCEPTION
        'agent budget_adjustments write invariant failed: role app has % privilege on the internal budget_adjustments.origin column, including inherited or PUBLIC grants; revoke it because only the table owner may set the origin marker',
        v_privilege_name;
    END IF;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
