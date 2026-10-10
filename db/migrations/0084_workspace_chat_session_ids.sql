-- Let the application enumerate a workspace's chat sessions before deleting it,
-- and make the single-member precondition of the deletion real.
--
-- public.delete_workspace_for_current_user deletes every chat_sessions row of
-- the workspace, including rows a former member left behind, and chat_files
-- cascades with them. It runs inside Postgres and cannot reach object storage,
-- so the application removes the stored objects first, which it can only do for
-- sessions it can name. Ordinary RLS shows a caller its own sessions only, and
-- the chat files bucket has no expiration rule, so a former member's objects
-- would never be reclaimed by anything.
--
-- Session IDs are opaque, serve to build object keys server-side, and are
-- returned only to a member of the workspace.
--
-- Counting the members of a workspace needs the same deletion-owner visibility
-- that 0054 gave chat_sessions, because forced RLS otherwise shows the owner the
-- caller's own membership only. Without it the deletion's own member count can
-- never exceed one and its guard never fires, so the guard is moved here to
-- where the policy makes it truthful: after the target workspace is selected.
-- The lister repeats the guard because objects are deleted before the deletion
-- runs, and a workspace the deletion would refuse must lose nothing.
--
-- The visibility policy deliberately does not call
-- public.current_app_user_has_selected_workspace_access(): that helper selects
-- from workspace_members, so a policy on workspace_members that calls it
-- re-enters this policy, and Postgres detects RLS recursion within one rewrite
-- only, not across a plpgsql call. Membership in the selected workspace is
-- already proven by each caller before it selects the target, and the policy is
-- pinned to the deletion owner and to app.workspace_id.

-- Workspace deletion and this lister run as the same SECURITY DEFINER owner.
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
      'chat file cleanup precondition failed: public.delete_workspace_for_current_user(text) must exist and be SECURITY DEFINER';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE POLICY workspace_members_workspace_delete_owner_visibility
       ON public.workspace_members
       AS PERMISSIVE
       FOR SELECT
       TO %I
       USING (
         CURRENT_USER = %L::NAME
         AND current_setting(''app.workspace_id'', true) IS NOT NULL
         AND workspace_id = current_setting(''app.workspace_id'', true)
       )',
    v_function_owner_name,
    v_function_owner_name
  );
END;
$$;

-- Keep the workspace cleanup contract of 0076 unchanged, except for taking the
-- member count after the target workspace is selected, which is the only point
-- at which the owner can see more than its own membership row.
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

  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    p_workspace_id
  );

  SELECT COUNT(*)::INTEGER INTO v_member_count
    FROM public.workspace_members AS member
    WHERE member.workspace_id = p_workspace_id;

  IF v_member_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: workspace deletion is only allowed when the workspace has exactly one member; found %',
      COALESCE(v_member_count, 0);
  END IF;

  -- chat_items cascade from chat_sessions.
  DELETE FROM public.chat_sessions AS session
    WHERE session.workspace_id = p_workspace_id;
  DELETE FROM public.budget_lines AS line
    WHERE line.workspace_id = p_workspace_id;
  DELETE FROM public.budget_lines_archive AS archived_line
    WHERE archived_line.workspace_id = p_workspace_id;
  DELETE FROM public.budget_adjustments_archive AS archived_adjustment
    WHERE archived_adjustment.workspace_id = p_workspace_id;
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

CREATE FUNCTION public.list_workspace_chat_session_ids_for_current_user(
  p_workspace_id TEXT
)
RETURNS TABLE(session_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id TEXT;
  v_previous_workspace_id TEXT;
  v_member_count INTEGER;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      'list_workspace_chat_session_ids_for_current_user: app.user_id is not set';
  END IF;

  v_previous_workspace_id := current_setting('app.workspace_id', true);
  IF v_previous_workspace_id IS NULL THEN
    RAISE EXCEPTION
      'list_workspace_chat_session_ids_for_current_user: app.workspace_id is not set';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members AS member
    WHERE member.workspace_id = p_workspace_id
      AND member.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Workspace not found or not a member';
  END IF;

  -- Every owner visibility policy is scoped to the selected workspace, so the
  -- target has to be selected while reading and restored afterwards, exactly as
  -- the workspace deletion does.
  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    p_workspace_id
  );

  SELECT COUNT(*)::INTEGER INTO v_member_count
    FROM public.workspace_members AS member
    WHERE member.workspace_id = p_workspace_id;

  IF v_member_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'list_workspace_chat_session_ids_for_current_user: workspace deletion is only allowed when the workspace has exactly one member; found %',
      COALESCE(v_member_count, 0);
  END IF;

  RETURN QUERY
    SELECT chat_session.session_id
      FROM public.chat_sessions AS chat_session
      WHERE chat_session.workspace_id = p_workspace_id;

  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    v_previous_workspace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_workspace_chat_session_ids_for_current_user(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_workspace_chat_session_ids_for_current_user(TEXT) TO app;

-- Forced RLS applies to a non-bypass function owner, and every visibility
-- policy names the workspace deletion owner. A different owner here would
-- return no rows and leak objects silently instead of failing.
--
-- The migration role bypasses RLS in CI and local Docker, so the policy and the
-- guard ordering it makes truthful cannot be exercised before production RDS:
-- assert their shape instead.

-- Make pg_get_expr output deterministic for exact PostgreSQL 18 policy checks.
SET LOCAL search_path = pg_catalog, public;

DO $$
DECLARE
  v_lister_owner_name NAME;
  v_deleter_owner_name NAME;
  v_deleter_owner_oid OID;
  v_expected_using_expression TEXT;
  v_policy RECORD;
  v_routine_name TEXT;
  v_routine_definition TEXT;
  v_workspace_selection_position INTEGER;
  v_member_count_position INTEGER;
  v_definition_after_member_count TEXT;
  v_workspace_restore_position INTEGER;
  v_single_member_raise_position INTEGER;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(procedure_record.proowner)
    INTO v_lister_owner_name
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.list_workspace_chat_session_ids_for_current_user(text)'
    );

  SELECT
    procedure_record.proowner,
    pg_catalog.pg_get_userbyid(procedure_record.proowner)
    INTO v_deleter_owner_oid, v_deleter_owner_name
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.delete_workspace_for_current_user(text)'
    );

  IF v_lister_owner_name IS DISTINCT FROM v_deleter_owner_name THEN
    RAISE EXCEPTION
      'chat file cleanup precondition failed: chat session lister owner % must match workspace deletion owner %',
      v_lister_owner_name,
      v_deleter_owner_name;
  END IF;

  v_expected_using_expression := pg_catalog.format(
    '((CURRENT_USER = %L::name) AND (current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)))',
    v_deleter_owner_name
  );

  SELECT
    policy.polpermissive AS permissive,
    policy.polcmd::TEXT AS command,
    policy.polroles AS role_oids,
    pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
    pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
    INTO v_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.workspace_members'::regclass
      AND policy.polname = 'workspace_members_workspace_delete_owner_visibility';

  IF NOT FOUND
    OR v_policy.permissive IS DISTINCT FROM true
    OR v_policy.command IS DISTINCT FROM 'r'
    OR v_policy.role_oids IS DISTINCT FROM ARRAY[v_deleter_owner_oid]
    OR v_policy.using_expression IS DISTINCT FROM v_expected_using_expression
    OR v_policy.check_expression IS NOT NULL
  THEN
    RAISE EXCEPTION
      'chat file cleanup policy invariant failed: expected a permissive SELECT policy for role % with USING % and no WITH CHECK, found permissive %, command %, roles %, USING %, WITH CHECK %',
      v_deleter_owner_name,
      v_expected_using_expression,
      v_policy.permissive,
      v_policy.command,
      v_policy.role_oids,
      v_policy.using_expression,
      v_policy.check_expression;
  END IF;

  FOREACH v_routine_name IN ARRAY ARRAY[
    'public.delete_workspace_for_current_user(text)',
    'public.list_workspace_chat_session_ids_for_current_user(text)'
  ]
  LOOP
    SELECT pg_catalog.pg_get_functiondef(procedure_record.oid)
      INTO v_routine_definition
      FROM pg_catalog.pg_proc AS procedure_record
      WHERE procedure_record.oid = pg_catalog.to_regprocedure(v_routine_name);

    v_workspace_selection_position := POSITION(
      'SET LOCAL app.workspace_id = %L'
      IN v_routine_definition
    );
    v_member_count_position := POSITION(
      'INTO v_member_count'
      IN v_routine_definition
    );
    v_definition_after_member_count := CASE
      WHEN v_member_count_position = 0 THEN ''
      ELSE SUBSTRING(v_routine_definition FROM v_member_count_position)
    END;

    -- Both routines select the target workspace and later restore the previous
    -- one with the same literal, and POSITION finds only the first of the two.
    -- Requiring one occurrence after the count as well bounds the count between
    -- them: a count taken after the restore would run under the previous
    -- workspace and be exactly as vacuous as the guard this migration moved.
    v_workspace_restore_position := POSITION(
      'SET LOCAL app.workspace_id = %L'
      IN v_definition_after_member_count
    );

    -- Nothing else pins this wording, and dropping the RAISE would leave both
    -- positions above intact. The application matches it in
    -- DELETE_WORKSPACE_REQUIRES_SINGLE_MEMBER_DB_MESSAGE_PATTERN
    -- (apps/web/src/server/workspaces.ts) to answer 403 instead of 500.
    v_single_member_raise_position := POSITION(
      'workspace deletion is only allowed when the workspace has exactly one member'
      IN v_definition_after_member_count
    );

    IF v_workspace_selection_position = 0
      OR v_member_count_position = 0
      OR v_member_count_position < v_workspace_selection_position
      OR v_workspace_restore_position = 0
      OR v_single_member_raise_position = 0
    THEN
      RAISE EXCEPTION
        'chat file cleanup guard invariant failed: % must count workspace members after selecting the target workspace and before restoring the previous one, and raise the single-member error on that count',
        v_routine_name;
    END IF;
  END LOOP;
END;
$$;
