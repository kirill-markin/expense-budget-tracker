-- Let the agent SQL roles read budget adjustments of the selected workspace.
--
-- The column list matches what app already reads, so the internal origin
-- marker stays unreadable and neither role gains any write privilege. Row
-- visibility comes only from the forced budget_adjustments_select_access
-- policy, which the invariant below pins together with the grants.

SET LOCAL lock_timeout = '30s';

GRANT SELECT (
  adjustment_id,
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note,
  created_at,
  updated_at
) ON TABLE public.budget_adjustments TO api_sql_reader, api_sql_executor;

DO $$
DECLARE
  v_column_name NAME;
  v_expected_select_expression TEXT;
  v_has_privilege BOOLEAN;
  v_policy RECORD;
  v_privilege_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_role_bypass_rls BOOLEAN;
  v_role_name NAME;
  v_role_superuser BOOLEAN;
  v_select_policy_found BOOLEAN := false;
BEGIN
  SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.budget_adjustments'::regclass;

  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'agent budget_adjustments read invariant failed: row-level security on public.budget_adjustments must be enabled and forced; enabled %, forced %',
      v_rls_enabled,
      v_rls_forced;
  END IF;

  -- Every permissive policy that can admit a SELECT must be the one selected-
  -- workspace membership policy, so no other policy can widen agent reads.
  v_expected_select_expression :=
    '((current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access())';

  FOR v_policy IN
    SELECT
      policy.polname AS policy_name,
      policy.polcmd::TEXT AS command,
      policy.polroles AS role_oids,
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.budget_adjustments'::regclass
      AND policy.polpermissive
      AND policy.polcmd::TEXT IN ('r', '*')
    ORDER BY policy.polname
  LOOP
    IF v_policy.policy_name <> 'budget_adjustments_select_access'
      OR v_policy.command <> 'r'
      OR v_policy.role_oids IS DISTINCT FROM ARRAY[0::OID]
      OR v_policy.using_expression IS DISTINCT FROM v_expected_select_expression
    THEN
      RAISE EXCEPTION
        'agent budget_adjustments read invariant failed: permissive policy % (command %, roles %) admits SELECT with USING %; the only such policy must be budget_adjustments_select_access for PUBLIC with USING %',
        v_policy.policy_name,
        v_policy.command,
        v_policy.role_oids,
        v_policy.using_expression,
        v_expected_select_expression;
    END IF;
    v_select_policy_found := true;
  END LOOP;

  IF NOT v_select_policy_found THEN
    RAISE EXCEPTION
      'agent budget_adjustments read invariant failed: public.budget_adjustments has no budget_adjustments_select_access policy requiring public.current_app_user_has_selected_workspace_access()';
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['api_sql_reader'::NAME, 'api_sql_executor'::NAME]
  LOOP
    SELECT role_record.rolsuper, role_record.rolbypassrls
      INTO v_role_superuser, v_role_bypass_rls
      FROM pg_catalog.pg_roles AS role_record
      WHERE role_record.rolname = v_role_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'agent budget_adjustments read invariant failed: required role % does not exist',
        v_role_name;
    END IF;

    IF v_role_superuser OR v_role_bypass_rls THEN
      RAISE EXCEPTION
        'agent budget_adjustments read invariant failed: role % must be NOSUPERUSER and NOBYPASSRLS so row-level security applies; rolsuper %, rolbypassrls %',
        v_role_name,
        v_role_superuser,
        v_role_bypass_rls;
    END IF;

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
      IF pg_catalog.has_table_privilege(
        v_role_name,
        'public.budget_adjustments',
        v_privilege_name
      )
      THEN
        RAISE EXCEPTION
          'agent budget_adjustments read invariant failed: role % has table-level % privilege on public.budget_adjustments, including inherited or PUBLIC grants; revoke it so only the column-level SELECT grant remains',
          v_role_name,
          v_privilege_name;
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
      v_has_privilege := pg_catalog.has_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        v_column_name,
        'SELECT'
      );
      IF v_has_privilege IS DISTINCT FROM (
        v_column_name = ANY(ARRAY[
          'adjustment_id'::NAME,
          'workspace_id'::NAME,
          'budget_month'::NAME,
          'direction'::NAME,
          'category'::NAME,
          'amount'::NAME,
          'note'::NAME,
          'created_at'::NAME,
          'updated_at'::NAME
        ])
      )
      THEN
        RAISE EXCEPTION
          'agent budget_adjustments read invariant failed: role % has SELECT privilege state % on column %; only the nine app-readable columns may be selectable and origin never',
          v_role_name,
          v_has_privilege,
          v_column_name;
      END IF;

      FOREACH v_privilege_name IN ARRAY ARRAY[
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role_name,
          'public.budget_adjustments',
          v_column_name,
          v_privilege_name
        )
        THEN
          RAISE EXCEPTION
            'agent budget_adjustments read invariant failed: role % has % privilege on column %, including inherited or PUBLIC grants; revoke it because agent roles must never write budget adjustments',
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
