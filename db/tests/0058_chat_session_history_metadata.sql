BEGIN;

SELECT pg_catalog.set_config('app.user_id', 'local', true);
SELECT pg_catalog.set_config('app.workspace_id', 'local', true);

DROP INDEX public.chat_sessions_user_workspace_last_message_idx;

ALTER TABLE public.chat_sessions
  DROP COLUMN title,
  DROP COLUMN last_message_at;

INSERT INTO public.chat_sessions (
  session_id,
  user_id,
  workspace_id,
  status,
  created_at,
  updated_at
) VALUES
  (
    '0058-text-session',
    'local',
    'local',
    'idle',
    '2026-01-01 10:00:00+00',
    '2026-01-01 12:00:00+00'
  ),
  (
    '0058-attachment-session',
    'local',
    'local',
    'idle',
    '2026-01-02 10:00:00+00',
    '2026-01-02 12:00:00+00'
  ),
  (
    '0058-untitled-session',
    'local',
    'local',
    'idle',
    '2026-01-03 10:00:00+00',
    '2026-01-03 12:00:00+00'
  ),
  (
    '0058-long-title-session',
    'local',
    'local',
    'idle',
    '2026-01-03 13:00:00+00',
    '2026-01-03 13:00:00+00'
  ),
  (
    '0058-empty-session',
    'local',
    'local',
    'idle',
    '2026-01-04 10:00:00+00',
    '2026-01-04 12:00:00+00'
  ),
  (
    '0058-assistant-only-session',
    'local',
    'local',
    'idle',
    '2026-01-05 10:00:00+00',
    '2026-01-05 12:00:00+00'
  );

INSERT INTO public.chat_items (
  item_id,
  session_id,
  item_kind,
  state,
  payload,
  created_at,
  updated_at
) VALUES
  (
    '0058-text-user-item',
    '0058-text-session',
    'message',
    'completed',
    jsonb_build_object(
      'role',
      'user',
      'content',
      jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', E'  Reconcile\n   July  '),
        jsonb_build_object('type', 'text', 'text', E'\tbalances  ')
      )
    ),
    '2026-01-01 10:01:00+00',
    '2026-01-01 10:01:00+00'
  ),
  (
    '0058-text-assistant-item',
    '0058-text-session',
    'message',
    'completed',
    jsonb_build_object(
      'role',
      'assistant',
      'content',
      jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Done'))
    ),
    '2026-01-01 10:02:00+00',
    '2026-01-01 10:03:00+00'
  ),
  (
    '0058-attachment-user-item',
    '0058-attachment-session',
    'message',
    'completed',
    jsonb_build_object(
      'role',
      'user',
      'content',
      jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', E' \n '),
        jsonb_build_object(
          'type',
          'file',
          'fileName',
          E' \t ',
          'mediaType',
          'text/plain',
          'base64Data',
          'fixture-bytes'
        ),
        jsonb_build_object(
          'type',
          'file',
          'fileName',
          E'  July\n statement.xlsx ',
          'mediaType',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'base64Data',
          'fixture-bytes'
        )
      )
    ),
    '2026-01-02 10:01:00+00',
    '2026-01-02 10:01:00+00'
  ),
  (
    '0058-untitled-user-item',
    '0058-untitled-session',
    'message',
    'completed',
    jsonb_build_object(
      'role',
      'user',
      'content',
      jsonb_build_array(
        jsonb_build_object(
          'type',
          'image',
          'mediaType',
          'image/png',
          'base64Data',
          'fixture-bytes'
        )
      )
    ),
    '2026-01-03 10:01:00+00',
    '2026-01-03 10:01:00+00'
  ),
  (
    '0058-long-title-user-item',
    '0058-long-title-session',
    'message',
    'completed',
    jsonb_build_object(
      'role',
      'user',
      'content',
      jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', repeat(chr(30028), 201))
      )
    ),
    '2026-01-03 13:01:00+00',
    '2026-01-03 13:01:00+00'
  ),
  (
    '0058-assistant-only-item',
    '0058-assistant-only-session',
    'message',
    'completed',
    jsonb_build_object(
      'role',
      'assistant',
      'content',
      jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'No user message'))
    ),
    '2026-01-05 10:01:00+00',
    '2026-01-05 10:01:00+00'
  );

SELECT pg_catalog.set_config('app.user_id', '', true);
SELECT pg_catalog.set_config('app.workspace_id', '', true);

\ir ../migrations/0058_chat_session_history_metadata.sql
\ir ../migrations/0059_chat_session_history_session_policy.sql
\ir ../migrations/0060_chat_session_history_item_policy.sql
\ir ../migrations/0061_chat_session_history_metadata_backfill.sql
\ir ../migrations/0062_chat_session_history_session_policy_cleanup.sql
\ir ../migrations/0063_chat_session_history_item_policy_cleanup.sql
\ir ../migrations/0064_chat_session_history_metadata_index.sql

SELECT pg_catalog.set_config('app.user_id', 'local', true);
SELECT pg_catalog.set_config('app.workspace_id', 'local', true);

DO $$
DECLARE
  v_title public.chat_sessions.title%TYPE;
  v_last_message_at TIMESTAMPTZ;
  v_index_definition TEXT;
BEGIN
  SELECT session.title, session.last_message_at
    INTO v_title, v_last_message_at
    FROM public.chat_sessions AS session
    WHERE session.session_id = '0058-text-session';

  IF v_title IS DISTINCT FROM 'Reconcile July balances' THEN
    RAISE EXCEPTION
      'chat session metadata test failed: expected normalized text title, found %',
      v_title;
  END IF;

  IF v_last_message_at IS DISTINCT FROM '2026-01-01 10:03:00+00'::TIMESTAMPTZ THEN
    RAISE EXCEPTION
      'chat session metadata test failed: expected latest item activity, found %',
      v_last_message_at;
  END IF;

  SELECT session.title, session.last_message_at
    INTO v_title, v_last_message_at
    FROM public.chat_sessions AS session
    WHERE session.session_id = '0058-attachment-session';

  IF v_title IS DISTINCT FROM 'July statement.xlsx' THEN
    RAISE EXCEPTION
      'chat session metadata test failed: expected attachment filename title, found %',
      v_title;
  END IF;

  IF v_last_message_at IS NULL THEN
    RAISE EXCEPTION
      'chat session metadata test failed: attachment-only user session has no activity';
  END IF;

  SELECT session.title, session.last_message_at
    INTO v_title, v_last_message_at
    FROM public.chat_sessions AS session
    WHERE session.session_id = '0058-untitled-session';

  IF v_title IS NOT NULL OR v_last_message_at IS NULL THEN
    RAISE EXCEPTION
      'chat session metadata test failed: expected untitled user session with activity, found title %, activity %',
      v_title,
      v_last_message_at;
  END IF;

  SELECT session.title
    INTO v_title
    FROM public.chat_sessions AS session
    WHERE session.session_id = '0058-long-title-session';

  IF char_length(v_title) IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION
      'chat session metadata test failed: expected 200-character title, found % characters',
      char_length(v_title);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.chat_sessions AS session
    WHERE session.session_id IN (
      '0058-empty-session',
      '0058-assistant-only-session'
    )
      AND session.last_message_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'chat session metadata test failed: session without a user message received activity';
  END IF;

  SELECT pg_catalog.pg_get_indexdef(index.indexrelid)
    INTO v_index_definition
    FROM pg_catalog.pg_index AS index
    WHERE index.indexrelid =
      'public.chat_sessions_user_workspace_last_message_idx'::REGCLASS;

  IF v_index_definition NOT LIKE
    '%(user_id, workspace_id, last_message_at DESC, session_id DESC) WHERE (last_message_at IS NOT NULL)' THEN
    RAISE EXCEPTION
      'chat session metadata test failed: unexpected history index definition: %',
      v_index_definition;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.chat_items'::REGCLASS,
      'public.chat_sessions'::REGCLASS
    )
      AND policy.polname IN (
        'chat_sessions_0059_history_backfill_access',
        'chat_items_0060_history_backfill_read'
      )
  ) THEN
    RAISE EXCEPTION
      'chat session metadata test failed: temporary migration policy remains installed';
  END IF;
END;
$$;

ROLLBACK;
