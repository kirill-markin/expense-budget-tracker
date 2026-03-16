-- Remove restricted SQL's dependency on direct SELECT access to
-- workspace_members while keeping workspace-scoped RLS intact.

CREATE OR REPLACE FUNCTION current_app_user_has_selected_workspace_access()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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
    FROM workspace_members
    WHERE workspace_id = v_workspace_id
      AND user_id = v_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION current_app_user_has_selected_workspace_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_app_user_has_selected_workspace_access() TO app;
GRANT EXECUTE ON FUNCTION current_app_user_has_selected_workspace_access() TO api_sql_executor;

DROP POLICY workspace_isolation ON ledger_entries;
CREATE POLICY workspace_isolation ON ledger_entries
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );

DROP POLICY workspace_isolation ON budget_lines;
CREATE POLICY workspace_isolation ON budget_lines
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );

DROP POLICY workspace_isolation ON budget_comments;
CREATE POLICY workspace_isolation ON budget_comments
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );

DROP POLICY workspace_isolation ON workspace_settings;
CREATE POLICY workspace_isolation ON workspace_settings
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );

DROP POLICY workspace_isolation ON account_metadata;
CREATE POLICY workspace_isolation ON account_metadata
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );
