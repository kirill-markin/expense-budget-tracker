-- Keep public year totals bounded to the loaded month window.

CREATE OR REPLACE FUNCTION community.read_public_monthly_category_share(
  p_public_token TEXT,
  p_month_from DATE,
  p_month_to DATE
)
RETURNS TABLE(
  label TEXT,
  currency TEXT,
  available_month_from DATE,
  available_month_to DATE,
  loaded_month_from DATE,
  loaded_month_to DATE,
  categories JSONB,
  cells JSONB,
  year_totals JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, community
AS $$
DECLARE
  v_share_id TEXT;
  v_workspace_id TEXT;
  v_label TEXT;
  v_currency TEXT;
  v_timezone TEXT;
  v_config_month_from DATE;
  v_config_month_to DATE;
  v_request_month_from DATE;
  v_request_month_to DATE;
  v_capped_month_to DATE;
  v_local_current_date DATE;
  v_latest_eligible_month DATE;
  v_available_month_from DATE;
  v_available_month_to DATE;
  v_loaded_month_from DATE;
  v_loaded_month_to DATE;
BEGIN
  IF p_public_token IS NULL OR btrim(p_public_token) = '' THEN
    RETURN;
  END IF;

  IF p_month_from IS NULL OR p_month_to IS NULL THEN
    RAISE EXCEPTION 'read_public_monthly_category_share: p_month_from and p_month_to are required';
  END IF;

  v_request_month_from := date_trunc('month', p_month_from)::date;
  v_request_month_to := date_trunc('month', p_month_to)::date;

  IF v_request_month_from > v_request_month_to THEN
    RAISE EXCEPTION 'read_public_monthly_category_share: p_month_from must be <= p_month_to';
  END IF;

  v_capped_month_to := LEAST(
    v_request_month_to,
    (v_request_month_from + (INTERVAL '1 month' * 23))::date
  );

  SELECT
    share.share_id,
    share.workspace_id,
    share.display_label,
    settings.reporting_currency,
    settings.timezone,
    share.month_from,
    share.month_to
  INTO
    v_share_id,
    v_workspace_id,
    v_label,
    v_currency,
    v_timezone,
    v_config_month_from,
    v_config_month_to
  FROM community.monthly_category_share_keys AS key
  INNER JOIN community.monthly_category_shares AS share
    ON share.share_id = key.share_id
  INNER JOIN public.workspace_settings AS settings
    ON settings.workspace_id = share.workspace_id
  WHERE key.public_token = p_public_token
    AND key.revoked_at IS NULL
    AND share.enabled = true
    AND share.blocked_at IS NULL;

  IF v_share_id IS NULL THEN
    RETURN;
  END IF;

  v_local_current_date := (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::date;
  v_latest_eligible_month := (
    date_trunc('month', v_local_current_date)::date
    - CASE
        WHEN EXTRACT(DAY FROM v_local_current_date)::integer >= 6 THEN INTERVAL '1 month'
        ELSE INTERVAL '2 months'
      END
  )::date;

  v_available_month_from := v_config_month_from;
  v_available_month_to := LEAST(
    COALESCE(v_config_month_to, v_latest_eligible_month),
    v_latest_eligible_month
  );

  IF v_available_month_to < v_available_month_from THEN
    v_available_month_from := NULL;
    v_available_month_to := NULL;
    v_loaded_month_from := NULL;
    v_loaded_month_to := NULL;
  ELSE
    v_loaded_month_from := GREATEST(v_request_month_from, v_available_month_from);
    v_loaded_month_to := LEAST(v_capped_month_to, v_available_month_to);

    IF v_loaded_month_to < v_loaded_month_from THEN
      v_loaded_month_from := NULL;
      v_loaded_month_to := NULL;
    END IF;
  END IF;

  RETURN QUERY
  WITH public_categories AS (
    SELECT
      item.category,
      item.access_level
    FROM community.monthly_category_share_items AS item
    WHERE item.share_id = v_share_id
      AND item.direction = 'spend'
    ORDER BY item.category
  ),
  loaded_cells AS (
    SELECT
      date_trunc('month', local_entry.local_date)::date AS cell_month,
      category.category,
      SUM(-converted.amount_report)::double precision AS amount
    FROM public_categories AS category
    INNER JOIN public.ledger_entries AS entry
      ON entry.workspace_id = v_workspace_id
      AND entry.kind = 'spend'
      AND COALESCE(entry.category, '') = category.category
    CROSS JOIN LATERAL (
      SELECT (entry.ts AT TIME ZONE v_timezone)::date AS local_date
    ) AS local_entry
    LEFT JOIN public.fx_rates_daily AS rate
      ON rate.quote_currency = v_currency
      AND rate.base_currency = entry.currency
      AND rate.calendar_date = local_entry.local_date
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN entry.currency = v_currency THEN entry.amount::double precision
          WHEN rate.rate IS NOT NULL THEN entry.amount::double precision * rate.rate::double precision
          ELSE NULL
        END AS amount_report
    ) AS converted
    WHERE category.access_level = 'monthly_values'
      AND v_loaded_month_from IS NOT NULL
      AND local_entry.local_date >= v_loaded_month_from
      AND local_entry.local_date < (v_loaded_month_to + INTERVAL '1 month')::date
      AND converted.amount_report IS NOT NULL
    GROUP BY 1, 2
  ),
  loaded_year_totals AS (
    SELECT
      EXTRACT(YEAR FROM local_entry.local_date)::integer AS total_year,
      category.category,
      SUM(-converted.amount_report)::double precision AS amount
    FROM public_categories AS category
    INNER JOIN public.ledger_entries AS entry
      ON entry.workspace_id = v_workspace_id
      AND entry.kind = 'spend'
      AND COALESCE(entry.category, '') = category.category
    CROSS JOIN LATERAL (
      SELECT (entry.ts AT TIME ZONE v_timezone)::date AS local_date
    ) AS local_entry
    LEFT JOIN public.fx_rates_daily AS rate
      ON rate.quote_currency = v_currency
      AND rate.base_currency = entry.currency
      AND rate.calendar_date = local_entry.local_date
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN entry.currency = v_currency THEN entry.amount::double precision
          WHEN rate.rate IS NOT NULL THEN entry.amount::double precision * rate.rate::double precision
          ELSE NULL
        END AS amount_report
    ) AS converted
    WHERE category.access_level = 'monthly_values'
      AND v_loaded_month_from IS NOT NULL
      AND local_entry.local_date >= v_loaded_month_from
      AND local_entry.local_date < (v_loaded_month_to + INTERVAL '1 month')::date
      AND converted.amount_report IS NOT NULL
    GROUP BY 1, 2
  )
  SELECT
    v_label,
    v_currency,
    v_available_month_from,
    v_available_month_to,
    v_loaded_month_from,
    v_loaded_month_to,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'category', category.category,
          'accessLevel', category.access_level
        )
        ORDER BY category.category
      )
      FROM public_categories AS category
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'month', cell.cell_month,
          'category', cell.category,
          'amount', cell.amount
        )
        ORDER BY cell.cell_month, cell.category
      )
      FROM loaded_cells AS cell
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'year', total.total_year,
          'category', total.category,
          'amount', total.amount
        )
        ORDER BY total.total_year, total.category
      )
      FROM loaded_year_totals AS total
    ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION community.read_public_monthly_category_share(TEXT, DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION community.read_public_monthly_category_share(TEXT, DATE, DATE) FROM api_sql_executor;
GRANT EXECUTE ON FUNCTION community.read_public_monthly_category_share(TEXT, DATE, DATE) TO app;
