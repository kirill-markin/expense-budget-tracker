ALTER TABLE public.chat_sessions
ADD COLUMN active_run_id TEXT NULL;

UPDATE public.chat_sessions
SET active_run_id = gen_random_uuid()::text
WHERE status = 'running'
  AND active_run_id IS NULL;
