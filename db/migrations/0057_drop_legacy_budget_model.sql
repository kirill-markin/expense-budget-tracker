-- Remove the frozen legacy budget modifier and cell-comment storage.

SET LOCAL lock_timeout = '30s';

LOCK TABLE
  public.budget_lines,
  public.budget_comments
IN ACCESS EXCLUSIVE MODE;

-- Forced RLS applies to the migration owner. This policy exists only long
-- enough to prove Base preservation while deleting the obsolete Modifier rows.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_0057_migration_access
       ON public.budget_lines
       FOR ALL
       TO %I
       USING (true)
       WITH CHECK (true)',
    current_user
  );
END;
$$;

DO $$
DECLARE
  v_base_count_before BIGINT;
  v_base_count_after BIGINT;
  v_deleted_modifier_count BIGINT;
  v_modifier_count_before BIGINT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE line.kind = 'base'),
    COUNT(*) FILTER (WHERE line.kind = 'modifier')
    INTO v_base_count_before, v_modifier_count_before
    FROM public.budget_lines AS line;

  DELETE FROM public.budget_lines AS line
    WHERE line.kind = 'modifier';

  GET DIAGNOSTICS v_deleted_modifier_count = ROW_COUNT;

  SELECT COUNT(*)
    INTO v_base_count_after
    FROM public.budget_lines AS line
    WHERE line.kind = 'base';

  IF v_deleted_modifier_count IS DISTINCT FROM v_modifier_count_before THEN
    RAISE EXCEPTION
      'legacy budget cleanup invariant failed: expected to delete % Modifier rows, deleted %',
      v_modifier_count_before,
      v_deleted_modifier_count;
  END IF;

  IF v_base_count_after IS DISTINCT FROM v_base_count_before THEN
    RAISE EXCEPTION
      'legacy budget cleanup invariant failed: expected to preserve % Base rows, found % after Modifier deletion',
      v_base_count_before,
      v_base_count_after;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.budget_lines AS line
    WHERE line.kind <> 'base'
  )
  THEN
    RAISE EXCEPTION
      'legacy budget cleanup invariant failed: budget_lines still contains a non-Base row';
  END IF;
END;
$$;

DROP POLICY budget_lines_0057_migration_access
  ON public.budget_lines;
DROP POLICY budget_lines_workspace_delete_owner_access
  ON public.budget_lines;

ALTER TABLE public.budget_lines
  DROP CONSTRAINT budget_lines_kind_check;
ALTER TABLE public.budget_lines
  ADD CONSTRAINT budget_lines_kind_check
  CHECK (kind = 'base');

-- Keep the workspace cleanup contract unchanged while removing its obsolete
-- dependency on budget_comments. Budget adjustments continue to cascade from
-- workspaces through their existing foreign key.
CREATE OR REPLACE FUNCTION public.delete_workspace_for_current_user(
  p_workspace_id TEXT
)
RETURNS TABLE(workspace_id TEXT, name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_deleted_workspace_count INTEGER;
  v_user_id TEXT;
  v_workspace_name TEXT;
  v_member_count INTEGER;
  v_previous_workspace_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: app.user_id is not set';
  END IF;

  v_previous_workspace_id := current_setting('app.workspace_id', true);
  IF v_previous_workspace_id IS NULL THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: app.workspace_id is not set';
  END IF;

  SELECT workspace.name INTO v_workspace_name
    FROM public.workspaces AS workspace
    JOIN public.workspace_members AS member
      ON member.workspace_id = workspace.workspace_id
    WHERE workspace.workspace_id = p_workspace_id
      AND member.user_id = v_user_id;

  IF v_workspace_name IS NULL THEN
    RAISE EXCEPTION 'Workspace not found or not a member';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_member_count
    FROM public.workspace_members AS member
    WHERE member.workspace_id = p_workspace_id;

  IF v_member_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: workspace deletion is only allowed when the workspace has exactly one member; found %',
      COALESCE(v_member_count, 0);
  END IF;

  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    p_workspace_id
  );

  -- chat_items cascade from chat_sessions.
  DELETE FROM public.chat_sessions AS session
    WHERE session.workspace_id = p_workspace_id;
  DELETE FROM public.budget_lines AS line
    WHERE line.workspace_id = p_workspace_id;
  DELETE FROM public.account_metadata AS metadata
    WHERE metadata.workspace_id = p_workspace_id;
  DELETE FROM public.ledger_entries AS entry
    WHERE entry.workspace_id = p_workspace_id;
  DELETE FROM public.workspace_settings AS settings
    WHERE settings.workspace_id = p_workspace_id;

  WITH deleted_members AS (
    DELETE FROM public.workspace_members AS member
      WHERE member.workspace_id = p_workspace_id
      RETURNING member.workspace_id
  )
  DELETE FROM public.workspaces AS workspace
    WHERE workspace.workspace_id = p_workspace_id
      AND EXISTS (
        SELECT 1
        FROM deleted_members AS deleted_member
        WHERE deleted_member.workspace_id = workspace.workspace_id
      );

  GET DIAGNOSTICS v_deleted_workspace_count = ROW_COUNT;
  IF v_deleted_workspace_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: expected to delete workspace %, deleted % rows',
      p_workspace_id,
      COALESCE(v_deleted_workspace_count, 0);
  END IF;

  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    v_previous_workspace_id
  );

  RETURN QUERY SELECT p_workspace_id, v_workspace_name;
END;
$$;

DROP TABLE public.budget_comments;

DO $$
DECLARE
  v_constraint_expression TEXT;
  v_delete_function_configuration TEXT[];
  v_delete_function_definition TEXT;
  v_delete_function_is_security_definer BOOLEAN;
  v_policy_count INTEGER;
  v_privilege_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_role_name NAME;
BEGIN
  IF pg_catalog.to_regclass('public.budget_comments') IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy budget cleanup invariant failed: public.budget_comments still exists';
  END IF;

  SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.budget_lines'::regclass;

  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'legacy budget cleanup RLS invariant failed: budget_lines row-level security must remain enabled and forced';
  END IF;

  SELECT
    pg_catalog.pg_get_expr(
      constraint_record.conbin,
      constraint_record.conrelid
    )
    INTO v_constraint_expression
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.budget_lines'::regclass
      AND constraint_record.conname = 'budget_lines_kind_check'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated;

  IF v_constraint_expression IS NULL
    OR POSITION('''base''' IN v_constraint_expression) = 0
    OR POSITION('modifier' IN v_constraint_expression) <> 0
  THEN
    RAISE EXCEPTION
      'legacy budget cleanup constraint invariant failed: expected one validated Base-only budget_lines kind constraint, found %',
      v_constraint_expression;
  END IF;

  SELECT COUNT(*)::INTEGER
    INTO v_policy_count
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.budget_lines'::regclass;

  IF v_policy_count <> 4
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'public.budget_lines'::regclass
        AND policy.polname NOT IN (
          'budget_lines_select_access',
          'budget_lines_insert_base_access',
          'budget_lines_update_base_access',
          'budget_lines_delete_base_access'
        )
    )
  THEN
    RAISE EXCEPTION
      'legacy budget cleanup RLS invariant failed: expected the four canonical Base budget_lines policies, found % policies',
      v_policy_count;
  END IF;

  SELECT
    procedure_record.proconfig,
    procedure_record.prosecdef,
    pg_catalog.pg_get_functiondef(procedure_record.oid)
    INTO
      v_delete_function_configuration,
      v_delete_function_is_security_definer,
      v_delete_function_definition
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.delete_workspace_for_current_user(text)'
    );

  IF NOT FOUND
    OR NOT v_delete_function_is_security_definer
    OR v_delete_function_configuration IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, public, pg_temp'
    ]::TEXT[]
    OR POSITION(
      'public.budget_comments'
      IN v_delete_function_definition
    ) <> 0
    OR POSITION(
      'public.budget_lines'
      IN v_delete_function_definition
    ) = 0
  THEN
    RAISE EXCEPTION
      'legacy budget cleanup function invariant failed: workspace deletion must remain hardened, include budget_lines, and exclude budget_comments';
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['app'::NAME, 'api_sql_executor'::NAME]
  LOOP
    FOREACH v_privilege_name IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE'
    ]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        v_role_name,
        'public.budget_lines',
        v_privilege_name
      )
      THEN
        RAISE EXCEPTION
          'legacy budget cleanup grant invariant failed: role % must retain budget_lines % privilege under Base-only RLS',
          v_role_name,
          v_privilege_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
