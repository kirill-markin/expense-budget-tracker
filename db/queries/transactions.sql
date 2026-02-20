-- Reference queries for the transactions dashboard.
-- Parameters: $1 = report_currency, $2..N = dynamic filters (see WHERE clause)

-- ENTRIES_QUERY: paginated ledger entries with runtime FX conversion.
-- Parameters: $1 = report_currency; filters and sort injected dynamically.
WITH rate_ranges AS (
  SELECT
    base_currency, rate_date, rate,
    LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
  FROM exchange_rates
  WHERE quote_currency = $1
)
SELECT
  le.entry_id, le.event_id, le.ts, le.account_id,
  le.amount::double precision AS amount,
  CASE
    WHEN le.currency = $1 THEN le.amount::double precision
    WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
    ELSE NULL
  END AS amount_report,
  le.currency, le.kind, le.category, le.counterparty, le.note
FROM ledger_entries le
LEFT JOIN rate_ranges r
  ON r.base_currency = le.currency
  AND le.ts::date >= r.rate_date
  AND (le.ts::date < r.next_rate_date OR r.next_rate_date IS NULL)
-- WHERE <dynamic filters: le.ts >= $2, le.ts < $3, le.account_id = $4, etc.>
ORDER BY le.ts DESC
LIMIT 50 OFFSET 0;

----

-- COUNT_QUERY: total matching transactions for pagination.
SELECT COUNT(*) AS total
FROM ledger_entries le;
-- WHERE <same dynamic filters as ENTRIES_QUERY>

----

-- ACCOUNTS_QUERY: distinct account IDs for filter dropdown.
SELECT DISTINCT account_id
FROM ledger_entries
ORDER BY account_id;
