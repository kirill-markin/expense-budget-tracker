-- Lock down privileged helper execution and restrict workspace deletion.
--
-- Restricted SQL must not be able to invoke privileged helpers through the
-- default PUBLIC EXECUTE grant. Workspace deletion is also limited to the
-- caller's personal workspace until explicit shared-workspace admin roles
-- exist.

CREATE OR REPLACE FUNCTION delete_workspace_for_current_user(p_workspace_id TEXT)
RETURNS TABLE(workspace_id TEXT, name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_workspace_name TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'delete_workspace_for_current_user: app.user_id is not set';
  END IF;

  IF p_workspace_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'delete_workspace_for_current_user: shared workspace deletion is disabled until workspace admin roles are introduced';
  END IF;

  SELECT w.name INTO v_workspace_name
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
    WHERE w.workspace_id = p_workspace_id
      AND wm.user_id = v_user_id;

  IF v_workspace_name IS NULL THEN
    RAISE EXCEPTION 'Workspace not found or not a member';
  END IF;

  -- chat_items and chat_code_interpreter_containers cascade from chat_sessions
  DELETE FROM chat_sessions WHERE chat_sessions.workspace_id = p_workspace_id;
  DELETE FROM budget_comments WHERE budget_comments.workspace_id = p_workspace_id;
  DELETE FROM budget_lines WHERE budget_lines.workspace_id = p_workspace_id;
  DELETE FROM account_metadata WHERE account_metadata.workspace_id = p_workspace_id;
  DELETE FROM ledger_entries WHERE ledger_entries.workspace_id = p_workspace_id;
  DELETE FROM workspace_settings WHERE workspace_settings.workspace_id = p_workspace_id;
  DELETE FROM workspace_members WHERE workspace_members.workspace_id = p_workspace_id;
  DELETE FROM workspaces WHERE workspaces.workspace_id = p_workspace_id;

  RETURN QUERY SELECT p_workspace_id, v_workspace_name;
END;
$$;

REVOKE ALL ON FUNCTION provision_personal_workspace_for_current_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_personal_workspace_for_current_user() TO app;

REVOKE ALL ON FUNCTION provision_personal_workspace_for_current_user(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_personal_workspace_for_current_user(TEXT) TO app;

REVOKE ALL ON FUNCTION create_workspace_for_current_user(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_workspace_for_current_user(TEXT) TO app;

REVOKE ALL ON FUNCTION create_workspace_for_current_user(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_workspace_for_current_user(TEXT, TEXT) TO app;

REVOKE ALL ON FUNCTION get_user_workspace_ids(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_workspace_ids(TEXT) TO app;

REVOKE ALL ON FUNCTION current_app_user_has_selected_workspace_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_app_user_has_selected_workspace_access() TO app;
GRANT EXECUTE ON FUNCTION current_app_user_has_selected_workspace_access() TO api_sql_executor;

REVOKE ALL ON FUNCTION delete_workspace_for_current_user(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_workspace_for_current_user(TEXT) TO app;

REVOKE ALL ON FUNCTION auth.validate_agent_api_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.validate_agent_api_key(TEXT) TO app;

REVOKE ALL ON FUNCTION auth.touch_agent_api_key_usage(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.touch_agent_api_key_usage(TEXT) TO app;

REVOKE ALL ON FUNCTION auth.sync_authenticated_user(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.sync_authenticated_user(TEXT, TEXT) TO auth_service;

REVOKE ALL ON FUNCTION auth.get_single_workspace_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.get_single_workspace_id(TEXT) TO auth_service;
