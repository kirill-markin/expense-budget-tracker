-- Persistent backend-backed chat sessions and items.
--
-- The backend stores the canonical chat transcript in Postgres, while the UI
-- consumes server snapshots and live SSE updates. Code interpreter containers
-- are session-scoped so a recreated chat session does not accidentally reuse a
-- different session's container state.

DROP TABLE public.chat_code_interpreter_containers;

CREATE TABLE public.chat_sessions (
  session_id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                  TEXT        NOT NULL REFERENCES public.users(user_id),
  workspace_id             TEXT        NOT NULL REFERENCES public.workspaces(workspace_id),
  status                   TEXT        NOT NULL CHECK (status IN ('idle', 'running', 'interrupted')),
  active_run_heartbeat_at  TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_sessions_user_workspace_created_idx
  ON public.chat_sessions (user_id, workspace_id, created_at DESC, session_id DESC);

CREATE TABLE public.chat_items (
  item_id      TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id   TEXT        NOT NULL REFERENCES public.chat_sessions(session_id) ON DELETE CASCADE,
  item_order   BIGINT      GENERATED ALWAYS AS IDENTITY,
  item_kind    TEXT        NOT NULL CHECK (item_kind IN ('message')),
  state        TEXT        NOT NULL CHECK (state IN ('in_progress', 'completed', 'error', 'cancelled')),
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_items_session_order_idx
  ON public.chat_items (session_id, item_order);

CREATE TABLE public.chat_code_interpreter_containers (
  session_id    TEXT        PRIMARY KEY REFERENCES public.chat_sessions(session_id) ON DELETE CASCADE,
  container_id  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_sessions_self_access ON public.chat_sessions
  FOR ALL
  USING (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );

ALTER TABLE public.chat_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_items FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_items_self_access ON public.chat_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.chat_sessions AS s
      WHERE s.session_id = chat_items.session_id
        AND s.user_id = current_setting('app.user_id', true)
        AND s.workspace_id = current_setting('app.workspace_id', true)
        AND current_app_user_has_selected_workspace_access()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.chat_sessions AS s
      WHERE s.session_id = chat_items.session_id
        AND s.user_id = current_setting('app.user_id', true)
        AND s.workspace_id = current_setting('app.workspace_id', true)
        AND current_app_user_has_selected_workspace_access()
    )
  );

ALTER TABLE public.chat_code_interpreter_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_code_interpreter_containers FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_code_interpreter_containers_self_access ON public.chat_code_interpreter_containers
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.chat_sessions AS s
      WHERE s.session_id = chat_code_interpreter_containers.session_id
        AND s.user_id = current_setting('app.user_id', true)
        AND s.workspace_id = current_setting('app.workspace_id', true)
        AND current_app_user_has_selected_workspace_access()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.chat_sessions AS s
      WHERE s.session_id = chat_code_interpreter_containers.session_id
        AND s.user_id = current_setting('app.user_id', true)
        AND s.workspace_id = current_setting('app.workspace_id', true)
        AND current_app_user_has_selected_workspace_access()
    )
  );

REVOKE ALL ON TABLE public.chat_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_sessions FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_sessions TO app;

REVOKE ALL ON TABLE public.chat_items FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_items FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_items TO app;

REVOKE ALL ON TABLE public.chat_code_interpreter_containers FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_code_interpreter_containers FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_code_interpreter_containers TO app;
