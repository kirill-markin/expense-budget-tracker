-- OpenTelemetry spans of the app's own tracer, one row per span.
--
-- Attribute names follow the OpenTelemetry GenAI semantic conventions. No
-- message content is stored: a span names the chat_items rows it concerns by
-- id, so the transcript keeps a single home and its existing access rules.
--
-- The web task's span exporter writes rows of many users and workspaces in one
-- batch, with no app.user_id or app.workspace_id context, so app may insert any
-- row and read none. Rows go away through the foreign key cascades when
-- delete_workspace_for_current_user deletes the chat sessions and the workspace.
-- user_id has no foreign key, like chat_turn_rate_events: a user is never
-- deleted while their chats exist.

SET LOCAL lock_timeout = '30s';

CREATE TABLE public.llm_telemetry_spans (
  trace_id            TEXT        NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  span_id             TEXT        NOT NULL CHECK (span_id ~ '^[0-9a-f]{16}$'),
  parent_span_id      TEXT        CHECK (parent_span_id ~ '^[0-9a-f]{16}$'),
  name                TEXT        NOT NULL,
  -- Value of the gen_ai.operation.name attribute.
  operation_name      TEXT        NOT NULL,
  status_code         TEXT        NOT NULL CHECK (status_code IN ('unset', 'ok', 'error')),
  status_message      TEXT,
  start_time          TIMESTAMPTZ NOT NULL,
  end_time            TIMESTAMPTZ NOT NULL,
  user_id             TEXT        NOT NULL,
  workspace_id        TEXT        NOT NULL REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE,
  session_id          TEXT        REFERENCES public.chat_sessions(session_id) ON DELETE CASCADE,
  -- Every span attribute, keyed by its OpenTelemetry name.
  attributes          JSONB       NOT NULL,
  -- service.name, service.version, deployment.environment.name and the other
  -- attributes of the exporting process.
  resource_attributes JSONB       NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trace_id, span_id)
);

CREATE INDEX llm_telemetry_spans_session_start_idx
  ON public.llm_telemetry_spans (session_id, start_time);
CREATE INDEX llm_telemetry_spans_workspace_start_idx
  ON public.llm_telemetry_spans (workspace_id, start_time);
CREATE INDEX llm_telemetry_spans_user_start_idx
  ON public.llm_telemetry_spans (user_id, start_time);
CREATE INDEX llm_telemetry_spans_start_idx
  ON public.llm_telemetry_spans (start_time);

ALTER TABLE public.llm_telemetry_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_telemetry_spans FORCE ROW LEVEL SECURITY;

CREATE POLICY llm_telemetry_spans_app_insert
  ON public.llm_telemetry_spans
  FOR INSERT
  TO app
  WITH CHECK (true);

REVOKE ALL ON TABLE public.llm_telemetry_spans FROM PUBLIC;
REVOKE ALL ON TABLE public.llm_telemetry_spans FROM api_sql_executor;
REVOKE ALL ON TABLE public.llm_telemetry_spans FROM api_sql_reader;
GRANT INSERT ON TABLE public.llm_telemetry_spans TO app;

-- Verify before commit, so a shape that silently failed to constrain anything
-- cannot be recorded as applied.
DO $$
DECLARE
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_fk RECORD;
BEGIN
  SELECT relation.relrowsecurity, relation.relforcerowsecurity
    INTO v_rls_enabled, v_rls_forced
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.llm_telemetry_spans'::regclass;

  IF NOT FOUND OR NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION
      'llm_telemetry_spans invariant failed: the table must exist with enabled and forced row level security';
  END IF;

  FOR v_fk IN
    SELECT expected.column_name, expected.referenced_table, constraint_record.confdeltype
      FROM (
        VALUES
          ('workspace_id', 'public.workspaces'::regclass),
          ('session_id', 'public.chat_sessions'::regclass)
      ) AS expected(column_name, referenced_table)
      LEFT JOIN pg_catalog.pg_constraint AS constraint_record
        ON constraint_record.conrelid = 'public.llm_telemetry_spans'::regclass
        AND constraint_record.contype = 'f'
        AND constraint_record.confrelid = expected.referenced_table
        AND constraint_record.conkey = ARRAY[(
          SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = 'public.llm_telemetry_spans'::regclass
              AND attribute.attname = expected.column_name
        )]::INT2[]
  LOOP
    -- 'c' is ON DELETE CASCADE. A span outliving its workspace or chat session
    -- would keep data the deletion flow promised to remove.
    IF v_fk.confdeltype IS DISTINCT FROM 'c' THEN
      RAISE EXCEPTION
        'llm_telemetry_spans invariant failed: % must be an ON DELETE CASCADE foreign key to %, found delete action %',
        v_fk.column_name,
        v_fk.referenced_table,
        v_fk.confdeltype;
    END IF;
  END LOOP;

  PERFORM 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.llm_telemetry_spans'::regclass
      AND policy.polname = 'llm_telemetry_spans_app_insert'
      AND policy.polcmd = 'a'
      AND policy.polroles = ARRAY['app'::regrole::oid];

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'llm_telemetry_spans invariant failed: llm_telemetry_spans_app_insert must be an INSERT policy for app';
  END IF;
END;
$$;

SET LOCAL lock_timeout = '0';
