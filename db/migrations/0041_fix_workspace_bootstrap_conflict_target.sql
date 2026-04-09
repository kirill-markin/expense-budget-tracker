-- Fix PL/pgSQL conflict-target ambiguity in workspace bootstrap helpers.
--
-- Applied migrations are immutable, so this correction ships as a new
-- migration instead of editing 0039 or 0040 in place.
--
-- The ambiguity comes from PL/pgSQL output names and local variables sharing
-- identifiers with table columns. In this case, `ON CONFLICT (workspace_id)`
-- is not explicit enough inside these helpers because `workspace_id` can be
-- resolved as either a function-level identifier or a table column.
--
-- A schema-qualified table name alone does not make that conflict target
-- unambiguous, so the helpers use the named primary-key constraint
-- `workspace_settings_pkey` deliberately.

CREATE OR REPLACE FUNCTION ensure_current_user_has_workspace(p_name TEXT, p_timezone TEXT)
RETURNS TABLE(workspace_id TEXT, name TEXT, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_workspace_id TEXT;
  v_workspace_name TEXT;
  v_name TEXT;
  v_timezone TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_name := btrim(p_name);
  v_timezone := btrim(p_timezone);

  IF v_user_id IS NULL OR v_user_id = '' THEN
    RAISE EXCEPTION 'ensure_current_user_has_workspace: app.user_id must be set';
  END IF;

  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'ensure_current_user_has_workspace: p_name must be non-empty';
  END IF;

  IF v_timezone IS NULL OR v_timezone = '' THEN
    RAISE EXCEPTION 'ensure_current_user_has_workspace: p_timezone must be non-empty';
  END IF;

  -- Serialize first-workspace bootstrap per user across all helper entrypoints.
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(v_user_id), 1, 16))::bit(64))::bigint);

  SELECT w.workspace_id, w.name
    INTO v_workspace_id, v_workspace_name
    FROM public.workspaces w
    JOIN public.workspace_members wm ON wm.workspace_id = w.workspace_id
    WHERE wm.user_id = v_user_id
    ORDER BY w.created_at DESC, w.workspace_id DESC
    LIMIT 1;

  IF v_workspace_id IS NOT NULL THEN
    -- This helper is an idempotent ensure/bootstrap path. Reusing an existing
    -- workspace must no-op when workspace_settings already exists; that is
    -- intentional conflict handling, not a fallback and not error masking.
    INSERT INTO public.workspace_settings (workspace_id, reporting_currency, timezone)
    VALUES (v_workspace_id, 'USD', v_timezone)
    ON CONFLICT ON CONSTRAINT workspace_settings_pkey DO NOTHING;

    RETURN QUERY
    SELECT v_workspace_id, v_workspace_name, FALSE;
    RETURN;
  END IF;

  v_workspace_id := gen_random_uuid()::text;

  INSERT INTO public.workspaces (workspace_id, name)
  VALUES (v_workspace_id, v_name);

  INSERT INTO public.workspace_members (workspace_id, user_id)
  VALUES (v_workspace_id, v_user_id);

  INSERT INTO public.workspace_settings (workspace_id, reporting_currency, timezone)
  VALUES (v_workspace_id, 'USD', v_timezone);

  RETURN QUERY
  SELECT v_workspace_id, v_name, TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION auth.resolve_login_workspace_id(
  p_user_id TEXT,
  p_name TEXT,
  p_timezone TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_workspace_id TEXT;
  v_name TEXT;
  v_timezone TEXT;
  v_workspace_count INTEGER;
BEGIN
  v_name := btrim(p_name);
  v_timezone := btrim(p_timezone);

  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'resolve_login_workspace_id: p_user_id must be non-empty';
  END IF;

  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'resolve_login_workspace_id: p_name must be non-empty';
  END IF;

  IF v_timezone IS NULL OR v_timezone = '' THEN
    RAISE EXCEPTION 'resolve_login_workspace_id: p_timezone must be non-empty';
  END IF;

  -- Serialize first-workspace bootstrap per user across all helper entrypoints.
  PERFORM pg_advisory_xact_lock((('x' || substr(md5(p_user_id), 1, 16))::bit(64))::bigint);

  SELECT COUNT(*)::INTEGER
    INTO v_workspace_count
    FROM public.workspace_members
    WHERE user_id = p_user_id;

  IF v_workspace_count > 1 THEN
    RETURN NULL;
  END IF;

  SELECT w.workspace_id
    INTO v_workspace_id
    FROM public.workspaces w
    JOIN public.workspace_members wm ON wm.workspace_id = w.workspace_id
    WHERE wm.user_id = p_user_id
    ORDER BY w.created_at DESC, w.workspace_id DESC
    LIMIT 1;

  IF v_workspace_id IS NOT NULL THEN
    -- This helper is an idempotent ensure/bootstrap path. Reusing an existing
    -- workspace must no-op when workspace_settings already exists; that is
    -- intentional conflict handling, not a fallback and not error masking.
    INSERT INTO public.workspace_settings (workspace_id, reporting_currency, timezone)
    VALUES (v_workspace_id, 'USD', v_timezone)
    ON CONFLICT ON CONSTRAINT workspace_settings_pkey DO NOTHING;

    RETURN v_workspace_id;
  END IF;

  v_workspace_id := gen_random_uuid()::text;

  INSERT INTO public.workspaces (workspace_id, name)
  VALUES (v_workspace_id, v_name);

  INSERT INTO public.workspace_members (workspace_id, user_id)
  VALUES (v_workspace_id, p_user_id);

  INSERT INTO public.workspace_settings (workspace_id, reporting_currency, timezone)
  VALUES (v_workspace_id, 'USD', v_timezone);

  RETURN v_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION ensure_current_user_has_workspace(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_current_user_has_workspace(TEXT, TEXT) TO app;

REVOKE ALL ON FUNCTION auth.resolve_login_workspace_id(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_login_workspace_id(TEXT, TEXT, TEXT) TO auth_service;
