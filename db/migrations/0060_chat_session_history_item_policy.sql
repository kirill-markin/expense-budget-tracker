-- Install opt-in item reads for the metadata backfill migration.

SET LOCAL lock_timeout = '30s';

-- Forced RLS applies to the migration owner in production. This role-scoped
-- policy remains inert unless the backfill enables its transaction-local
-- setting.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY chat_items_0060_history_backfill_read
       ON public.chat_items
       FOR SELECT
       TO %I
       USING (
         current_setting(
           ''app.chat_session_history_metadata_backfill'',
           true
         ) = ''enabled''
       )',
    current_user
  );
END;
$$;
