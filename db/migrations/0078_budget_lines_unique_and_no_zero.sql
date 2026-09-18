-- Close the budget cell model: one row per cell, no zero plan, and no kind.
--
-- The deployed application already saves a plan in place, inserts only when the
-- cell has no row, deletes the row when the value reaches zero, and no longer
-- names kind, so the constraints below match what the live code writes. The
-- deploy updates the web service before it runs migrations, which is why that
-- application release ships together with this file.
--
-- A zero plan and a missing row mean the same thing and both render as 0, so
-- removing a straggler that the previous append-only release left behind
-- normalizes the data instead of losing it. Everything this migration deletes
-- is copied into the internal archive table added by migration 0076 first,
-- reusing its archive reasons and adding one for a non-finite plan value.

SET LOCAL lock_timeout = '30s';

LOCK TABLE public.budget_lines IN ACCESS EXCLUSIVE MODE;

-- Forced row-level security applies to the migration owner, so the row work and
-- the row-level invariants below need a transaction-scoped policy on the source
-- table. It is dropped again at the end of this migration.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_lines_0078_migration_access
       ON public.budget_lines
       FOR ALL
       TO %I
       USING (true)
       WITH CHECK (true)',
    current_user
  );
END;
$$;

DO $$
DECLARE
  v_archived_non_finite BIGINT;
  v_archived_superseded BIGINT;
  v_archived_zero_plan BIGINT;
  v_deleted_non_finite BIGINT;
  v_deleted_superseded BIGINT;
  v_deleted_zero_plan BIGINT;
BEGIN
  -- A non-finite plan value is unusable data that the check constraint below
  -- rejects, and neither equality pass can see it: in numeric semantics NaN is
  -- distinct from 0 and equal only to itself. budget_lines has carried no value
  -- constraint since 0001 and the restricted agent SQL surface can store
  -- 'NaN'::NUMERIC, so archive and remove such a row here rather than let the
  -- constraint abort the migration step of a deploy whose application release
  -- already shipped. It runs before the tie-break below so the surviving row of
  -- a cell is chosen among usable values.
  WITH deleted AS (
    DELETE FROM public.budget_lines AS line
      WHERE line.planned_value IN (
        'NaN'::NUMERIC,
        'Infinity'::NUMERIC,
        '-Infinity'::NUMERIC
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
      'non_finite_plan'
    FROM deleted
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*) FROM deleted),
    (SELECT COUNT(*) FROM archived)
    INTO v_deleted_non_finite, v_archived_non_finite;

  IF v_archived_non_finite IS DISTINCT FROM v_deleted_non_finite THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: archived % of the % non-finite plan rows',
      v_archived_non_finite,
      v_deleted_non_finite;
  END IF;

  -- Keep the newest row of every cell, extending the 0076 tie-break with the
  -- later of the two timestamps: a straggler duplicate can only come from an
  -- append the previous release made after 0076, and that append carries the
  -- newer plan. The deployed release changes a plan in place, which bumps
  -- updated_at and leaves inserted_at alone, so the freshest value of a cell
  -- can sit on its oldest inserted row; ordering on the later timestamp first
  -- keeps the choice right without assuming who wrote the duplicate.
  WITH ranked AS (
    SELECT
      line.line_id,
      ROW_NUMBER() OVER (
        PARTITION BY
          line.workspace_id,
          line.budget_month,
          line.direction,
          line.category
        ORDER BY
          GREATEST(line.inserted_at, line.updated_at) DESC,
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
      'budget_lines cell invariant failed: archived % of the % superseded rows',
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
      'budget_lines cell invariant failed: archived % of the % zero plan rows',
      v_archived_zero_plan,
      v_deleted_zero_plan;
  END IF;
END;
$$;

-- The three mutation policies migration 0054 created still test kind, so
-- dropping the column would fail on that dependency, and dropping it with
-- CASCADE would take the policies with it and leave budget_lines mutable
-- across workspaces. Recreate them with the same workspace scope and without
-- the Base predicate, which migration 0057 already made redundant by leaving
-- base as the only kind.
DROP POLICY budget_lines_insert_base_access
  ON public.budget_lines;
DROP POLICY budget_lines_update_base_access
  ON public.budget_lines;
DROP POLICY budget_lines_delete_base_access
  ON public.budget_lines;

CREATE POLICY budget_lines_insert_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_lines_update_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY budget_lines_delete_access
  ON public.budget_lines
  AS PERMISSIVE
  FOR DELETE
  TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NOT NULL
    AND workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

-- The append-only lookup index covers kind and would be dropped implicitly with
-- the column. Drop it here instead, because the unique index created below
-- carries the same leading columns and now serves the same lookups.
DROP INDEX public.idx_budget_lines_lookup;

ALTER TABLE public.budget_lines
  DROP CONSTRAINT budget_lines_kind_check;
ALTER TABLE public.budget_lines
  DROP COLUMN kind;

-- budget_lines_archive.kind (migration 0076) mirrored the column just dropped,
-- so no later archiving path has a source value to copy into it. Relax it here
-- instead of leaving the next such path to invent a literal; the rows archived
-- above still carry the kind they were stored with.
ALTER TABLE public.budget_lines_archive
  ALTER COLUMN kind DROP NOT NULL;

-- One row per cell. The read path still resolves a winner; that resolution
-- becomes the identity here and is removed separately.
CREATE UNIQUE INDEX budget_lines_cell_idx
  ON public.budget_lines (workspace_id, budget_month, direction, category);

-- Validated rather than NOT VALID: the normalization above left no zero row
-- and no non-finite row behind, so every stored row satisfies this check right
-- now.
ALTER TABLE public.budget_lines
  ADD CONSTRAINT budget_lines_planned_value_check
  CHECK (
    planned_value <> 0
    AND planned_value NOT IN (
      'NaN'::NUMERIC,
      'Infinity'::NUMERIC,
      '-Infinity'::NUMERIC
    )
  );

-- Mirrors budget_adjustments_budget_month_check from migration 0053. The save
-- path keys on the first of the month, so a row stored on another day would be
-- invisible to its own update and delete.
ALTER TABLE public.budget_lines
  ADD CONSTRAINT budget_lines_budget_month_check
  CHECK (EXTRACT(DAY FROM budget_month) = 1);

-- Make pg_get_expr output deterministic for exact PostgreSQL 18 policy checks.
SET LOCAL search_path = pg_catalog, public;

-- Verify the cell model before commit, while the transaction-scoped policy
-- still makes budget_lines readable to the migration owner.
DO $$
DECLARE
  v_budget_month_validated BOOLEAN;
  v_duplicate RECORD;
  v_expected_workspace_expression TEXT;
  v_index_columns TEXT[];
  v_index_is_unique BOOLEAN;
  v_index_is_valid BOOLEAN;
  v_migration_policy_role_oid OID;
  v_planned_value_validated BOOLEAN;
  v_policy_mismatch RECORD;
  v_remaining_zero BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.budget_lines'::regclass
      AND attribute.attname = 'kind'
      AND NOT attribute.attisdropped
  )
  THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: the kind column still exists';
  END IF;

  SELECT
    index_record.indisunique,
    index_record.indisvalid,
    ARRAY(
      SELECT attribute.attname::TEXT
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = index_record.indrelid
        AND attribute.attnum = ANY (index_record.indkey)
      ORDER BY attribute.attname
    )
    INTO v_index_is_unique, v_index_is_valid, v_index_columns
    FROM pg_catalog.pg_index AS index_record
    WHERE index_record.indexrelid = pg_catalog.to_regclass(
      'public.budget_lines_cell_idx'
    );

  IF NOT FOUND
    OR NOT v_index_is_unique
    OR NOT v_index_is_valid
    OR v_index_columns IS DISTINCT FROM ARRAY[
      'budget_month',
      'category',
      'direction',
      'workspace_id'
    ]::TEXT[]
  THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: budget_lines_cell_idx must be a valid unique index over one budget cell, found columns %',
      v_index_columns;
  END IF;

  SELECT constraint_record.convalidated
    INTO v_planned_value_validated
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.budget_lines'::regclass
      AND constraint_record.conname = 'budget_lines_planned_value_check'
      AND constraint_record.contype = 'c';

  IF NOT FOUND OR NOT v_planned_value_validated THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: budget_lines_planned_value_check must exist and be validated';
  END IF;

  SELECT constraint_record.convalidated
    INTO v_budget_month_validated
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.budget_lines'::regclass
      AND constraint_record.conname = 'budget_lines_budget_month_check'
      AND constraint_record.contype = 'c';

  IF NOT FOUND OR NOT v_budget_month_validated THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: budget_lines_budget_month_check must exist and be validated';
  END IF;

  -- The kind predicate is gone from the mutation policies, so prove that the
  -- workspace scoping they carry survived the recreation above. Counting names
  -- would pass a policy rewritten as USING (true), scoped to another command or
  -- role, or made restrictive, and would not see an extra permissive policy at
  -- all, so compare every policy on the table against its expected definition
  -- the way migration 0054 pinned them. The transaction-scoped migration policy
  -- is still in place here, so it is part of the expected set.
  SELECT role_record.oid
    INTO v_migration_policy_role_oid
    FROM pg_catalog.pg_roles AS role_record
    WHERE role_record.rolname = current_user;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: the migration role % has no pg_roles row',
      current_user;
  END IF;

  v_expected_workspace_expression :=
    '((current_setting(''app.workspace_id''::text, true) IS NOT NULL) AND (workspace_id = current_setting(''app.workspace_id''::text, true)) AND current_app_user_has_selected_workspace_access())';

  WITH expected_policies (
    policy_name,
    permissive,
    command,
    role_oids,
    using_expression,
    check_expression
  ) AS (
    VALUES
      (
        'budget_lines_select_access'::NAME,
        true,
        'r'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        NULL::TEXT
      ),
      (
        'budget_lines_insert_access'::NAME,
        true,
        'a'::TEXT,
        ARRAY[0::OID],
        NULL::TEXT,
        v_expected_workspace_expression
      ),
      (
        'budget_lines_update_access'::NAME,
        true,
        'w'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        v_expected_workspace_expression
      ),
      (
        'budget_lines_delete_access'::NAME,
        true,
        'd'::TEXT,
        ARRAY[0::OID],
        v_expected_workspace_expression,
        NULL::TEXT
      ),
      (
        'budget_lines_0078_migration_access'::NAME,
        true,
        '*'::TEXT,
        ARRAY[v_migration_policy_role_oid],
        'true'::TEXT,
        'true'::TEXT
      )
  ),
  actual_policies AS (
    SELECT
      policy.polname AS policy_name,
      policy.polpermissive AS permissive,
      policy.polcmd::TEXT AS command,
      policy.polroles AS role_oids,
      pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid
      ) AS using_expression,
      pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid
      ) AS check_expression
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.budget_lines'::regclass
  )
  SELECT
    expected_policy.policy_name AS expected_policy_name,
    expected_policy.permissive AS expected_permissive,
    expected_policy.command AS expected_command,
    expected_policy.role_oids AS expected_role_oids,
    expected_policy.using_expression AS expected_using_expression,
    expected_policy.check_expression AS expected_check_expression,
    actual_policy.policy_name AS actual_policy_name,
    actual_policy.permissive AS actual_permissive,
    actual_policy.command AS actual_command,
    actual_policy.role_oids AS actual_role_oids,
    actual_policy.using_expression AS actual_using_expression,
    actual_policy.check_expression AS actual_check_expression
    INTO v_policy_mismatch
    FROM expected_policies AS expected_policy
    FULL JOIN actual_policies AS actual_policy
      ON actual_policy.policy_name = expected_policy.policy_name
    WHERE expected_policy.policy_name IS NULL
      OR actual_policy.policy_name IS NULL
      OR expected_policy.permissive IS DISTINCT FROM actual_policy.permissive
      OR expected_policy.command IS DISTINCT FROM actual_policy.command
      OR expected_policy.role_oids IS DISTINCT FROM actual_policy.role_oids
      OR expected_policy.using_expression IS DISTINCT FROM actual_policy.using_expression
      OR expected_policy.check_expression IS DISTINCT FROM actual_policy.check_expression
    ORDER BY
      COALESCE(expected_policy.policy_name, actual_policy.policy_name)
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed for policy %: expected permissive %, command %, roles %, USING %, WITH CHECK %; found % with permissive %, command %, roles %, USING %, WITH CHECK %',
      v_policy_mismatch.expected_policy_name,
      v_policy_mismatch.expected_permissive,
      v_policy_mismatch.expected_command,
      v_policy_mismatch.expected_role_oids,
      v_policy_mismatch.expected_using_expression,
      v_policy_mismatch.expected_check_expression,
      v_policy_mismatch.actual_policy_name,
      v_policy_mismatch.actual_permissive,
      v_policy_mismatch.actual_command,
      v_policy_mismatch.actual_role_oids,
      v_policy_mismatch.actual_using_expression,
      v_policy_mismatch.actual_check_expression;
  END IF;

  SELECT COUNT(*)
    INTO v_remaining_zero
    FROM public.budget_lines AS line
    WHERE line.planned_value = 0;

  IF v_remaining_zero <> 0 THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: % zero plan rows remain',
      v_remaining_zero;
  END IF;

  SELECT
    line.workspace_id,
    line.budget_month,
    line.direction,
    line.category,
    COUNT(*) AS row_count
    INTO v_duplicate
    FROM public.budget_lines AS line
    GROUP BY
      line.workspace_id,
      line.budget_month,
      line.direction,
      line.category
    HAVING COUNT(*) > 1
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_lines cell invariant failed: workspace % still has % rows for month %, direction %, category %',
      v_duplicate.workspace_id,
      v_duplicate.row_count,
      v_duplicate.budget_month,
      v_duplicate.direction,
      v_duplicate.category;
  END IF;
END;
$$;

DROP POLICY budget_lines_0078_migration_access
  ON public.budget_lines;

SET LOCAL lock_timeout = '0';
