-- Reference queries for the budget grid dashboard.
-- Parameters: $1 = report_currency, $2 = month_from, $3 = month_to,
--             $4 = plan_from, $5 = actual_to

-- QUERY: main budget grid — planned (base + modifier) vs actual per month/direction/category.
WITH latest_plans AS (
  SELECT
    budget_month, direction, category, kind, planned_value,
    ROW_NUMBER() OVER (
      PARTITION BY budget_month, direction, category, kind
      ORDER BY inserted_at DESC
    ) AS rn
  FROM budget_lines
  WHERE budget_month >= GREATEST(to_date($4, 'YYYY-MM'), to_date($2, 'YYYY-MM'))
    AND budget_month < to_date($3, 'YYYY-MM') + interval '1 month'
),
planned AS (
  SELECT
    to_char(budget_month, 'YYYY-MM') AS month,
    direction,
    category,
    COALESCE(MAX(CASE WHEN kind = 'base' THEN planned_value::double precision END), 0) AS planned_base,
    COALESCE(MAX(CASE WHEN kind = 'modifier' THEN planned_value::double precision END), 0) AS planned_modifier
  FROM latest_plans
  WHERE rn = 1
  GROUP BY 1, 2, 3
),
rate_ranges AS (
  SELECT
    base_currency, rate_date, rate,
    LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
  FROM exchange_rates
  WHERE quote_currency = $1
),
actual AS (
  SELECT
    to_char(le.ts::date, 'YYYY-MM') AS month,
    le.kind AS direction,
    COALESCE(le.category, '') AS category,
    SUM(CASE WHEN le.kind = 'transfer' THEN
      CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END
    ELSE
      ABS(CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END)
    END) AS actual,
    bool_or(le.currency != $1 AND r.rate IS NULL) AS has_unconvertible
  FROM ledger_entries le
  LEFT JOIN rate_ranges r
    ON r.base_currency = le.currency
    AND le.ts::date >= r.rate_date
    AND (le.ts::date < r.next_rate_date OR r.next_rate_date IS NULL)
  WHERE le.ts::date >= to_date($2, 'YYYY-MM')
    AND le.ts::date < (LEAST(to_date($3, 'YYYY-MM'), to_date($5, 'YYYY-MM')) + interval '1 month')::date
  GROUP BY 1, 2, 3
)
SELECT
  COALESCE(p.month, a.month) AS month,
  COALESCE(p.direction, a.direction) AS direction,
  COALESCE(p.category, a.category) AS category,
  COALESCE(p.planned_base, 0) AS planned_base,
  COALESCE(p.planned_modifier, 0) AS planned_modifier,
  COALESCE(p.planned_base, 0) + COALESCE(p.planned_modifier, 0) AS planned,
  COALESCE(a.actual, 0) AS actual,
  COALESCE(a.has_unconvertible, FALSE) AS has_unconvertible
FROM planned p
FULL OUTER JOIN actual a
  USING (month, direction, category)
ORDER BY month, direction, category;

----

-- CUMULATIVE_BALANCE_QUERY: actual totals before the loaded month range, by direction.
-- Parameters: $1 = report_currency, $2 = month_from
WITH rate_ranges AS (
  SELECT
    base_currency, rate_date, rate,
    LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
  FROM exchange_rates
  WHERE quote_currency = $1
),
actual_before AS (
  SELECT
    le.kind AS direction,
    SUM(CASE WHEN le.kind = 'transfer' THEN
      CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END
    ELSE
      ABS(CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END)
    END) AS total
  FROM ledger_entries le
  LEFT JOIN rate_ranges r
    ON r.base_currency = le.currency
    AND le.ts::date >= r.rate_date
    AND (le.ts::date < r.next_rate_date OR r.next_rate_date IS NULL)
  WHERE le.ts::date < to_date($2, 'YYYY-MM')
  GROUP BY direction
)
SELECT
  COALESCE(SUM(CASE WHEN direction = 'income' THEN total END), 0) AS income_actual,
  COALESCE(SUM(CASE WHEN direction = 'spend' THEN total END), 0) AS spend_actual,
  COALESCE(SUM(CASE WHEN direction = 'transfer' THEN total END), 0) AS transfer_actual
FROM actual_before;

----

-- WARNINGS_QUERY: currencies without exchange rates for the report currency.
-- Parameters: $1 = report_currency
WITH data_currencies AS (
  SELECT DISTINCT currency FROM budget_lines
  UNION
  SELECT DISTINCT currency FROM ledger_entries
),
rate_currencies AS (
  SELECT DISTINCT base_currency
  FROM exchange_rates
  WHERE quote_currency = $1
)
SELECT dc.currency
FROM data_currencies dc
LEFT JOIN rate_currencies rc ON rc.base_currency = dc.currency
WHERE dc.currency != $1
  AND rc.base_currency IS NULL
ORDER BY dc.currency;

----

-- MONTH_END_BALANCES_QUERY: portfolio balance in report currency at each month-end (mark-to-market).
-- Parameters: $1 = report_currency, $2 = month_from, $3 = actual_to
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
    (date_trunc('month', to_date($3, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
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
    ) AS balance
  FROM full_grid
),
rate_ranges AS (
  SELECT base_currency, rate_date, rate,
    LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
  FROM exchange_rates
  WHERE quote_currency = $1
)
SELECT
  rb.month,
  ROUND(SUM(CASE
    WHEN rb.currency = $1 THEN rb.balance
    WHEN rr.rate IS NOT NULL THEN rb.balance * rr.rate::double precision
    ELSE NULL
  END)::numeric, 2) AS balance_report
FROM running_balances rb
LEFT JOIN rate_ranges rr
  ON rr.base_currency = rb.currency
  AND (date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date >= rr.rate_date
  AND ((date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date < rr.next_rate_date
       OR rr.next_rate_date IS NULL)
WHERE rb.month >= to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM')
  AND rb.month <= $3
GROUP BY rb.month
ORDER BY rb.month;
