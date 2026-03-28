-- Reference query for the per-currency FX breakdown panel.
-- Parameters: $1 = report_currency, $2 = month (YYYY-MM), $3 = latest_fx_calendar_date (YYYY-MM-DD)
--
-- Uses month-end valuation capped to the latest available FX day. See budget_grid.sql header.

WITH
monthly_native_deltas AS (
  SELECT
    to_char(le.ts::date, 'YYYY-MM') AS month,
    le.currency,
    SUM(le.amount::double precision) AS delta_native
  FROM ledger_entries le
  GROUP BY 1, 2
),
monthly_report_flows AS (
  SELECT
    to_char(le.ts::date, 'YYYY-MM') AS month,
    le.currency,
    SUM(CASE
      WHEN le.currency = $1 THEN le.amount::double precision
      WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
      ELSE NULL
    END) AS flow_report
  FROM ledger_entries le
  LEFT JOIN fx_rates_daily r
    ON r.quote_currency = $1
    AND r.base_currency = le.currency
    AND r.calendar_date = le.ts::date
  GROUP BY 1, 2
),
all_months AS (
  SELECT to_char(d::date, 'YYYY-MM') AS month
  FROM generate_series(
    (SELECT MIN(to_date(month, 'YYYY-MM')) FROM monthly_native_deltas),
    (date_trunc('month', to_date($2, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
    interval '1 month'
  ) d
),
valuation_dates AS (
  SELECT
    month,
    LEAST(
      (date_trunc('month', to_date(month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
      to_date($3, 'YYYY-MM-DD')
    ) AS valuation_date
  FROM all_months
),
currencies AS (
  SELECT DISTINCT currency FROM monthly_native_deltas
),
full_grid AS (
  SELECT
    m.month,
    c.currency,
    COALESCE(nd.delta_native, 0) AS delta_native,
    COALESCE(rf.flow_report, 0) AS flow_report
  FROM all_months m
  CROSS JOIN currencies c
  LEFT JOIN monthly_native_deltas nd
    ON nd.month = m.month AND nd.currency = c.currency
  LEFT JOIN monthly_report_flows rf
    ON rf.month = m.month AND rf.currency = c.currency
),
running_balances AS (
  SELECT
    month,
    currency,
    SUM(delta_native) OVER (
      PARTITION BY currency ORDER BY month
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS balance,
    delta_native,
    flow_report
  FROM full_grid
),
prev AS (
  SELECT rb.currency, rb.balance,
    CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
  FROM running_balances rb
  JOIN valuation_dates vd
    ON vd.month = rb.month
  LEFT JOIN fx_rates_daily rr
    ON rr.quote_currency = $1
    AND rr.base_currency = rb.currency
    AND rr.calendar_date = vd.valuation_date
  WHERE rb.month = to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM')
),
curr AS (
  SELECT rb.currency, rb.balance, rb.delta_native, rb.flow_report,
    CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
  FROM running_balances rb
  JOIN valuation_dates vd
    ON vd.month = rb.month
  LEFT JOIN fx_rates_daily rr
    ON rr.quote_currency = $1
    AND rr.base_currency = rb.currency
    AND rr.calendar_date = vd.valuation_date
  WHERE rb.month = $2
)
SELECT
  COALESCE(c.currency, p.currency) AS currency,
  ROUND(COALESCE(p.balance, 0)::numeric, 2) AS open_native,
  ROUND(COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS open_rate,
  ROUND((COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS open_report,
  ROUND(COALESCE(c.delta_native, 0)::numeric, 2) AS delta_native,
  ROUND(COALESCE(c.flow_report, 0)::numeric, 2) AS flow_report,
  ROUND(COALESCE(c.balance, COALESCE(p.balance, 0))::numeric, 2) AS close_native,
  ROUND(COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS close_rate,
  ROUND((COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS close_report,
  ROUND((
    COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)
  )::numeric, 2) AS change_report,
  ROUND((
    COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(c.flow_report, 0)
  )::numeric, 2) AS fx_adjust_report
FROM curr c
FULL OUTER JOIN prev p USING (currency)
WHERE ABS(COALESCE(c.balance, COALESCE(p.balance, 0))) > 0.01
   OR ABS(COALESCE(p.balance, 0)) > 0.01
ORDER BY ABS(
  COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
  COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END) -
  COALESCE(c.flow_report, 0)
) DESC;
