-- Reference queries for the balances dashboard.
-- Parameters: $1 = report_currency (e.g. 'USD'), $2 = latest_fx_calendar_date

-- ACCOUNTS_QUERY: per-account balances with FX conversion to report currency.
WITH
latest_rates AS (
  SELECT base_currency, rate
  FROM fx_rates_daily
  WHERE quote_currency = $1
    AND calendar_date = $2
)
SELECT
  a.account_id,
  a.currency,
  COALESCE(SUM(le.amount)::double precision, 0) AS balance,
  CASE
    WHEN a.currency = $1 THEN COALESCE(SUM(le.amount)::double precision, 0)
    WHEN lr.rate IS NOT NULL THEN COALESCE(SUM(le.amount)::double precision, 0) * lr.rate::double precision
    ELSE NULL
  END AS balance_report,
  MAX(CASE WHEN le.kind != 'transfer' THEN le.ts END) AS last_transaction_ts
FROM accounts a
LEFT JOIN ledger_entries le ON le.account_id = a.account_id
LEFT JOIN latest_rates lr ON lr.base_currency = a.currency
GROUP BY a.account_id, a.currency, lr.rate
ORDER BY a.account_id;

----

-- TOTALS_QUERY: per-currency totals with FX conversion.
-- Parameters: $1 = report_currency, $2 = latest_fx_calendar_date
WITH account_balances AS (
  SELECT
    a.account_id,
    a.currency,
    COALESCE(SUM(le.amount)::double precision, 0) AS balance
  FROM accounts a
  LEFT JOIN ledger_entries le ON le.account_id = a.account_id
  GROUP BY a.account_id, a.currency
),
latest_rates AS (
  SELECT base_currency, rate
  FROM fx_rates_daily
  WHERE quote_currency = $1
    AND calendar_date = $2
)
SELECT
  ab.currency,
  SUM(ab.balance) AS balance,
  SUM(CASE WHEN ab.balance > 0 THEN ab.balance ELSE 0 END) AS balance_positive,
  SUM(CASE WHEN ab.balance < 0 THEN ab.balance ELSE 0 END) AS balance_negative,
  SUM(CASE
    WHEN ab.currency = $1 THEN ab.balance
    ELSE ab.balance * lr.rate::double precision
  END) AS balance_report,
  bool_or(ab.currency != $1 AND lr.rate IS NULL) AS has_unconvertible
FROM account_balances ab
LEFT JOIN latest_rates lr ON lr.base_currency = ab.currency
GROUP BY ab.currency
ORDER BY ab.currency;

----

-- STALENESS_QUERY: transaction gap analysis per account.
WITH txns AS (
  SELECT account_id, ts,
    LAG(ts) OVER (PARTITION BY account_id ORDER BY ts) AS prev_ts
  FROM ledger_entries
  WHERE kind != 'transfer'
),
nonzero_gaps AS (
  SELECT account_id,
    EXTRACT(EPOCH FROM (ts - prev_ts)) / 86400 AS gap_days,
    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY ts DESC) AS rn
  FROM txns
  WHERE prev_ts IS NOT NULL
    AND ts != prev_ts
),
stats AS (
  SELECT account_id,
    MAX(gap_days) AS max_recent_gap_days
  FROM nonzero_gaps
  WHERE rn <= 20
  GROUP BY account_id
),
counts AS (
  SELECT account_id, COUNT(*) AS total_non_transfer_txns
  FROM ledger_entries
  WHERE kind != 'transfer'
  GROUP BY account_id
),
counts_30d AS (
  SELECT account_id, COUNT(*) AS recent_non_transfer_txns_30d
  FROM ledger_entries
  WHERE kind != 'transfer'
    AND ts >= now() - interval '30 days'
  GROUP BY account_id
)
SELECT
  c.account_id,
  c.total_non_transfer_txns,
  COALESCE(c30.recent_non_transfer_txns_30d, 0) AS recent_non_transfer_txns_30d,
  s.max_recent_gap_days
FROM counts c
LEFT JOIN counts_30d c30 ON c30.account_id = c.account_id
LEFT JOIN stats s ON s.account_id = c.account_id;

----

-- WARNINGS_QUERY: currencies without exchange rates.
-- Parameters: $1 = report_currency, $2 = latest_fx_calendar_date
WITH latest_rates AS (
  SELECT DISTINCT base_currency
  FROM fx_rates_daily
  WHERE quote_currency = $1
    AND calendar_date = $2
),
data_currencies AS (
  SELECT DISTINCT currency
  FROM accounts
  WHERE currency != $1
)
SELECT dc.currency
FROM data_currencies dc
LEFT JOIN latest_rates lr ON lr.base_currency = dc.currency
WHERE lr.base_currency IS NULL
ORDER BY dc.currency;
