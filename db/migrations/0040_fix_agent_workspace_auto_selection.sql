-- Auto-select a workspace for new agent API keys only when the choice is
-- unambiguous.
--
-- This preserves first-login bootstrap and single-workspace convenience while
-- preventing a new API key from silently targeting an arbitrary workspace for
-- users who already belong to multiple workspaces.

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
    INSERT INTO public.workspace_settings (workspace_id, reporting_currency, timezone)
    VALUES (v_workspace_id, 'USD', v_timezone)
    ON CONFLICT (workspace_id) DO NOTHING;

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

REVOKE ALL ON FUNCTION auth.resolve_login_workspace_id(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_login_workspace_id(TEXT, TEXT, TEXT) TO auth_service;
