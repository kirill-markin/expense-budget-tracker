-- Add timezone-aware workspace creation helpers for browser flows.
--
-- Existing helper signatures remain unchanged for compatibility with agent/API
-- flows that still rely on the default UTC workspace timezone.

CREATE FUNCTION provision_personal_workspace_for_current_user(p_timezone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_timezone TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_timezone := btrim(p_timezone);

  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'provision_personal_workspace_for_current_user: app.user_id must be set';
  END IF;

  IF v_timezone IS NULL OR v_timezone = '' THEN
    RAISE EXCEPTION 'provision_personal_workspace_for_current_user: p_timezone must be non-empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workspace_members
    WHERE workspace_id = v_user_id
      AND user_id = v_user_id
  ) THEN
    RETURN v_user_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workspaces
    WHERE workspace_id = v_user_id
  ) THEN
    RAISE EXCEPTION
      'provision_personal_workspace_for_current_user: workspace % already exists without matching self-membership',
      v_user_id;
  END IF;

  INSERT INTO workspaces (workspace_id, name)
  VALUES (v_user_id, v_user_id);

  INSERT INTO workspace_members (workspace_id, user_id)
  VALUES (v_user_id, v_user_id);

  INSERT INTO workspace_settings (workspace_id, reporting_currency, timezone)
  VALUES (v_user_id, 'USD', v_timezone);

  RETURN v_user_id;
END;
$$;

CREATE FUNCTION create_workspace_for_current_user(p_name TEXT, p_timezone TEXT)
RETURNS TABLE(workspace_id TEXT, name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_workspace_id TEXT;
  v_timezone TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_timezone := btrim(p_timezone);

  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'create_workspace_for_current_user: app.user_id must be set';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'create_workspace_for_current_user: p_name must be non-empty';
  END IF;

  IF v_timezone IS NULL OR v_timezone = '' THEN
    RAISE EXCEPTION 'create_workspace_for_current_user: p_timezone must be non-empty';
  END IF;

  v_workspace_id := gen_random_uuid()::text;

  INSERT INTO workspaces (workspace_id, name)
  VALUES (v_workspace_id, btrim(p_name));

  INSERT INTO workspace_members (workspace_id, user_id)
  VALUES (v_workspace_id, v_user_id);

  INSERT INTO workspace_settings (workspace_id, reporting_currency, timezone)
  VALUES (v_workspace_id, 'USD', v_timezone);

  RETURN QUERY
  SELECT v_workspace_id, btrim(p_name);
END;
$$;

REVOKE ALL ON FUNCTION provision_personal_workspace_for_current_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_workspace_for_current_user(TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION provision_personal_workspace_for_current_user(TEXT) TO app;
GRANT EXECUTE ON FUNCTION create_workspace_for_current_user(TEXT, TEXT) TO app;
