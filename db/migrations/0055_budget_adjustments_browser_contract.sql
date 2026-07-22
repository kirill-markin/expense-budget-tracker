-- Align persisted budget adjustments with the browser contract without
-- rewriting any existing row. Fail with the first actionable mismatch before
-- replacing the validated constraints.

SET LOCAL lock_timeout = '30s';

LOCK TABLE public.budget_adjustments IN ACCESS EXCLUSIVE MODE;

-- Forced RLS also applies to a NOSUPERUSER/NOBYPASSRLS table owner. Install a
-- transaction-scoped policy so the preflight inspects every workspace.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY budget_adjustments_0055_migration_read
       ON public.budget_adjustments
       FOR SELECT
       TO %I
       USING (true)',
    current_user
  );
END;
$$;

DO $$
DECLARE
  v_invalid RECORD;
BEGIN
  SELECT
    adjustment.adjustment_id,
    adjustment.workspace_id,
    adjustment.category
    INTO v_invalid
    FROM public.budget_adjustments AS adjustment
    WHERE char_length(adjustment.category) NOT BETWEEN 1 AND 200
    ORDER BY adjustment.workspace_id, adjustment.adjustment_id
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments browser contract precondition failed: adjustment % in workspace % has category length %; set a non-empty category of at most 200 characters before retrying migration 0055',
      v_invalid.adjustment_id,
      v_invalid.workspace_id,
      char_length(v_invalid.category);
  END IF;

  SELECT
    adjustment.adjustment_id,
    adjustment.workspace_id,
    adjustment.amount
    INTO v_invalid
    FROM public.budget_adjustments AS adjustment
    WHERE adjustment.amount NOT BETWEEN
      (-9007199254740991)::NUMERIC
      AND 9007199254740991::NUMERIC
    ORDER BY adjustment.workspace_id, adjustment.adjustment_id
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'budget_adjustments browser contract precondition failed: adjustment % in workspace % has amount %, outside the JavaScript safe-integer range [-9007199254740991, 9007199254740991]; correct the amount before retrying migration 0055',
      v_invalid.adjustment_id,
      v_invalid.workspace_id,
      v_invalid.amount;
  END IF;
END;
$$;

DROP POLICY budget_adjustments_0055_migration_read
  ON public.budget_adjustments;

ALTER TABLE public.budget_adjustments
  DROP CONSTRAINT budget_adjustments_category_check;
ALTER TABLE public.budget_adjustments
  ADD CONSTRAINT budget_adjustments_category_check
  CHECK (char_length(category) BETWEEN 1 AND 200);

ALTER TABLE public.budget_adjustments
  DROP CONSTRAINT budget_adjustments_amount_check;
ALTER TABLE public.budget_adjustments
  ADD CONSTRAINT budget_adjustments_amount_check
  CHECK (
    amount NOT IN (
      'NaN'::NUMERIC,
      'Infinity'::NUMERIC,
      '-Infinity'::NUMERIC
    )
    AND amount = pg_catalog.trunc(amount)
    AND amount BETWEEN
      (-9007199254740991)::NUMERIC
      AND 9007199254740991::NUMERIC
  );

SET LOCAL lock_timeout = '0';
