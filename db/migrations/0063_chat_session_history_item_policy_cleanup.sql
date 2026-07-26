-- Remove the temporary item access used by the metadata backfill.

SET LOCAL lock_timeout = '30s';

DROP POLICY chat_items_0060_history_backfill_read
  ON public.chat_items;
