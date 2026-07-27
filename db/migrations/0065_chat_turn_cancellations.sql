SET LOCAL lock_timeout = '30s';

CREATE TABLE public.chat_turn_cancellations (
  session_id    TEXT        NOT NULL REFERENCES public.chat_sessions(session_id) ON DELETE CASCADE,
  turn_id       TEXT        NOT NULL,
  cancelled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, turn_id)
);

ALTER TABLE public.chat_turn_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_turn_cancellations FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_turn_cancellations_self_access
  ON public.chat_turn_cancellations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.chat_sessions AS session
      WHERE session.session_id = chat_turn_cancellations.session_id
        AND session.user_id = current_setting('app.user_id', true)
        AND session.workspace_id = current_setting('app.workspace_id', true)
        AND current_app_user_has_selected_workspace_access()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.chat_sessions AS session
      WHERE session.session_id = chat_turn_cancellations.session_id
        AND session.user_id = current_setting('app.user_id', true)
        AND session.workspace_id = current_setting('app.workspace_id', true)
        AND current_app_user_has_selected_workspace_access()
    )
  );

REVOKE ALL ON TABLE public.chat_turn_cancellations FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_turn_cancellations FROM api_sql_executor;
GRANT SELECT, INSERT ON TABLE public.chat_turn_cancellations TO app;
