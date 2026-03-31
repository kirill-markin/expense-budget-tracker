-- Fix workspace deletion helper after schema cleanup.
--
-- The original function referenced api_connections, which is not part of the
-- current schema and causes cleanup failures at runtime.

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
