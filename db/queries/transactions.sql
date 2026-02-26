-- Reference queries for the transactions dashboard.
-- Parameters: $1 = report_currency, $2..N = dynamic filters (see WHERE clause)
--
-- FX rate lookup uses LATERAL + LIMIT 1 instead of the old rate_ranges CTE.
-- One backward index scan per row via idx_exchange_rates_quote_base_date.

-- ENTRIES_QUERY: paginated ledger entries with runtime FX conversion.
-- Parameters: $1 = report_currency; filters and sort injected dynamically.
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
LEFT JOIN LATERAL (
  SELECT rate FROM exchange_rates
  WHERE quote_currency = $1
    AND base_currency = le.currency
    AND rate_date <= le.ts::date
  ORDER BY rate_date DESC
  LIMIT 1
) r ON true
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
