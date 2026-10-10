-- Chat file metadata for the per-session sandbox file space.
--
-- Rows describe objects in the chat files bucket: user attachments, files the
-- sandbox produced, and derivatives generated from either. `path` is the path
-- the sandbox sees, unique inside one session; `object_key` is the storage key.
--
-- Chat files are deliberately outside the restricted SQL surface: the machine
-- SQL roles api_sql_reader and api_sql_executor get nothing here, so no agent
-- can enumerate another surface's file metadata or object keys through SQL.

CREATE TABLE public.chat_files (
  file_id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id               TEXT        NOT NULL REFERENCES public.chat_sessions(session_id) ON DELETE CASCADE,
  user_id                  TEXT        NOT NULL REFERENCES public.users(user_id),
  workspace_id             TEXT        NOT NULL REFERENCES public.workspaces(workspace_id),
  origin                   TEXT        NOT NULL CHECK (origin IN ('attachment', 'work', 'derived')),
  source_file_id           TEXT        NULL REFERENCES public.chat_files(file_id) ON DELETE CASCADE,
  path                     TEXT        NOT NULL,
  object_key               TEXT        NOT NULL UNIQUE,
  media_type               TEXT        NOT NULL,
  size_bytes               BIGINT      NOT NULL CHECK (size_bytes >= 0),
  sha256                   TEXT        NOT NULL CHECK (length(sha256) = 64),
  derivatives_prepared_at  TIMESTAMPTZ NULL,
  derivatives_error        TEXT        NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, path),

  -- A derivative always names its source, and nothing else carries one.
  CONSTRAINT chat_files_derived_source_check
    CHECK ((origin = 'derived') = (source_file_id IS NOT NULL))
);

-- Supports the self-referencing ON DELETE CASCADE scan for derivatives.
CREATE INDEX chat_files_source_file_id_idx
  ON public.chat_files (source_file_id);

ALTER TABLE public.chat_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_files FORCE ROW LEVEL SECURITY;

-- The parent session must agree with the row's own owner columns: foreign key
-- validation runs as the table owner and bypasses RLS, so without the EXISTS a
-- row could be bound to someone else's session or another workspace's session.
CREATE POLICY chat_files_self_access ON public.chat_files
  FOR ALL
  USING (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
    AND EXISTS (
      SELECT 1
      FROM public.chat_sessions AS s
      WHERE s.session_id = chat_files.session_id
        AND s.user_id = current_setting('app.user_id', true)
        AND s.workspace_id = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
    AND EXISTS (
      SELECT 1
      FROM public.chat_sessions AS s
      WHERE s.session_id = chat_files.session_id
        AND s.user_id = current_setting('app.user_id', true)
        AND s.workspace_id = current_setting('app.workspace_id', true)
    )
  );

REVOKE ALL ON TABLE public.chat_files FROM PUBLIC;
REVOKE ALL ON TABLE public.chat_files FROM api_sql_reader;
REVOKE ALL ON TABLE public.chat_files FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_files TO app;
