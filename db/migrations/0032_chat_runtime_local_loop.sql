ALTER TABLE public.chat_sessions
  DROP COLUMN IF EXISTS openai_conversation_id;

DROP TABLE IF EXISTS public.chat_code_interpreter_containers;
