-- Add the normalized budget adjustments schema without changing legacy writes.

-- Forced RLS also applies to a NOSUPERUSER/NOBYPASSRLS table owner. Install
-- transaction-scoped read policies so the migration can report legacy orphan
-- rows before establishing the new workspace foreign key.
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_comments_adjustments_0053_orphan_read
       ON public.budget_comments
       FOR SELECT
       TO %I
       USING (true)',
    current_user
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_adjustments_0053_orphan_read
       ON public.budget_lines
       FOR SELECT
       TO %I
       USING (true)',
    current_user
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY workspaces_adjustments_0053_orphan_read
       ON public.workspaces
       FOR SELECT
       TO %I
       USING (true)',
    current_user
  );
END;
$$;

DO $$
DECLARE
  v_orphan RECORD;
BEGIN
  WITH legacy_workspace_references AS (
    SELECT
      'budget_comments'::TEXT AS source_table,
      comment.workspace_id,
      comment.budget_month,
      comment.direction,
      comment.category
    FROM public.budget_comments AS comment

    UNION ALL

    SELECT
      'budget_lines'::TEXT AS source_table,
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category
    FROM public.budget_lines AS line
  )
  SELECT
    reference.source_table,
    reference.workspace_id,
    reference.budget_month,
    reference.direction,
    reference.category
    INTO v_orphan
    FROM legacy_workspace_references AS reference
    LEFT JOIN public.workspaces AS workspace
      ON workspace.workspace_id = reference.workspace_id
    WHERE workspace.workspace_id IS NULL
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments workspace foreign key precondition failed: legacy table % references missing workspace % at month %, direction %, category %; restore the workspace or remove the orphaned legacy row before retrying migration 0053',
      v_orphan.source_table,
      v_orphan.workspace_id,
      v_orphan.budget_month,
      v_orphan.direction,
      v_orphan.category;
  END IF;
END;
$$;

DROP POLICY budget_comments_adjustments_0053_orphan_read
  ON public.budget_comments;
DROP POLICY budget_lines_adjustments_0053_orphan_read
  ON public.budget_lines;
DROP POLICY workspaces_adjustments_0053_orphan_read
  ON public.workspaces;

SET LOCAL lock_timeout = '0';

CREATE TABLE public.budget_adjustments (
  adjustment_id TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  workspace_id  TEXT        NOT NULL,
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  amount        NUMERIC     NOT NULL,
  note          TEXT,
  origin        TEXT        NOT NULL DEFAULT 'user',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT budget_adjustments_pkey
    PRIMARY KEY (adjustment_id),
  CONSTRAINT budget_adjustments_workspace_id_fkey
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT budget_adjustments_budget_month_check
    CHECK (EXTRACT(DAY FROM budget_month) = 1),
  CONSTRAINT budget_adjustments_direction_check
    CHECK (direction IN ('income', 'spend')),
  CONSTRAINT budget_adjustments_category_check
    CHECK (char_length(category) <= 200),
  CONSTRAINT budget_adjustments_note_check
    CHECK (char_length(note) <= 2000),
  CONSTRAINT budget_adjustments_origin_check
    CHECK (origin IN ('user', 'legacy')),
  CONSTRAINT budget_adjustments_amount_check
    CHECK (
      amount NOT IN (
        'NaN'::NUMERIC,
        'Infinity'::NUMERIC,
        '-Infinity'::NUMERIC
      )
      AND (origin = 'legacy' OR amount = trunc(amount))
    )
);

CREATE UNIQUE INDEX budget_adjustments_legacy_cell_idx
  ON public.budget_adjustments (
    workspace_id,
    budget_month,
    direction,
    category
  )
  WHERE origin = 'legacy';

CREATE INDEX budget_adjustments_grid_idx
  ON public.budget_adjustments (
    workspace_id,
    budget_month,
    direction,
    category,
    created_at DESC,
    adjustment_id
  )
  INCLUDE (amount);

ALTER TABLE public.budget_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_adjustments FORCE ROW LEVEL SECURITY;

CREATE POLICY budget_adjustments_select_access
  ON public.budget_adjustments
  FOR SELECT
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_adjustments_insert_access
  ON public.budget_adjustments
  FOR INSERT
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND origin = 'user'
  );

CREATE POLICY budget_adjustments_update_access
  ON public.budget_adjustments
  FOR UPDATE
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND origin = 'user'
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND origin = 'user'
  );

CREATE POLICY budget_adjustments_delete_access
  ON public.budget_adjustments
  FOR DELETE
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND origin = 'user'
  );

REVOKE ALL ON TABLE public.budget_adjustments FROM PUBLIC;
REVOKE ALL ON TABLE public.budget_adjustments FROM app;
REVOKE ALL ON TABLE public.budget_adjustments FROM api_sql_executor;

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
) ON TABLE public.budget_adjustments TO app, api_sql_executor;

GRANT INSERT (
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note
) ON TABLE public.budget_adjustments TO app, api_sql_executor;

GRANT UPDATE (
  budget_month,
  direction,
  category,
  amount,
  note
) ON TABLE public.budget_adjustments TO app, api_sql_executor;

GRANT DELETE ON TABLE public.budget_adjustments TO app, api_sql_executor;

CREATE FUNCTION public.set_budget_adjustment_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_budget_adjustment_updated_at() FROM PUBLIC;

CREATE TRIGGER budget_adjustments_set_updated_at
  BEFORE UPDATE ON public.budget_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_budget_adjustment_updated_at();

-- Verify the new relation, foreign key, policies, and grants before commit.
DO $$
DECLARE
  v_owner_name NAME;
  v_owner_oid OID;
  v_policy RECORD;
  v_policy_count INTEGER;
  v_policy_expression TEXT;
  v_role_name NAME;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
BEGIN
  SELECT
    relation.relrowsecurity,
    relation.relforcerowsecurity,
    relation.relowner,
    pg_catalog.pg_get_userbyid(relation.relowner)
    INTO v_rls_enabled, v_rls_forced, v_owner_oid, v_owner_name
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.budget_adjustments'::regclass;

  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'budget_adjustments RLS invariant failed: row-level security must be enabled and forced';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS foreign_key
    WHERE foreign_key.conrelid = 'public.budget_adjustments'::regclass
      AND foreign_key.conname = 'budget_adjustments_workspace_id_fkey'
      AND foreign_key.contype = 'f'
      AND foreign_key.confrelid = 'public.workspaces'::regclass
      AND foreign_key.confdeltype = 'c'
      AND foreign_key.convalidated
  )
  THEN
    RAISE EXCEPTION
      'budget_adjustments foreign key invariant failed: workspace_id must reference public.workspaces(workspace_id) with ON DELETE CASCADE';
  END IF;

  SELECT COUNT(*)::INTEGER
    INTO v_policy_count
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.budget_adjustments'::regclass;

  IF v_policy_count <> 4 THEN
    RAISE EXCEPTION
      'budget_adjustments RLS invariant failed: expected 4 workspace policies, found %',
      v_policy_count;
  END IF;

  FOR v_policy IN
    SELECT
      policy.polname,
      policy.polcmd,
      policy.polroles,
      pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid
      ) AS using_expression,
      pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid
      ) AS check_expression
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.budget_adjustments'::regclass
  LOOP
    IF v_policy.polroles <> ARRAY[0::OID] THEN
      RAISE EXCEPTION
        'budget_adjustments RLS invariant failed: policy % must apply to PUBLIC',
        v_policy.polname;
    END IF;

    IF (v_policy.polname = 'budget_adjustments_select_access'
        AND (
          v_policy.polcmd <> 'r'
          OR v_policy.using_expression IS NULL
          OR v_policy.check_expression IS NOT NULL
        ))
      OR (v_policy.polname = 'budget_adjustments_insert_access'
        AND (
          v_policy.polcmd <> 'a'
          OR v_policy.using_expression IS NOT NULL
          OR v_policy.check_expression IS NULL
        ))
      OR (v_policy.polname = 'budget_adjustments_update_access'
        AND (
          v_policy.polcmd <> 'w'
          OR v_policy.using_expression IS NULL
          OR v_policy.check_expression IS NULL
        ))
      OR (v_policy.polname = 'budget_adjustments_delete_access'
        AND (
          v_policy.polcmd <> 'd'
          OR v_policy.using_expression IS NULL
          OR v_policy.check_expression IS NOT NULL
        ))
      OR v_policy.polname NOT IN (
        'budget_adjustments_select_access',
        'budget_adjustments_insert_access',
        'budget_adjustments_update_access',
        'budget_adjustments_delete_access'
      )
    THEN
      RAISE EXCEPTION
        'budget_adjustments RLS invariant failed: policy % has unexpected command or expressions',
        v_policy.polname;
    END IF;

    FOREACH v_policy_expression IN ARRAY ARRAY[
      v_policy.using_expression,
      v_policy.check_expression
    ]
    LOOP
      IF v_policy_expression IS NOT NULL
        AND (
          POSITION(
            'current_setting(''app.workspace_id''::text, true)'
            IN v_policy_expression
          ) = 0
          OR POSITION(
            'current_app_user_has_selected_workspace_access()'
            IN v_policy_expression
          ) = 0
        )
      THEN
        RAISE EXCEPTION
          'budget_adjustments RLS invariant failed: policy % does not enforce selected-workspace membership in expression %',
          v_policy.polname,
          v_policy_expression;
      END IF;

      IF v_policy.polname <> 'budget_adjustments_select_access'
        AND v_policy_expression IS NOT NULL
        AND POSITION(
          'origin = ''user''::text'
          IN v_policy_expression
        ) = 0
      THEN
        RAISE EXCEPTION
          'budget_adjustments RLS invariant failed: mutation policy % does not protect legacy-origin rows in expression %',
          v_policy.polname,
          v_policy_expression;
      END IF;
    END LOOP;
  END LOOP;

  IF pg_catalog.pg_has_role('app', v_owner_name, 'MEMBER')
    OR pg_catalog.pg_has_role('api_sql_executor', v_owner_name, 'MEMBER')
  THEN
    RAISE EXCEPTION
      'budget_adjustments RLS invariant failed: app-facing roles must not inherit table owner role %',
      v_owner_name;
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['app'::NAME, 'api_sql_executor'::NAME]
  LOOP
    IF NOT pg_catalog.has_any_column_privilege(
      v_role_name,
      'public.budget_adjustments',
      'SELECT'
    )
      OR NOT pg_catalog.has_any_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        'INSERT'
      )
      OR NOT pg_catalog.has_any_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        'UPDATE'
      )
      OR NOT pg_catalog.has_table_privilege(
        v_role_name,
        'public.budget_adjustments',
        'DELETE'
      )
      OR pg_catalog.has_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        'origin',
        'SELECT'
      )
      OR pg_catalog.has_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        'origin',
        'INSERT'
      )
      OR pg_catalog.has_column_privilege(
        v_role_name,
        'public.budget_adjustments',
        'origin',
        'UPDATE'
      )
    THEN
      RAISE EXCEPTION
        'budget_adjustments grant invariant failed: role % must have user-row CRUD without access to the internal origin marker',
        v_role_name;
    END IF;
  END LOOP;
END;
$$;
