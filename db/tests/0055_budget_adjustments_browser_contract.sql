BEGIN;

DO $$
DECLARE
  v_rejected BOOLEAN;
BEGIN
  INSERT INTO public.budget_adjustments (
    workspace_id,
    budget_month,
    direction,
    category,
    amount,
    note
  ) VALUES
    ('local', date_trunc('month', CURRENT_DATE)::DATE, 'income', 'A', -9007199254740991, NULL),
    ('local', date_trunc('month', CURRENT_DATE)::DATE, 'spend', repeat('C', 200), 9007199254740991, 'Boundary'),
    (
      'local',
      date_trunc('month', CURRENT_DATE)::DATE,
      'income',
      repeat(chr(128512), 200),
      0,
      repeat(chr(128640), 2000)
    );

  v_rejected := FALSE;
  BEGIN
    INSERT INTO public.budget_adjustments (
      workspace_id, budget_month, direction, category, amount, note
    ) VALUES (
      'local', date_trunc('month', CURRENT_DATE)::DATE, 'income', '', 0, NULL
    );
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION
      'budget_adjustments schema test failed: empty category was accepted';
  END IF;

  v_rejected := FALSE;
  BEGIN
    INSERT INTO public.budget_adjustments (
      workspace_id, budget_month, direction, category, amount, note
    ) VALUES (
      'local',
      date_trunc('month', CURRENT_DATE)::DATE,
      'income',
      repeat(chr(128512), 201),
      0,
      NULL
    );
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION
      'budget_adjustments schema test failed: category above 200 Unicode code points was accepted';
  END IF;

  v_rejected := FALSE;
  BEGIN
    INSERT INTO public.budget_adjustments (
      workspace_id, budget_month, direction, category, amount, note
    ) VALUES (
      'local',
      date_trunc('month', CURRENT_DATE)::DATE,
      'income',
      'Unicode note overflow',
      0,
      repeat(chr(128640), 2001)
    );
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION
      'budget_adjustments schema test failed: note above 2000 Unicode code points was accepted';
  END IF;

  v_rejected := FALSE;
  BEGIN
    INSERT INTO public.budget_adjustments (
      workspace_id, budget_month, direction, category, amount, note
    ) VALUES (
      'local', date_trunc('month', CURRENT_DATE)::DATE, 'income', 'Too positive', 9007199254740992, NULL
    );
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION
      'budget_adjustments schema test failed: amount above Number.MAX_SAFE_INTEGER was accepted';
  END IF;

  v_rejected := FALSE;
  BEGIN
    INSERT INTO public.budget_adjustments (
      workspace_id, budget_month, direction, category, amount, note
    ) VALUES (
      'local', date_trunc('month', CURRENT_DATE)::DATE, 'spend', 'Too negative', -9007199254740992, NULL
    );
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION
      'budget_adjustments schema test failed: amount below Number.MIN_SAFE_INTEGER was accepted';
  END IF;
END;
$$;

ROLLBACK;
