-- Persist selected workspace per agent API key (connection).
--
-- This keeps SQL requests explicit and auditable while allowing clients to
-- omit X-Workspace-Id after a successful /workspaces/{workspaceId}/select.

ALTER TABLE auth.agent_api_keys
  ADD COLUMN selected_workspace_id TEXT;

CREATE OR REPLACE FUNCTION auth.get_single_workspace_id(p_user_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT CASE
    WHEN COUNT(*) = 1 THEN max(workspace_id)
    ELSE NULL
  END
  FROM public.workspace_members
  WHERE user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION auth.get_single_workspace_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.get_single_workspace_id(TEXT) TO auth_service;
