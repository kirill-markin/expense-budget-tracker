-- Per-user chat turn counter used to rate limit demo accounts.
--
-- Deliberately scoped by user only, with no workspace_id column and no
-- workspace predicate in its policy. chat_sessions_self_access requires
-- workspace_id = current_setting('app.workspace_id', true), so a client that
-- creates a fresh workspace per run never sees its own earlier turns. A
-- workspace-scoped counter would therefore be trivially bypassable.

CREATE TABLE public.chat_turn_rate_events (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_turn_rate_events_user_created_idx
  ON public.chat_turn_rate_events (user_id, created_at DESC);

ALTER TABLE public.chat_turn_rate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_turn_rate_events FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_turn_rate_events_self_access
  ON public.chat_turn_rate_events
  FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

REVOKE ALL ON TABLE public.chat_turn_rate_events FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_turn_rate_events FROM api_sql_executor;
GRANT SELECT, INSERT, DELETE ON TABLE public.chat_turn_rate_events TO app;

REVOKE ALL ON SEQUENCE public.chat_turn_rate_events_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.chat_turn_rate_events_id_seq FROM api_sql_executor;
GRANT USAGE ON SEQUENCE public.chat_turn_rate_events_id_seq TO app;
