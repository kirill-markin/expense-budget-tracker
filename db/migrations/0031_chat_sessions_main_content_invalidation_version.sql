ALTER TABLE public.chat_sessions
ADD COLUMN main_content_invalidation_version BIGINT NOT NULL DEFAULT 0;
