-- Give budget_lines a row identity and collapse it to one row per budget cell,
-- archiving every row this migration removes.
--
-- This is the additive first step of dropping the append-only budget model. The
-- deployed application keeps appending a row per plan change and keeps writing
-- kind explicitly, so this migration adds no unique index and no non-zero check
-- and only gives kind a default; those constraints and the kind drop follow a
-- later application release.
--
-- A zero plan and a missing row mean the same thing and both render as 0, so
-- removing zero rows normalizes the data instead of losing it. Everything the
-- migration deletes is copied into an internal archive table first.

SET LOCAL lock_timeout = '30s';

LOCK TABLE
  public.budget_lines,
  public.budget_adjustments
IN ACCESS EXCLUSIVE MODE;

-- Archive tables are internal history, not a product surface: no endpoint, no
-- view, no UI, and no grant to app, api_sql_executor or api_sql_reader. Their
-- columns mirror the source tables, including the line_id and updated_at
-- columns that this migration adds to budget_lines below.
CREATE TABLE public.budget_lines_archive (
  budget_month   DATE        NOT NULL,
  direction      TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  kind           TEXT        NOT NULL,
  currency       TEXT        NOT NULL,
  planned_value  NUMERIC     NOT NULL,
  workspace_id   TEXT        NOT NULL,
  inserted_at    TIMESTAMPTZ NOT NULL,
  line_id        TEXT        NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  archived_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archive_reason TEXT        NOT NULL
);

CREATE TABLE public.budget_adjustments_archive (
  adjustment_id  TEXT        NOT NULL,
  workspace_id   TEXT        NOT NULL,
  budget_month   DATE        NOT NULL,
  direction      TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  amount         NUMERIC     NOT NULL,
  note           TEXT,
  origin         TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  archived_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archive_reason TEXT        NOT NULL
);

ALTER TABLE public.budget_lines_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_lines_archive FORCE ROW LEVEL SECURITY;
ALTER TABLE public.budget_adjustments_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_adjustments_archive FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.budget_lines_archive FROM PUBLIC;
REVOKE ALL ON TABLE public.budget_lines_archive FROM app;
REVOKE ALL ON TABLE public.budget_lines_archive FROM api_sql_executor;
REVOKE ALL ON TABLE public.budget_lines_archive FROM api_sql_reader;
REVOKE ALL ON TABLE public.budget_adjustments_archive FROM PUBLIC;
REVOKE ALL ON TABLE public.budget_adjustments_archive FROM app;
REVOKE ALL ON TABLE public.budget_adjustments_archive FROM api_sql_executor;
REVOKE ALL ON TABLE public.budget_adjustments_archive FROM api_sql_reader;

-- Forced row-level security also applies to the table owner, so the archives
-- need one owner-only policy to stay reachable at all: this migration writes
-- them, and the SECURITY DEFINER workspace deletion below clears them. No other
-- role holds a privilege on either table, so this policy admits nobody else.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_archive_owner_access
       ON public.budget_lines_archive
       FOR ALL
       TO %I
       USING (true)
       WITH CHECK (true)',
    current_user
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_adjustments_archive_owner_access
       ON public.budget_adjustments_archive
       FOR ALL
       TO %I
       USING (true)
       WITH CHECK (true)',
    current_user
  );
END;
$$;

-- Forced row-level security applies to the migration owner, so the row work
-- below needs transaction-scoped policies on the source tables. They are
-- dropped again below, which is also why every row-level check runs while they
-- exist.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_0076_migration_access
       ON public.budget_lines
       FOR ALL
       TO %I
       USING (true)
       WITH CHECK (true)',
    current_user
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_adjustments_0076_migration_access
       ON public.budget_adjustments
       FOR ALL
       TO %I
       USING (true)
       WITH CHECK (true)',
    current_user
  );
END;
$$;

-- Adding line_id with a volatile default rewrites the table, and a rewrite
-- re-checks budget_lines_direction_check, which migration 0073 added NOT VALID
-- because existing rows could not be inspected before deployment. Report any
-- offending row here instead of failing with a bare constraint violation
-- mid-rewrite, in production only.
DO $$
DECLARE
  v_invalid_direction RECORD;
  v_invalid_direction_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO v_invalid_direction_count
    FROM public.budget_lines AS line
    WHERE line.direction NOT IN ('income', 'spend');

  IF v_invalid_direction_count <> 0 THEN
    SELECT
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category
      INTO v_invalid_direction
      FROM public.budget_lines AS line
      WHERE line.direction NOT IN ('income', 'spend')
      LIMIT 1;

    RAISE EXCEPTION
      'budget_lines direction invariant failed: % rows violate budget_lines_direction_check, for example workspace %, month %, direction %, category %; repair them before this migration rewrites the table',
      v_invalid_direction_count,
      v_invalid_direction.workspace_id,
      v_invalid_direction.budget_month,
      v_invalid_direction.direction,
      v_invalid_direction.category;
  END IF;
END;
$$;

-- Row identity. The append-only model never needed one, so existing rows get a
-- generated line_id before the primary key is added.
ALTER TABLE public.budget_lines
  ADD COLUMN line_id TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT;

ALTER TABLE public.budget_lines
  ADD CONSTRAINT budget_lines_pkey PRIMARY KEY (line_id);

ALTER TABLE public.budget_lines
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE FUNCTION public.set_budget_line_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_budget_line_updated_at() FROM PUBLIC;

CREATE TRIGGER budget_lines_set_updated_at
  BEFORE UPDATE ON public.budget_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.set_budget_line_updated_at();

-- The only remaining kind is 'base'. The default exists so that a later
-- application release can stop writing the column before another migration
-- drops it; the deploy updates the web service before it runs migrations.
ALTER TABLE public.budget_lines
  ALTER COLUMN kind SET DEFAULT 'base';

DO $$
DECLARE
  v_archived_superseded BIGINT;
  v_archived_zero_adjustment BIGINT;
  v_archived_zero_plan BIGINT;
  v_deleted_superseded BIGINT;
  v_deleted_zero_adjustment BIGINT;
  v_deleted_zero_plan BIGINT;
  v_duplicate RECORD;
  v_remaining_zero_adjustment BIGINT;
  v_remaining_zero_plan BIGINT;
  v_stored_superseded BIGINT;
  v_stored_zero_adjustment BIGINT;
  v_stored_zero_plan BIGINT;
BEGIN
  -- Keep the winner of every cell with the tie-break the agent protocol already
  -- documents, and archive the rows it supersedes.
  WITH ranked AS (
    SELECT
      line.line_id,
      ROW_NUMBER() OVER (
        PARTITION BY
          line.workspace_id,
          line.budget_month,
          line.direction,
          line.category,
          line.kind
        ORDER BY
          line.inserted_at DESC,
          line.planned_value DESC,
          line.currency DESC
      ) AS cell_rank
    FROM public.budget_lines AS line
  ),
  deleted AS (
    DELETE FROM public.budget_lines AS line
      WHERE line.line_id IN (
        SELECT ranked.line_id
        FROM ranked
        WHERE ranked.cell_rank > 1
      )
      RETURNING line.*
  ),
  archived AS (
    INSERT INTO public.budget_lines_archive (
      budget_month,
      direction,
      category,
      kind,
      currency,
      planned_value,
      workspace_id,
      inserted_at,
      line_id,
      updated_at,
      archive_reason
    )
    SELECT
      deleted.budget_month,
      deleted.direction,
      deleted.category,
      deleted.kind,
      deleted.currency,
      deleted.planned_value,
      deleted.workspace_id,
      deleted.inserted_at,
      deleted.line_id,
      deleted.updated_at,
      'superseded'
    FROM deleted
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*) FROM deleted),
    (SELECT COUNT(*) FROM archived)
    INTO v_deleted_superseded, v_archived_superseded;

  IF v_archived_superseded IS DISTINCT FROM v_deleted_superseded THEN
    RAISE EXCEPTION
      'budget_lines normalization invariant failed: archived % of the % superseded rows',
      v_archived_superseded,
      v_deleted_superseded;
  END IF;

  -- A zero plan and a missing row are the same statement about a cell.
  WITH deleted AS (
    DELETE FROM public.budget_lines AS line
      WHERE line.planned_value = 0
      RETURNING line.*
  ),
  archived AS (
    INSERT INTO public.budget_lines_archive (
      budget_month,
      direction,
      category,
      kind,
      currency,
      planned_value,
      workspace_id,
      inserted_at,
      line_id,
      updated_at,
      archive_reason
    )
    SELECT
      deleted.budget_month,
      deleted.direction,
      deleted.category,
      deleted.kind,
      deleted.currency,
      deleted.planned_value,
      deleted.workspace_id,
      deleted.inserted_at,
      deleted.line_id,
      deleted.updated_at,
      'zero_plan'
    FROM deleted
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*) FROM deleted),
    (SELECT COUNT(*) FROM archived)
    INTO v_deleted_zero_plan, v_archived_zero_plan;

  IF v_archived_zero_plan IS DISTINCT FROM v_deleted_zero_plan THEN
    RAISE EXCEPTION
      'budget_lines normalization invariant failed: archived % of the % zero plan rows',
      v_archived_zero_plan,
      v_deleted_zero_plan;
  END IF;

  -- A zero adjustment without a note carries no information either.
  WITH deleted AS (
    DELETE FROM public.budget_adjustments AS adjustment
      WHERE adjustment.amount = 0
        AND (
          adjustment.note IS NULL
          OR btrim(adjustment.note) = ''
        )
      RETURNING adjustment.*
  ),
  archived AS (
    INSERT INTO public.budget_adjustments_archive (
      adjustment_id,
      workspace_id,
      budget_month,
      direction,
      category,
      amount,
      note,
      origin,
      created_at,
      updated_at,
      archive_reason
    )
    SELECT
      deleted.adjustment_id,
      deleted.workspace_id,
      deleted.budget_month,
      deleted.direction,
      deleted.category,
      deleted.amount,
      deleted.note,
      deleted.origin,
      deleted.created_at,
      deleted.updated_at,
      'zero_adjustment'
    FROM deleted
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*) FROM deleted),
    (SELECT COUNT(*) FROM archived)
    INTO v_deleted_zero_adjustment, v_archived_zero_adjustment;

  IF v_archived_zero_adjustment IS DISTINCT FROM v_deleted_zero_adjustment THEN
    RAISE EXCEPTION
      'budget_adjustments normalization invariant failed: archived % of the % zero adjustment rows',
      v_archived_zero_adjustment,
      v_deleted_zero_adjustment;
  END IF;

  SELECT
    line.workspace_id,
    line.budget_month,
    line.direction,
    line.category,
    line.kind,
    COUNT(*) AS row_count
    INTO v_duplicate
    FROM public.budget_lines AS line
    GROUP BY
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category,
      line.kind
    HAVING COUNT(*) > 1
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_lines normalization invariant failed: workspace % still has % rows for month %, direction %, category %, kind %',
      v_duplicate.workspace_id,
      v_duplicate.row_count,
      v_duplicate.budget_month,
      v_duplicate.direction,
      v_duplicate.category,
      v_duplicate.kind;
  END IF;

  SELECT COUNT(*)
    INTO v_remaining_zero_plan
    FROM public.budget_lines AS line
    WHERE line.planned_value = 0;

  IF v_remaining_zero_plan <> 0 THEN
    RAISE EXCEPTION
      'budget_lines normalization invariant failed: % zero plan rows remain',
      v_remaining_zero_plan;
  END IF;

  SELECT COUNT(*)
    INTO v_remaining_zero_adjustment
    FROM public.budget_adjustments AS adjustment
    WHERE adjustment.amount = 0
      AND (
        adjustment.note IS NULL
        OR btrim(adjustment.note) = ''
      );

  IF v_remaining_zero_adjustment <> 0 THEN
    RAISE EXCEPTION
      'budget_adjustments normalization invariant failed: % zero adjustment rows without a note remain',
      v_remaining_zero_adjustment;
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE archived_line.archive_reason = 'superseded'
    ),
    COUNT(*) FILTER (
      WHERE archived_line.archive_reason = 'zero_plan'
    )
    INTO v_stored_superseded, v_stored_zero_plan
    FROM public.budget_lines_archive AS archived_line;

  SELECT COUNT(*)
    INTO v_stored_zero_adjustment
    FROM public.budget_adjustments_archive AS archived_adjustment
    WHERE archived_adjustment.archive_reason = 'zero_adjustment';

  IF v_stored_superseded IS DISTINCT FROM v_deleted_superseded
    OR v_stored_zero_plan IS DISTINCT FROM v_deleted_zero_plan
    OR v_stored_zero_adjustment IS DISTINCT FROM v_deleted_zero_adjustment
  THEN
    RAISE EXCEPTION
      'budget archive invariant failed: archived %/%/% rows for % superseded, % zero plan and % zero adjustment deletions',
      v_stored_superseded,
      v_stored_zero_plan,
      v_stored_zero_adjustment,
      v_deleted_superseded,
      v_deleted_zero_plan,
      v_deleted_zero_adjustment;
  END IF;
END;
$$;

DROP POLICY budget_lines_0076_migration_access
  ON public.budget_lines;
DROP POLICY budget_adjustments_0076_migration_access
  ON public.budget_adjustments;

-- Keep the workspace cleanup contract unchanged while extending it to the two
-- internal archive tables, which hold rows of the deleted workspace and have no
-- foreign key to cascade from.
CREATE OR REPLACE FUNCTION public.delete_workspace_for_current_user(
  p_workspace_id TEXT
)
RETURNS TABLE(workspace_id TEXT, name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_deleted_workspace_count INTEGER;
  v_user_id TEXT;
  v_workspace_name TEXT;
  v_member_count INTEGER;
  v_previous_workspace_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: app.user_id is not set';
  END IF;

  v_previous_workspace_id := current_setting('app.workspace_id', true);
  IF v_previous_workspace_id IS NULL THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: app.workspace_id is not set';
  END IF;

  SELECT workspace.name INTO v_workspace_name
    FROM public.workspaces AS workspace
    JOIN public.workspace_members AS member
      ON member.workspace_id = workspace.workspace_id
    WHERE workspace.workspace_id = p_workspace_id
      AND member.user_id = v_user_id;

  IF v_workspace_name IS NULL THEN
    RAISE EXCEPTION 'Workspace not found or not a member';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_member_count
    FROM public.workspace_members AS member
    WHERE member.workspace_id = p_workspace_id;

  IF v_member_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: workspace deletion is only allowed when the workspace has exactly one member; found %',
      COALESCE(v_member_count, 0);
  END IF;

  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    p_workspace_id
  );

  -- chat_items cascade from chat_sessions.
  DELETE FROM public.chat_sessions AS session
    WHERE session.workspace_id = p_workspace_id;
  DELETE FROM public.budget_lines AS line
    WHERE line.workspace_id = p_workspace_id;
  DELETE FROM public.budget_lines_archive AS archived_line
    WHERE archived_line.workspace_id = p_workspace_id;
  DELETE FROM public.budget_adjustments_archive AS archived_adjustment
    WHERE archived_adjustment.workspace_id = p_workspace_id;
  DELETE FROM public.account_metadata AS metadata
    WHERE metadata.workspace_id = p_workspace_id;
  DELETE FROM public.ledger_entries AS entry
    WHERE entry.workspace_id = p_workspace_id;
  DELETE FROM public.workspace_settings AS settings
    WHERE settings.workspace_id = p_workspace_id;

  WITH deleted_members AS (
    DELETE FROM public.workspace_members AS member
      WHERE member.workspace_id = p_workspace_id
      RETURNING member.workspace_id
  )
  DELETE FROM public.workspaces AS workspace
    WHERE workspace.workspace_id = p_workspace_id
      AND EXISTS (
        SELECT 1
        FROM deleted_members AS deleted_member
        WHERE deleted_member.workspace_id = workspace.workspace_id
      );

  GET DIAGNOSTICS v_deleted_workspace_count = ROW_COUNT;
  IF v_deleted_workspace_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'delete_workspace_for_current_user: expected to delete workspace %, deleted % rows',
      p_workspace_id,
      COALESCE(v_deleted_workspace_count, 0);
  END IF;

  EXECUTE pg_catalog.format(
    'SET LOCAL app.workspace_id = %L',
    v_previous_workspace_id
  );

  RETURN QUERY SELECT p_workspace_id, v_workspace_name;
END;
$$;

-- Verify the new identity, the workspace cleanup contract and the archive
-- isolation before commit. The row-level results are checked above, while the
-- transaction-scoped policies still make the source tables readable.
DO $$
DECLARE
  v_archive_table TEXT;
  v_delete_function_configuration TEXT[];
  v_delete_function_definition TEXT;
  v_delete_function_is_security_definer BOOLEAN;
  v_delete_function_owner_name NAME;
  v_owner_name NAME;
  v_policy RECORD;
  v_policy_count INTEGER;
  v_primary_key_columns TEXT;
  v_privilege_name TEXT;
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_role_name NAME;
BEGIN
  SELECT
    pg_catalog.pg_get_constraintdef(constraint_record.oid)
    INTO v_primary_key_columns
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.budget_lines'::regclass
      AND constraint_record.contype = 'p';

  IF v_primary_key_columns IS DISTINCT FROM 'PRIMARY KEY (line_id)' THEN
    RAISE EXCEPTION
      'budget_lines identity invariant failed: expected a primary key on line_id, found %',
      COALESCE(v_primary_key_columns, 'no primary key');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_record
    WHERE trigger_record.tgrelid = 'public.budget_lines'::regclass
      AND trigger_record.tgname = 'budget_lines_set_updated_at'
      AND NOT trigger_record.tgisinternal
  )
  THEN
    RAISE EXCEPTION
      'budget_lines identity invariant failed: the updated_at trigger is missing';
  END IF;

  SELECT
    procedure_record.proconfig,
    procedure_record.prosecdef,
    pg_catalog.pg_get_functiondef(procedure_record.oid),
    pg_catalog.pg_get_userbyid(procedure_record.proowner)
    INTO
      v_delete_function_configuration,
      v_delete_function_is_security_definer,
      v_delete_function_definition,
      v_delete_function_owner_name
    FROM pg_catalog.pg_proc AS procedure_record
    WHERE procedure_record.oid = pg_catalog.to_regprocedure(
      'public.delete_workspace_for_current_user(text)'
    );

  IF NOT FOUND
    OR NOT v_delete_function_is_security_definer
    OR v_delete_function_configuration IS DISTINCT FROM ARRAY[
      'search_path=pg_catalog, public, pg_temp'
    ]::TEXT[]
    OR POSITION(
      'public.budget_lines_archive'
      IN v_delete_function_definition
    ) = 0
    OR POSITION(
      'public.budget_adjustments_archive'
      IN v_delete_function_definition
    ) = 0
  THEN
    RAISE EXCEPTION
      'budget archive invariant failed: workspace deletion must remain hardened and clear both archive tables';
  END IF;

  FOREACH v_archive_table IN ARRAY ARRAY[
    'public.budget_lines_archive',
    'public.budget_adjustments_archive'
  ]
  LOOP
    SELECT
      relation.relrowsecurity,
      relation.relforcerowsecurity,
      pg_catalog.pg_get_userbyid(relation.relowner)
      INTO v_rls_enabled, v_rls_forced, v_owner_name
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_archive_table::regclass;

    -- The archives are forced-RLS tables whose only policy is scoped to their
    -- owner, so workspace deletion reaches them only while the SECURITY
    -- DEFINER function runs as that same owner. Without this link a future
    -- migration applied by another role would leave archived rows behind for a
    -- deleted workspace, silently or with permission denied.
    IF v_delete_function_owner_name IS DISTINCT FROM v_owner_name THEN
      RAISE EXCEPTION
        'budget archive invariant failed: workspace deletion function owner % must own %, owned by %',
        v_delete_function_owner_name,
        v_archive_table,
        v_owner_name;
    END IF;

    IF NOT pg_catalog.has_table_privilege(
      v_delete_function_owner_name,
      v_archive_table,
      'DELETE'
    )
    THEN
      RAISE EXCEPTION
        'budget archive invariant failed: workspace deletion function owner % must have DELETE privilege on %',
        v_delete_function_owner_name,
        v_archive_table;
    END IF;

    IF NOT v_rls_enabled OR NOT v_rls_forced THEN
      RAISE EXCEPTION
        'budget archive invariant failed: row-level security on % must be enabled and forced; enabled %, forced %',
        v_archive_table,
        v_rls_enabled,
        v_rls_forced;
    END IF;

    SELECT COUNT(*)::INTEGER
      INTO v_policy_count
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_archive_table::regclass;

    IF v_policy_count <> 1 THEN
      RAISE EXCEPTION
        'budget archive invariant failed: expected exactly the owner policy on %, found % policies',
        v_archive_table,
        v_policy_count;
    END IF;

    SELECT
      policy.polname,
      policy.polcmd,
      policy.polroles
      INTO v_policy
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_archive_table::regclass;

    IF v_policy.polcmd <> '*'
      OR v_policy.polroles IS DISTINCT FROM ARRAY[
        pg_catalog.to_regrole(pg_catalog.quote_ident(v_owner_name))::OID
      ]
    THEN
      RAISE EXCEPTION
        'budget archive invariant failed: policy % on % must grant every command to the table owner % alone',
        v_policy.polname,
        v_archive_table,
        v_owner_name;
    END IF;

    FOREACH v_role_name IN ARRAY ARRAY[
      'app'::NAME,
      'api_sql_executor'::NAME,
      'api_sql_reader'::NAME
    ]
    LOOP
      IF pg_catalog.pg_has_role(v_role_name, v_owner_name, 'MEMBER') THEN
        RAISE EXCEPTION
          'budget archive invariant failed: role % must not inherit the archive owner role %',
          v_role_name,
          v_owner_name;
      END IF;

      FOREACH v_privilege_name IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]
      LOOP
        IF pg_catalog.has_any_column_privilege(
          v_role_name,
          v_archive_table,
          v_privilege_name
        )
        THEN
          RAISE EXCEPTION
            'budget archive invariant failed: role % has % privilege on %; the archives are internal history with no product surface',
            v_role_name,
            v_privilege_name,
            v_archive_table;
        END IF;
      END LOOP;

      FOREACH v_privilege_name IN ARRAY ARRAY[
        'DELETE',
        'TRUNCATE',
        'TRIGGER',
        'MAINTAIN'
      ]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role_name,
          v_archive_table,
          v_privilege_name
        )
        THEN
          RAISE EXCEPTION
            'budget archive invariant failed: role % has % privilege on %; the archives are internal history with no product surface',
            v_role_name,
            v_privilege_name,
            v_archive_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
