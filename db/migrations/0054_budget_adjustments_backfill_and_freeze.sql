-- Backfill normalized budget adjustments and freeze superseded legacy writes.

SET LOCAL lock_timeout = '30s';

LOCK TABLE
  public.budget_lines,
  public.budget_comments,
  public.budget_adjustments,
  public.chat_sessions
IN ACCESS EXCLUSIVE MODE;

-- Forced RLS applies to the migration owner in production. These policies are
-- transaction-scoped because the migration drops them before commit.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_adjustments_0054_migration_read
       ON public.budget_lines
       FOR SELECT
       TO %I
       USING (true)',
    current_user
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_comments_adjustments_0054_migration_read
       ON public.budget_comments
       FOR SELECT
       TO %I
       USING (true)',
    current_user
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_adjustments_0054_migration_access
       ON public.budget_adjustments
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
  v_existing_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO v_existing_count
    FROM public.budget_adjustments;

  IF v_existing_count <> 0 THEN
    RAISE EXCEPTION
      'budget_adjustments backfill precondition failed: expected the table introduced by migration 0053 to be empty, found % rows; inspect the rows and decide explicitly how to reconcile them before retrying migration 0054',
      v_existing_count;
  END IF;
END;
$$;

-- Equal duplicate latest values are harmless, but different values at the same
-- maximum timestamp cannot be resolved without inventing a tie-breaker.
DO $$
DECLARE
  v_conflict RECORD;
BEGIN
  WITH latest_timestamps AS (
    SELECT
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category,
      MAX(line.inserted_at) AS inserted_at
    FROM public.budget_lines AS line
    WHERE line.kind = 'modifier'
    GROUP BY
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category
  )
  SELECT
    line.workspace_id,
    line.budget_month,
    line.direction,
    line.category,
    pg_catalog.array_agg(
      DISTINCT line.planned_value
      ORDER BY line.planned_value
    )::TEXT AS conflicting_values
    INTO v_conflict
    FROM latest_timestamps AS latest
    JOIN public.budget_lines AS line
      ON line.workspace_id = latest.workspace_id
      AND line.budget_month = latest.budget_month
      AND line.direction = latest.direction
      AND line.category = latest.category
      AND line.inserted_at = latest.inserted_at
      AND line.kind = 'modifier'
    GROUP BY
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category
    HAVING COUNT(DISTINCT line.planned_value) > 1
    ORDER BY
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments backfill conflict in budget_lines: workspace %, month %, direction %, category % has different latest modifier values % at the same inserted_at; resolve the tied legacy rows before retrying migration 0054',
      v_conflict.workspace_id,
      v_conflict.budget_month,
      v_conflict.direction,
      v_conflict.category,
      v_conflict.conflicting_values;
  END IF;
END;
$$;

DO $$
DECLARE
  v_conflict RECORD;
BEGIN
  WITH latest_timestamps AS (
    SELECT
      comment.workspace_id,
      comment.budget_month,
      comment.direction,
      comment.category,
      MAX(comment.inserted_at) AS inserted_at
    FROM public.budget_comments AS comment
    GROUP BY
      comment.workspace_id,
      comment.budget_month,
      comment.direction,
      comment.category
  )
  SELECT
    comment.workspace_id,
    comment.budget_month,
    comment.direction,
    comment.category,
    pg_catalog.array_agg(
      DISTINCT comment.comment
      ORDER BY comment.comment
    )::TEXT AS conflicting_values
    INTO v_conflict
    FROM latest_timestamps AS latest
    JOIN public.budget_comments AS comment
      ON comment.workspace_id = latest.workspace_id
      AND comment.budget_month = latest.budget_month
      AND comment.direction = latest.direction
      AND comment.category = latest.category
      AND comment.inserted_at = latest.inserted_at
    GROUP BY
      comment.workspace_id,
      comment.budget_month,
      comment.direction,
      comment.category
    HAVING COUNT(DISTINCT comment.comment) > 1
    ORDER BY
      comment.workspace_id,
      comment.budget_month,
      comment.direction,
      comment.category
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments backfill conflict in budget_comments: workspace %, month %, direction %, category % has different latest comments % at the same inserted_at; resolve the tied legacy rows before retrying migration 0054',
      v_conflict.workspace_id,
      v_conflict.budget_month,
      v_conflict.direction,
      v_conflict.category,
      v_conflict.conflicting_values;
  END IF;
END;
$$;

CREATE TEMPORARY TABLE budget_adjustments_0054_source (
  workspace_id TEXT NOT NULL,
  budget_month DATE NOT NULL,
  direction TEXT NOT NULL,
  category TEXT NOT NULL,
  modifier NUMERIC,
  comment TEXT,
  PRIMARY KEY (workspace_id, budget_month, direction, category)
) ON COMMIT DROP;

WITH modifier_latest_timestamps AS (
  SELECT
    line.workspace_id,
    line.budget_month,
    line.direction,
    line.category,
    MAX(line.inserted_at) AS inserted_at
  FROM public.budget_lines AS line
  WHERE line.kind = 'modifier'
  GROUP BY
    line.workspace_id,
    line.budget_month,
    line.direction,
    line.category
),
effective_modifiers AS (
  SELECT DISTINCT
    line.workspace_id,
    line.budget_month,
    line.direction,
    line.category,
    line.planned_value AS modifier
  FROM modifier_latest_timestamps AS latest
  JOIN public.budget_lines AS line
    ON line.workspace_id = latest.workspace_id
    AND line.budget_month = latest.budget_month
    AND line.direction = latest.direction
    AND line.category = latest.category
    AND line.inserted_at = latest.inserted_at
    AND line.kind = 'modifier'
),
comment_latest_timestamps AS (
  SELECT
    comment.workspace_id,
    comment.budget_month,
    comment.direction,
    comment.category,
    MAX(comment.inserted_at) AS inserted_at
  FROM public.budget_comments AS comment
  GROUP BY
    comment.workspace_id,
    comment.budget_month,
    comment.direction,
    comment.category
),
effective_comments AS (
  SELECT DISTINCT
    comment.workspace_id,
    comment.budget_month,
    comment.direction,
    comment.category,
    comment.comment
  FROM comment_latest_timestamps AS latest
  JOIN public.budget_comments AS comment
    ON comment.workspace_id = latest.workspace_id
    AND comment.budget_month = latest.budget_month
    AND comment.direction = latest.direction
    AND comment.category = latest.category
    AND comment.inserted_at = latest.inserted_at
)
INSERT INTO budget_adjustments_0054_source (
  workspace_id,
  budget_month,
  direction,
  category,
  modifier,
  comment
)
SELECT
  COALESCE(modifier.workspace_id, comment.workspace_id),
  COALESCE(modifier.budget_month, comment.budget_month),
  COALESCE(modifier.direction, comment.direction),
  COALESCE(modifier.category, comment.category),
  modifier.modifier,
  comment.comment
FROM effective_modifiers AS modifier
FULL JOIN effective_comments AS comment
  USING (workspace_id, budget_month, direction, category);

DO $$
DECLARE
  v_invalid RECORD;
BEGIN
  SELECT
    source.workspace_id,
    source.budget_month,
    source.direction,
    source.category,
    source.modifier
    INTO v_invalid
    FROM budget_adjustments_0054_source AS source
    WHERE source.modifier IS NOT NULL
      AND CASE
        WHEN source.modifier IN (
          'NaN'::NUMERIC,
          'Infinity'::NUMERIC,
          '-Infinity'::NUMERIC
        ) THEN true
        ELSE source.modifier <> pg_catalog.trunc(source.modifier)
      END
    ORDER BY
      source.workspace_id,
      source.budget_month,
      source.direction,
      source.category
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments backfill amount invariant failed: workspace %, month %, direction %, category % has legacy modifier value %; every effective modifier must be finite and an integer before retrying migration 0054',
      v_invalid.workspace_id,
      v_invalid.budget_month,
      v_invalid.direction,
      v_invalid.category,
      v_invalid.modifier;
  END IF;
END;
$$;

-- The legacy exemption was needed only while 0053 could contain unvalidated
-- source values. Migration 0054 has now proved every effective value is a
-- finite integer, so editable rows must all obey the product invariant.
ALTER TABLE public.budget_adjustments
  DROP CONSTRAINT budget_adjustments_amount_check;
ALTER TABLE public.budget_adjustments
  ADD CONSTRAINT budget_adjustments_amount_check
  CHECK (
    amount NOT IN (
      'NaN'::NUMERIC,
      'Infinity'::NUMERIC,
      '-Infinity'::NUMERIC
    )
    AND amount = pg_catalog.trunc(amount)
  );

INSERT INTO public.budget_adjustments (
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note,
  origin
)
SELECT
  source.workspace_id,
  source.budget_month,
  source.direction,
  source.category,
  COALESCE(source.modifier, 0),
  NULLIF(source.comment, ''),
  'legacy'
FROM budget_adjustments_0054_source AS source
WHERE COALESCE(source.modifier, 0) <> 0
  OR COALESCE(source.comment, '') <> '';

-- Re-establish every normalized policy canonically instead of carrying policy
-- definitions across the cutover. Migrated rows remain editable, INSERT stays
-- user-origin-only, and app has no privilege on the origin column.
DROP POLICY budget_adjustments_select_access
  ON public.budget_adjustments;
DROP POLICY budget_adjustments_insert_access
  ON public.budget_adjustments;
DROP POLICY budget_adjustments_update_access
  ON public.budget_adjustments;
DROP POLICY budget_adjustments_delete_access
  ON public.budget_adjustments;

CREATE POLICY budget_adjustments_select_access
  ON public.budget_adjustments
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_adjustments_insert_access
  ON public.budget_adjustments
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND origin = 'user'
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

-- Preserve reads of every legacy row while permitting mutations only when both
-- the existing row and the proposed row are Base.
DROP POLICY workspace_isolation
  ON public.budget_lines;

CREATE POLICY budget_lines_select_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_lines_insert_base_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND kind = 'base'
  );

CREATE POLICY budget_lines_update_base_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND kind = 'base'
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND kind = 'base'
  );

CREATE POLICY budget_lines_delete_base_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR DELETE
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
    AND kind = 'base'
  );

-- Legacy comments are read-only after the snapshot. Recreate their workspace
-- policy so a weakened pre-cutover definition cannot survive migration 0054.
DROP POLICY workspace_isolation
  ON public.budget_comments;

CREATE POLICY workspace_isolation
  ON public.budget_comments
  AS PERMISSIVE
  FOR ALL
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

-- Cleanup policies call this SECURITY DEFINER membership helper. Keep its
-- existing contract while preventing pg_temp from shadowing workspace_members.
CREATE OR REPLACE FUNCTION public.current_app_user_has_selected_workspace_access()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id TEXT;
  v_workspace_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_workspace_id := current_setting('app.workspace_id', true);

  IF v_user_id IS NULL OR v_workspace_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.workspace_members AS member
    WHERE member.workspace_id = v_workspace_id
      AND member.user_id = v_user_id
  );
END;
$$;

-- Preserve ordinary current-user chat access while making its workspace
-- predicate canonical before adding the narrow deletion-owner policies.
DROP POLICY chat_sessions_self_access
  ON public.chat_sessions;

CREATE POLICY chat_sessions_self_access
  ON public.chat_sessions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

-- Workspace deletion runs as this SECURITY DEFINER function's owner. Forced
-- RLS still applies to a non-bypass owner, so grant that exact execution role
-- the missing modifier and former-member chat cleanup paths without exposing
-- them to client roles.
DO $$
DECLARE
  v_function_owner_name NAME;
  v_is_security_definer BOOLEAN;
BEGIN
  SELECT
    pg_catalog.pg_get_userbyid(procedure_record.proowner),
    procedure_record.prosecdef
    INTO v_function_owner_name, v_is_security_definer
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.delete_workspace_for_current_user(text)'
    );

  IF NOT FOUND OR NOT v_is_security_definer THEN
    RAISE EXCEPTION
      'budget_adjustments cutover policy precondition failed: public.delete_workspace_for_current_user(text) must exist and be SECURITY DEFINER';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_workspace_delete_owner_access
       ON public.budget_lines
       AS PERMISSIVE
       FOR DELETE
       TO %I
       USING (
         CURRENT_USER = %L::NAME
         AND current_setting(''app.workspace_id'', true) IS NOT NULL
         AND workspace_id = current_setting(''app.workspace_id'', true)
         AND public.current_app_user_has_selected_workspace_access()
         AND kind = ''modifier''
       )',
    v_function_owner_name,
    v_function_owner_name
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY chat_sessions_workspace_delete_owner_visibility
       ON public.chat_sessions
       AS PERMISSIVE
       FOR SELECT
       TO %I
       USING (
         CURRENT_USER = %L::NAME
         AND current_setting(''app.workspace_id'', true) IS NOT NULL
         AND workspace_id = current_setting(''app.workspace_id'', true)
         AND public.current_app_user_has_selected_workspace_access()
       )',
    v_function_owner_name,
    v_function_owner_name
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY chat_sessions_workspace_delete_owner_access
       ON public.chat_sessions
       AS PERMISSIVE
       FOR DELETE
       TO %I
       USING (
         CURRENT_USER = %L::NAME
         AND current_setting(''app.workspace_id'', true) IS NOT NULL
         AND workspace_id = current_setting(''app.workspace_id'', true)
         AND public.current_app_user_has_selected_workspace_access()
       )',
    v_function_owner_name,
    v_function_owner_name
  );
END;
$$;

-- Keep workspace deletion functional for a forced-RLS, non-bypass function
-- owner. The data-modifying CTE lets the workspace DELETE authorize against
-- the pre-delete membership snapshot while removing the member for the foreign
-- key in the same statement.
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
  DELETE FROM public.budget_comments AS comment
    WHERE comment.workspace_id = p_workspace_id;
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

REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.budget_comments
  FROM app, api_sql_executor;
REVOKE INSERT (
  budget_month,
  direction,
  category,
  comment,
  workspace_id,
  inserted_at
) ON TABLE public.budget_comments FROM app, api_sql_executor;
REVOKE UPDATE (
  budget_month,
  direction,
  category,
  comment,
  workspace_id,
  inserted_at
) ON TABLE public.budget_comments FROM app, api_sql_executor;
REVOKE REFERENCES (
  budget_month,
  direction,
  category,
  comment,
  workspace_id,
  inserted_at
) ON TABLE public.budget_comments FROM app, api_sql_executor;

-- A table-level REVOKE does not remove the column grants created by 0053.
REVOKE ALL PRIVILEGES
  ON TABLE public.budget_adjustments
  FROM api_sql_executor;
REVOKE SELECT (
  adjustment_id,
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note,
  origin,
  created_at,
  updated_at
) ON TABLE public.budget_adjustments FROM api_sql_executor;
REVOKE INSERT (
  adjustment_id,
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note,
  origin,
  created_at,
  updated_at
) ON TABLE public.budget_adjustments FROM api_sql_executor;
REVOKE UPDATE (
  adjustment_id,
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note,
  origin,
  created_at,
  updated_at
) ON TABLE public.budget_adjustments FROM api_sql_executor;
REVOKE REFERENCES (
  adjustment_id,
  workspace_id,
  budget_month,
  direction,
  category,
  amount,
  note,
  origin,
  created_at,
  updated_at
) ON TABLE public.budget_adjustments FROM api_sql_executor;

-- Compare the complete meaningful source set with the complete target table
-- while the migration-role policies are still available.
DO $$
DECLARE
  v_expected_count BIGINT;
  v_legacy_count BIGINT;
  v_target_count BIGINT;
  v_mismatch RECORD;
BEGIN
  SELECT COUNT(*)
    INTO v_expected_count
    FROM budget_adjustments_0054_source AS source
    WHERE COALESCE(source.modifier, 0) <> 0
      OR COALESCE(source.comment, '') <> '';

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE adjustment.origin = 'legacy')
    INTO v_target_count, v_legacy_count
    FROM public.budget_adjustments AS adjustment;

  IF v_target_count <> v_expected_count
    OR v_legacy_count <> v_expected_count
  THEN
    RAISE EXCEPTION
      'budget_adjustments backfill row-count invariant failed: expected % meaningful source cells, found % total target rows and % legacy target rows',
      v_expected_count,
      v_target_count,
      v_legacy_count;
  END IF;

  WITH meaningful_source AS (
    SELECT
      source.workspace_id,
      source.budget_month,
      source.direction,
      source.category,
      COALESCE(source.modifier, 0) AS amount,
      NULLIF(source.comment, '') AS note
    FROM budget_adjustments_0054_source AS source
    WHERE COALESCE(source.modifier, 0) <> 0
      OR COALESCE(source.comment, '') <> ''
  )
  SELECT
    COALESCE(source.workspace_id, target.workspace_id) AS workspace_id,
    COALESCE(source.budget_month, target.budget_month) AS budget_month,
    COALESCE(source.direction, target.direction) AS direction,
    COALESCE(source.category, target.category) AS category,
    source.amount AS expected_amount,
    target.amount AS actual_amount,
    source.note AS expected_note,
    target.note AS actual_note,
    target.origin AS actual_origin
    INTO v_mismatch
    FROM meaningful_source AS source
    FULL JOIN public.budget_adjustments AS target
      USING (workspace_id, budget_month, direction, category)
    WHERE source.workspace_id IS NULL
      OR target.workspace_id IS NULL
      OR source.amount IS DISTINCT FROM target.amount
      OR source.note IS DISTINCT FROM target.note
      OR target.origin IS DISTINCT FROM 'legacy'
    ORDER BY
      COALESCE(source.workspace_id, target.workspace_id),
      COALESCE(source.budget_month, target.budget_month),
      COALESCE(source.direction, target.direction),
      COALESCE(source.category, target.category)
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments backfill value invariant failed: workspace %, month %, direction %, category % expected amount % and note %, found amount %, note %, and origin %',
      v_mismatch.workspace_id,
      v_mismatch.budget_month,
      v_mismatch.direction,
      v_mismatch.category,
      v_mismatch.expected_amount,
      v_mismatch.expected_note,
      v_mismatch.actual_amount,
      v_mismatch.actual_note,
      v_mismatch.actual_origin;
  END IF;
END;
$$;

DROP POLICY budget_lines_adjustments_0054_migration_read
  ON public.budget_lines;
DROP POLICY budget_comments_adjustments_0054_migration_read
  ON public.budget_comments;
DROP POLICY budget_adjustments_0054_migration_access
  ON public.budget_adjustments;

-- Make pg_get_expr output deterministic for exact PostgreSQL 18 policy checks.
SET LOCAL search_path = pg_catalog, public;

-- Verify final RLS and policy state after removing migration-only access.
DO $$
DECLARE
  v_client_bypass_rls BOOLEAN;
  v_client_superuser BOOLEAN;
  v_cleanup_owner_name NAME;
  v_cleanup_owner_names NAME[];
  v_constraint_expression TEXT;
  v_delete_function_configuration TEXT[];
  v_delete_function_is_security_definer BOOLEAN;
  v_delete_function_definition TEXT;
  v_delete_function_owner_name NAME;
  v_delete_function_owner_oid OID;
  v_expected_adjustment_insert_expression TEXT;
  v_expected_base_expression TEXT;
  v_expected_chat_cleanup_expression TEXT;
  v_expected_chat_self_expression TEXT;
  v_expected_modifier_cleanup_expression TEXT;
  v_expected_workspace_expression TEXT;
  v_policy_mismatch RECORD;
  v_relation_name TEXT;
  v_role_name NAME;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_unsafe_role RECORD;
  v_workspace_access_helper_configuration TEXT[];
  v_workspace_access_helper_definition TEXT;
  v_workspace_access_helper_is_security_definer BOOLEAN;
  v_workspace_access_helper_owner_name NAME;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'public.budget_lines',
    'public.budget_comments',
    'public.budget_adjustments',
    'public.chat_sessions'
  ]
  LOOP
    SELECT
      relation.relrowsecurity,
      relation.relforcerowsecurity
      INTO v_rls_enabled, v_rls_forced
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation_name::regclass;

    IF NOT v_rls_enabled OR NOT v_rls_forced THEN
      RAISE EXCEPTION
        'budget_adjustments cutover RLS invariant failed: table % must have row-level security enabled and forced',
        v_relation_name;
    END IF;
  END LOOP;

  SELECT
    procedure_record.proowner,
    pg_catalog.pg_get_userbyid(procedure_record.proowner),
    procedure_record.proconfig,
    procedure_record.prosecdef,
    pg_catalog.pg_get_functiondef(procedure_record.oid)
    INTO
      v_delete_function_owner_oid,
      v_delete_function_owner_name,
      v_delete_function_configuration,
      v_delete_function_is_security_definer,
      v_delete_function_definition
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.delete_workspace_for_current_user(text)'
    );

  SELECT
    pg_catalog.pg_get_userbyid(procedure_record.proowner),
    procedure_record.proconfig,
    pg_catalog.pg_get_functiondef(procedure_record.oid),
    procedure_record.prosecdef
    INTO
      v_workspace_access_helper_owner_name,
      v_workspace_access_helper_configuration,
      v_workspace_access_helper_definition,
      v_workspace_access_helper_is_security_definer
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.current_app_user_has_selected_workspace_access()'
    );

  IF v_workspace_access_helper_owner_name IS NULL
    OR NOT v_workspace_access_helper_is_security_definer
    OR v_workspace_access_helper_configuration IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, public, pg_temp'
    ]::TEXT[]
    OR POSITION(
      'public.workspace_members'
      IN v_workspace_access_helper_definition
    ) = 0
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover policy invariant failed: public.current_app_user_has_selected_workspace_access() must be SECURITY DEFINER with hardened search_path pg_catalog, public, pg_temp and schema-qualified workspace membership';
  END IF;

  IF v_delete_function_owner_oid IS NULL
    OR NOT v_delete_function_is_security_definer
    OR v_delete_function_configuration IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, public, pg_temp'
    ]::TEXT[]
    OR POSITION(
      'WITH deleted_members AS'
      IN v_delete_function_definition
    ) = 0
    OR POSITION(
      'SET LOCAL app.workspace_id = %L'
      IN v_delete_function_definition
    ) = 0
    OR POSITION(
      'GET DIAGNOSTICS v_deleted_workspace_count = ROW_COUNT'
      IN v_delete_function_definition
    ) = 0
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover policy invariant failed: public.delete_workspace_for_current_user(text) must be SECURITY DEFINER with hardened search_path pg_catalog, public, pg_temp, bind target workspace context, and verify atomic workspace deletion';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'public.workspaces',
    'public.workspace_members',
    'public.chat_sessions',
    'public.budget_comments',
    'public.budget_lines',
    'public.account_metadata',
    'public.ledger_entries',
    'public.workspace_settings'
  ]
  LOOP
    IF POSITION(v_relation_name IN v_delete_function_definition) = 0 THEN
      RAISE EXCEPTION
        'budget_adjustments cutover policy invariant failed: public.delete_workspace_for_current_user(text) must schema-qualify persistent relation %',
        v_relation_name;
    END IF;
  END LOOP;

  SELECT pg_catalog.array_agg(
      DISTINCT pg_catalog.pg_get_userbyid(relation.relowner)::NAME
      ORDER BY pg_catalog.pg_get_userbyid(relation.relowner)::NAME
    )
    INTO v_cleanup_owner_names
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = ANY(ARRAY[
      'public.workspaces'::regclass,
      'public.workspace_members'::regclass,
      'public.chat_sessions'::regclass,
      'public.chat_items'::regclass,
      'public.budget_comments'::regclass,
      'public.budget_lines'::regclass,
      'public.budget_adjustments'::regclass,
      'public.account_metadata'::regclass,
      'public.ledger_entries'::regclass,
      'public.workspace_settings'::regclass,
      'community.monthly_category_shares'::regclass,
      'community.monthly_category_share_items'::regclass,
      'community.monthly_category_share_keys'::regclass
    ]);

  SELECT pg_catalog.array_agg(
      DISTINCT owner_record.owner_name
      ORDER BY owner_record.owner_name
    )
    INTO v_cleanup_owner_names
    FROM pg_catalog.unnest(
      v_cleanup_owner_names || ARRAY[
        v_delete_function_owner_name,
        v_workspace_access_helper_owner_name
      ]::NAME[]
    ) AS owner_record(owner_name);

  IF pg_catalog.cardinality(v_cleanup_owner_names) IS NULL
    OR v_delete_function_owner_name IS NULL
    OR v_workspace_access_helper_owner_name IS NULL
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover role invariant failed: could not resolve every direct, cascading, or helper owner participating in workspace deletion';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    v_delete_function_owner_name,
    'public.budget_lines',
    'DELETE'
  )
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover policy invariant failed: workspace deletion function owner % must have DELETE privilege on budget_lines',
      v_delete_function_owner_name;
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    v_delete_function_owner_name,
    'public.chat_sessions',
    'DELETE'
  )
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover policy invariant failed: workspace deletion function owner % must have DELETE privilege on chat_sessions',
      v_delete_function_owner_name;
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['app'::NAME, 'api_sql_executor'::NAME]
  LOOP
    SELECT role_record.rolsuper, role_record.rolbypassrls
      INTO v_client_superuser, v_client_bypass_rls
      FROM pg_catalog.pg_roles AS role_record
      WHERE role_record.rolname = v_role_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'budget_adjustments cutover role invariant failed: required client role % does not exist',
        v_role_name;
    END IF;

    IF v_client_superuser OR v_client_bypass_rls
    THEN
      RAISE EXCEPTION
        'budget_adjustments cutover role invariant failed: client role % must be NOSUPERUSER and NOBYPASSRLS; rolsuper %, rolbypassrls %',
        v_role_name,
        v_client_superuser,
        v_client_bypass_rls;
    END IF;

    FOR v_unsafe_role IN
      SELECT role_record.oid, role_record.rolname
      FROM pg_catalog.pg_roles AS role_record
      WHERE (role_record.rolsuper OR role_record.rolbypassrls)
        AND role_record.rolname <> v_role_name
        AND pg_catalog.pg_has_role(
          v_role_name,
          role_record.oid,
          'SET'
        )
    LOOP
      RAISE EXCEPTION
        'budget_adjustments cutover role invariant failed: client role % can SET ROLE to unsafe superuser/BYPASSRLS role %',
        v_role_name,
        v_unsafe_role.rolname;
    END LOOP;

    FOR v_cleanup_owner_name IN
      SELECT owner_record.owner_name
      FROM pg_catalog.unnest(
        v_cleanup_owner_names
      ) AS owner_record(owner_name)
    LOOP
      IF pg_catalog.pg_has_role(
        v_role_name,
        v_cleanup_owner_name,
        'MEMBER'
      )
        OR pg_catalog.pg_has_role(
          v_role_name,
          v_cleanup_owner_name,
          'SET'
        )
      THEN
        RAISE EXCEPTION
          'budget_adjustments cutover role invariant failed: client role % must not inherit or SET ROLE to cleanup owner %',
          v_role_name,
          v_cleanup_owner_name;
      END IF;
    END LOOP;
  END LOOP;

  SELECT pg_catalog.pg_get_expr(
    constraint_record.conbin,
    constraint_record.conrelid
  )
    INTO v_constraint_expression
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.budget_adjustments'::regclass
      AND constraint_record.conname = 'budget_adjustments_amount_check'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated;

  IF v_constraint_expression IS NULL
    OR POSITION('trunc(amount)' IN v_constraint_expression) = 0
    OR POSITION('''NaN''' IN v_constraint_expression) = 0
    OR POSITION('''Infinity''' IN v_constraint_expression) = 0
    OR POSITION('''-Infinity''' IN v_constraint_expression) = 0
    OR POSITION('origin' IN v_constraint_expression) <> 0
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover amount invariant failed: expected one validated finite-integer constraint without an origin exemption, found %',
      v_constraint_expression;
  END IF;

  v_expected_workspace_expression :=
    '((current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access())';
  v_expected_adjustment_insert_expression :=
    '((current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access() AND (origin = ''user''::text))';
  v_expected_base_expression :=
    '((current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access() AND (kind = ''base''::text))';
  v_expected_chat_self_expression :=
    '((user_id = current_setting(''app.user_id''::text, true)) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access())';
  v_expected_modifier_cleanup_expression := pg_catalog.format(
    '((CURRENT_USER = %L::name) AND (current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access() AND (kind = ''modifier''::text))',
    v_delete_function_owner_name
  );
  v_expected_chat_cleanup_expression := pg_catalog.format(
    '((CURRENT_USER = %L::name) AND (current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access())',
    v_delete_function_owner_name
  );

  WITH expected_policies (
    relation_name,
    policy_name,
    permissive,
    command,
    role_oids,
    using_expression,
    check_expression
  ) AS (
    VALUES
      (
        'public.budget_adjustments'::TEXT,
        'budget_adjustments_select_access'::NAME,
        true,
        'r'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        NULL::TEXT
      ),
      (
        'public.budget_adjustments'::TEXT,
        'budget_adjustments_insert_access'::NAME,
        true,
        'a'::TEXT,
        ARRAY[0::OID],
        NULL::TEXT,
        v_expected_adjustment_insert_expression
      ),
      (
        'public.budget_adjustments'::TEXT,
        'budget_adjustments_update_access'::NAME,
        true,
        'w'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        v_expected_workspace_expression
      ),
      (
        'public.budget_adjustments'::TEXT,
        'budget_adjustments_delete_access'::NAME,
        true,
        'd'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        NULL::TEXT
      ),
      (
        'public.budget_lines'::TEXT,
        'budget_lines_select_access'::NAME,
        true,
        'r'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        NULL::TEXT
      ),
      (
        'public.budget_lines'::TEXT,
        'budget_lines_insert_base_access'::NAME,
        true,
        'a'::TEXT,
        ARRAY[0::OID],
        NULL::TEXT,
        v_expected_base_expression
      ),
      (
        'public.budget_lines'::TEXT,
        'budget_lines_update_base_access'::NAME,
        true,
        'w'::TEXT,
        ARRAY[0::OID],
        v_expected_base_expression,
        v_expected_base_expression
      ),
      (
        'public.budget_lines'::TEXT,
        'budget_lines_delete_base_access'::NAME,
        true,
        'd'::TEXT,
        ARRAY[0::OID],
        v_expected_base_expression,
        NULL::TEXT
      ),
      (
        'public.budget_lines'::TEXT,
        'budget_lines_workspace_delete_owner_access'::NAME,
        true,
        'd'::TEXT,
        ARRAY[v_delete_function_owner_oid],
        v_expected_modifier_cleanup_expression,
        NULL::TEXT
      ),
      (
        'public.budget_comments'::TEXT,
        'workspace_isolation'::NAME,
        true,
        '*'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        v_expected_workspace_expression
      ),
      (
        'public.chat_sessions'::TEXT,
        'chat_sessions_self_access'::NAME,
        true,
        '*'::TEXT,
        ARRAY[0::OID],
        v_expected_chat_self_expression,
        v_expected_chat_self_expression
      ),
      (
        'public.chat_sessions'::TEXT,
        'chat_sessions_workspace_delete_owner_visibility'::NAME,
        true,
        'r'::TEXT,
        ARRAY[v_delete_function_owner_oid],
        v_expected_chat_cleanup_expression,
        NULL::TEXT
      ),
      (
        'public.chat_sessions'::TEXT,
        'chat_sessions_workspace_delete_owner_access'::NAME,
        true,
        'd'::TEXT,
        ARRAY[v_delete_function_owner_oid],
        v_expected_chat_cleanup_expression,
        NULL::TEXT
      )
  ),
  actual_policies AS (
    SELECT
      namespace.nspname || '.' || relation.relname AS relation_name,
      policy.polname AS policy_name,
      policy.polpermissive AS permissive,
      policy.polcmd::TEXT AS command,
      policy.polroles AS role_oids,
      pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid
      ) AS using_expression,
      pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid
      ) AS check_expression
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE policy.polrelid = ANY(ARRAY[
      'public.budget_adjustments'::regclass,
      'public.budget_lines'::regclass,
      'public.budget_comments'::regclass,
      'public.chat_sessions'::regclass
    ])
  )
  SELECT
    expected_policy.relation_name AS expected_relation_name,
    expected_policy.policy_name AS expected_policy_name,
    expected_policy.permissive AS expected_permissive,
    expected_policy.command AS expected_command,
    expected_policy.role_oids AS expected_role_oids,
    expected_policy.using_expression AS expected_using_expression,
    expected_policy.check_expression AS expected_check_expression,
    actual_policy.relation_name AS actual_relation_name,
    actual_policy.policy_name AS actual_policy_name,
    actual_policy.permissive AS actual_permissive,
    actual_policy.command AS actual_command,
    actual_policy.role_oids AS actual_role_oids,
    actual_policy.using_expression AS actual_using_expression,
    actual_policy.check_expression AS actual_check_expression
    INTO v_policy_mismatch
    FROM expected_policies AS expected_policy
    FULL JOIN actual_policies AS actual_policy
      USING (relation_name, policy_name)
    WHERE expected_policy.relation_name IS NULL
      OR actual_policy.relation_name IS NULL
      OR expected_policy.permissive IS DISTINCT FROM actual_policy.permissive
      OR expected_policy.command IS DISTINCT FROM actual_policy.command
      OR expected_policy.role_oids IS DISTINCT FROM actual_policy.role_oids
      OR expected_policy.using_expression IS DISTINCT FROM actual_policy.using_expression
      OR expected_policy.check_expression IS DISTINCT FROM actual_policy.check_expression
    ORDER BY
      COALESCE(expected_policy.relation_name, actual_policy.relation_name),
      COALESCE(expected_policy.policy_name, actual_policy.policy_name)
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments cutover policy invariant failed for %.%: expected permissive %, command %, roles %, USING %, WITH CHECK %; found %.% with permissive %, command %, roles %, USING %, WITH CHECK %',
      v_policy_mismatch.expected_relation_name,
      v_policy_mismatch.expected_policy_name,
      v_policy_mismatch.expected_permissive,
      v_policy_mismatch.expected_command,
      v_policy_mismatch.expected_role_oids,
      v_policy_mismatch.expected_using_expression,
      v_policy_mismatch.expected_check_expression,
      v_policy_mismatch.actual_relation_name,
      v_policy_mismatch.actual_policy_name,
      v_policy_mismatch.actual_permissive,
      v_policy_mismatch.actual_command,
      v_policy_mismatch.actual_role_oids,
      v_policy_mismatch.actual_using_expression,
      v_policy_mismatch.actual_check_expression;
  END IF;
END;
$$;

-- Verify the final grants exactly, including inherited or PUBLIC privileges.
DO $$
DECLARE
  v_column_name NAME;
  v_has_privilege BOOLEAN;
  v_privilege_name TEXT;
  v_role_name NAME;
BEGIN
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
        'budget_adjustments cutover grant invariant failed: api_sql_executor still has table-level % privilege on budget_adjustments',
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
          'budget_adjustments cutover grant invariant failed: api_sql_executor still has % privilege on budget_adjustments column %',
          v_privilege_name,
          v_column_name;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
    'app',
    'public.budget_adjustments',
    'DELETE'
  )
  THEN
    RAISE EXCEPTION
      'budget_adjustments cutover grant invariant failed: app must retain table-level DELETE privilege';
  END IF;

  FOREACH v_privilege_name IN ARRAY ARRAY[
    'SELECT',
    'INSERT',
    'UPDATE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
    'MAINTAIN'
  ]
  LOOP
    IF pg_catalog.has_table_privilege(
      'app',
      'public.budget_adjustments',
      v_privilege_name
    )
    THEN
      RAISE EXCEPTION
        'budget_adjustments cutover grant invariant failed: app has unexpected table-level % privilege on budget_adjustments',
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
        'budget_adjustments cutover grant invariant failed: app has unexpected SELECT privilege state % on column %',
        v_has_privilege,
        v_column_name;
    END IF;

    v_has_privilege := pg_catalog.has_column_privilege(
      'app',
      'public.budget_adjustments',
      v_column_name,
      'INSERT'
    );
    IF v_has_privilege IS DISTINCT FROM (
      v_column_name = ANY(ARRAY[
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
        'budget_adjustments cutover grant invariant failed: app has unexpected INSERT privilege state % on column %',
        v_has_privilege,
        v_column_name;
    END IF;

    v_has_privilege := pg_catalog.has_column_privilege(
      'app',
      'public.budget_adjustments',
      v_column_name,
      'UPDATE'
    );
    IF v_has_privilege IS DISTINCT FROM (
      v_column_name = ANY(ARRAY[
        'budget_month'::NAME,
        'direction'::NAME,
        'category'::NAME,
        'amount'::NAME,
        'note'::NAME
      ])
    )
    THEN
      RAISE EXCEPTION
        'budget_adjustments cutover grant invariant failed: app has unexpected UPDATE privilege state % on column %',
        v_has_privilege,
        v_column_name;
    END IF;

    IF pg_catalog.has_column_privilege(
      'app',
      'public.budget_adjustments',
      v_column_name,
      'REFERENCES'
    )
    THEN
      RAISE EXCEPTION
        'budget_adjustments cutover grant invariant failed: app must not have REFERENCES privilege on column %',
        v_column_name;
    END IF;
  END LOOP;

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
          'budget_adjustments cutover grant invariant failed: role % must retain budget_lines % privilege so command-specific Base RLS policies control writes',
          v_role_name,
          v_privilege_name;
      END IF;
    END LOOP;

    FOREACH v_privilege_name IN ARRAY ARRAY[
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN'
    ]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role_name,
        'public.budget_lines',
        v_privilege_name
      )
      THEN
        RAISE EXCEPTION
          'budget_adjustments cutover grant invariant failed: role % has unsafe effective budget_lines % privilege, including inherited or PUBLIC grants',
          v_role_name,
          v_privilege_name;
      END IF;
    END LOOP;

    IF NOT pg_catalog.has_table_privilege(
      v_role_name,
      'public.budget_comments',
      'SELECT'
    )
    THEN
      RAISE EXCEPTION
        'budget_adjustments cutover grant invariant failed: role % must retain budget_comments SELECT privilege',
        v_role_name;
    END IF;

    FOREACH v_privilege_name IN ARRAY ARRAY[
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
        'public.budget_comments',
        v_privilege_name
      )
      THEN
        RAISE EXCEPTION
          'budget_adjustments cutover grant invariant failed: role % has unsafe effective budget_comments table-level % privilege, including inherited or PUBLIC grants',
          v_role_name,
          v_privilege_name;
      END IF;
    END LOOP;

    FOR v_column_name IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.budget_comments'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege_name IN ARRAY ARRAY[
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role_name,
          'public.budget_comments',
          v_column_name,
          v_privilege_name
        )
        THEN
          RAISE EXCEPTION
            'budget_adjustments cutover grant invariant failed: role % has unsafe effective budget_comments column-level % privilege on %, including inherited or PUBLIC grants',
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
