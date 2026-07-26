-- Remove the temporary session access used by the metadata backfill.

SET LOCAL lock_timeout = '30s';

DROP POLICY chat_sessions_0059_history_backfill_access
  ON public.chat_sessions;
