-- Allow the trusted web application to persist client-generated adjustment IDs
-- without broadening table access or exposing budget adjustments to SQL clients.

SET LOCAL lock_timeout = '30s';

GRANT INSERT (adjustment_id)
  ON TABLE public.budget_adjustments
  TO app;

DO $$
DECLARE
  v_column_name NAME;
  v_has_privilege BOOLEAN;
  v_privilege_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
BEGIN
  SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.budget_adjustments'::regclass;

  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'budget adjustment client ID grant invariant failed: row-level security must remain enabled and forced';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
    'app',
    'public.budget_adjustments',
    'adjustment_id',
    'INSERT'
  )
  THEN
    RAISE EXCEPTION
      'budget adjustment client ID grant invariant failed: app must have INSERT privilege on adjustment_id';
  END IF;

  IF pg_catalog.has_table_privilege(
    'app',
    'public.budget_adjustments',
    'INSERT'
  )
  THEN
    RAISE EXCEPTION
      'budget adjustment client ID grant invariant failed: app must not have table-level INSERT privilege';
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
      'api_sql_executor',
      'public.budget_adjustments',
      v_privilege_name
    )
    THEN
      RAISE EXCEPTION
        'budget adjustment client ID grant invariant failed: api_sql_executor has unexpected table-level % privilege',
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
      'app',
      'public.budget_adjustments',
      v_column_name,
      'INSERT'
    );
    IF v_has_privilege IS DISTINCT FROM (
      v_column_name = ANY(ARRAY[
        'adjustment_id'::NAME,
        'workspace_id'::NAME,
        'budget_month'::NAME,
        'direction'::NAME,
        'category'::NAME,
        'amount'::NAME,
        'note'::NAME
      ])
    )
    THEN
      RAISE EXCEPTION
        'budget adjustment client ID grant invariant failed: app has unexpected INSERT privilege state % on column %',
        v_has_privilege,
        v_column_name;
    END IF;

    FOREACH v_privilege_name IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'REFERENCES'
    ]
    LOOP
      IF pg_catalog.has_column_privilege(
        'api_sql_executor',
        'public.budget_adjustments',
        v_column_name,
        v_privilege_name
      )
      THEN
        RAISE EXCEPTION
          'budget adjustment client ID grant invariant failed: api_sql_executor has unexpected % privilege on column %',
          v_privilege_name,
          v_column_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
