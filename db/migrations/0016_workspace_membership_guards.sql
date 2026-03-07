-- Guard workspace membership creation behind narrow SECURITY DEFINER helpers.
--
-- Regular app and SQL-API contexts must not be able to INSERT directly into
-- workspace_members, because that is the authorization graph for all
-- workspace-scoped data. Legitimate creation flows now go through dedicated
-- helper functions that either provision the caller's personal workspace or
-- create a brand-new workspace for the caller.

-- ==========================================================================
-- 1. Helper functions
-- ==========================================================================

CREATE FUNCTION provision_personal_workspace_for_current_user()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);

  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'provision_personal_workspace_for_current_user: app.user_id must be set';
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

  INSERT INTO workspace_settings (workspace_id, reporting_currency)
  VALUES (v_user_id, 'USD');

  RETURN v_user_id;
END;
$$;

CREATE FUNCTION create_workspace_for_current_user(p_name TEXT)
RETURNS TABLE(workspace_id TEXT, name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_workspace_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);

  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'create_workspace_for_current_user: app.user_id must be set';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'create_workspace_for_current_user: p_name must be non-empty';
  END IF;

  v_workspace_id := gen_random_uuid()::text;

  INSERT INTO workspaces (workspace_id, name)
  VALUES (v_workspace_id, btrim(p_name));

  INSERT INTO workspace_members (workspace_id, user_id)
  VALUES (v_workspace_id, v_user_id);

  INSERT INTO workspace_settings (workspace_id, reporting_currency)
  VALUES (v_workspace_id, 'USD');

  RETURN QUERY
  SELECT v_workspace_id, btrim(p_name);
END;
$$;

REVOKE ALL ON FUNCTION provision_personal_workspace_for_current_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION create_workspace_for_current_user(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION provision_personal_workspace_for_current_user() TO app;
GRANT EXECUTE ON FUNCTION create_workspace_for_current_user(TEXT) TO app;

-- ==========================================================================
-- 2. Remove direct membership writes from regular roles
-- ==========================================================================

REVOKE INSERT ON TABLE workspace_members FROM app;
REVOKE INSERT ON TABLE workspace_members FROM api_sql_executor;
