-- Restrict get_user_workspace_ids to only return results when p_user_id
-- matches the current RLS session user (app.user_id). Prevents cross-tenant
-- workspace membership leaks via direct function calls.

CREATE OR REPLACE FUNCTION get_user_workspace_ids(p_user_id TEXT)
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM current_setting('app.user_id', true) THEN
    RAISE EXCEPTION 'get_user_workspace_ids: p_user_id must match current app.user_id';
  END IF;
  RETURN QUERY
    SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = p_user_id;
END;
$$;
