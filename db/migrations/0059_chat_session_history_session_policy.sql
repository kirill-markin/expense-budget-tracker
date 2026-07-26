-- Install opt-in session access for the metadata backfill migration.

SET LOCAL lock_timeout = '30s';

-- Forced RLS applies to the migration owner in production. This role-scoped
-- policy remains inert unless the backfill enables its transaction-local
-- setting.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY chat_sessions_0059_history_backfill_access
       ON public.chat_sessions
       FOR ALL
       TO %I
       USING (
         current_setting(
           ''app.chat_session_history_metadata_backfill'',
           true
         ) = ''enabled''
       )
       WITH CHECK (
         current_setting(
           ''app.chat_session_history_metadata_backfill'',
           true
         ) = ''enabled''
       )',
    current_user
  );
END;
$$;
