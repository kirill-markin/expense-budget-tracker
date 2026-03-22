-- Server-managed chat code interpreter containers.
--
-- Container ownership must be bound to the authenticated app user and the
-- currently selected workspace on the server side. The browser must not
-- control or persist these IDs.

CREATE TABLE public.chat_code_interpreter_containers (
  user_id      TEXT        NOT NULL REFERENCES public.users(user_id),
  workspace_id TEXT        NOT NULL REFERENCES public.workspaces(workspace_id),
  container_id TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

ALTER TABLE public.chat_code_interpreter_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_code_interpreter_containers FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_code_interpreter_containers_self_access ON public.chat_code_interpreter_containers
  FOR ALL
  USING (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
  );

REVOKE ALL ON TABLE public.chat_code_interpreter_containers FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_code_interpreter_containers FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_code_interpreter_containers TO app;
