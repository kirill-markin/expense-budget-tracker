-- Add the chat history pagination index after the metadata backfill commits.

SET LOCAL lock_timeout = '30s';

-- A regular index build blocks table writers but remains compatible with
-- ordinary SELECT reads. The migration runner intentionally wraps each file in
-- its own transaction, so concurrent index creation is not available here.
CREATE INDEX chat_sessions_user_workspace_last_message_idx
  ON public.chat_sessions (
    user_id,
    workspace_id,
    last_message_at DESC,
    session_id DESC
  )
  WHERE last_message_at IS NOT NULL;
