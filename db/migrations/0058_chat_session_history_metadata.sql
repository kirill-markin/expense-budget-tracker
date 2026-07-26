-- Add nullable chat history metadata without changing existing application writes.

SET LOCAL lock_timeout = '30s';

ALTER TABLE public.chat_sessions
  ADD COLUMN title VARCHAR(200) NULL,
  ADD COLUMN last_message_at TIMESTAMPTZ NULL;
