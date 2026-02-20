-- Reference query for the per-currency FX breakdown panel.
-- Parameters: $1 = report_currency, $2 = month (YYYY-MM)

WITH
monthly_deltas AS (
  SELECT
    to_char(le.ts::date, 'YYYY-MM') AS month,
    a.currency,
    SUM(le.amount::double precision) AS delta
  FROM ledger_entries le
  JOIN accounts a ON a.account_id = le.account_id
  GROUP BY 1, 2
),
all_months AS (
  SELECT to_char(d::date, 'YYYY-MM') AS month
  FROM generate_series(
    (SELECT MIN(to_date(month, 'YYYY-MM')) FROM monthly_deltas),
    (date_trunc('month', to_date($2, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
    interval '1 month'
  ) d
),
currencies AS (
  SELECT DISTINCT currency FROM monthly_deltas
),
full_grid AS (
  SELECT m.month, c.currency, COALESCE(d.delta, 0) AS delta
  FROM all_months m
  CROSS JOIN currencies c
  LEFT JOIN monthly_deltas d ON d.month = m.month AND d.currency = c.currency
),
running_balances AS (
  SELECT month, currency,
    SUM(delta) OVER (
      PARTITION BY currency ORDER BY month
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS balance,
    delta
  FROM full_grid
),
rate_ranges AS (
  SELECT base_currency, rate_date, rate,
    LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
  FROM exchange_rates
  WHERE quote_currency = $1
),
prev_month_str AS (
  SELECT to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM') AS val
),
prev AS (
  SELECT rb.currency, rb.balance,
    CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
  FROM running_balances rb
  CROSS JOIN prev_month_str pm
  LEFT JOIN rate_ranges rr
    ON rr.base_currency = rb.currency
    AND (date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date >= rr.rate_date
    AND ((date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date < rr.next_rate_date
         OR rr.next_rate_date IS NULL)
  WHERE rb.month = pm.val
),
curr AS (
  SELECT rb.currency, rb.balance, rb.delta,
    CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
  FROM running_balances rb
  LEFT JOIN rate_ranges rr
    ON rr.base_currency = rb.currency
    AND (date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date >= rr.rate_date
    AND ((date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date < rr.next_rate_date
         OR rr.next_rate_date IS NULL)
  WHERE rb.month = $2
)
SELECT
  COALESCE(c.currency, p.currency) AS currency,
  ROUND(COALESCE(p.balance, 0)::numeric, 2) AS open_native,
  ROUND(COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS open_rate,
  ROUND((COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS open_report,
  ROUND(COALESCE(c.delta, 0)::numeric, 2) AS delta_native,
  ROUND(COALESCE(c.balance, COALESCE(p.balance, 0))::numeric, 2) AS close_native,
  ROUND(COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS close_rate,
  ROUND((COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS close_report,
  ROUND((
    COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)
  )::numeric, 2) AS change_report
FROM curr c
FULL OUTER JOIN prev p USING (currency)
WHERE ABS(COALESCE(c.balance, COALESCE(p.balance, 0))) > 0.01
   OR ABS(COALESCE(p.balance, 0)) > 0.01
ORDER BY ABS(
  COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
  COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)
) DESC;
