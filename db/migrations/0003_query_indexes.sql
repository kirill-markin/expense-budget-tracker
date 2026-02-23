-- Optimize indexes for real query patterns.
--
-- Every workspace-scoped table uses RLS that implicitly filters by workspace_id
-- on every query. The original indexes ignore workspace_id, forcing Postgres to
-- scan an index for the business filter and then heap-fetch each row to recheck
-- the workspace. Composite indexes with workspace_id as leading column let the
-- planner satisfy both the RLS predicate and the business filter in one scan.


-- ============================================================================
-- exchange_rates: covering index for FX conversion pattern
-- ============================================================================
--
-- All FX queries filter on quote_currency first (the reporting currency),
-- then need base_currency + rate_date for range lookups or MAX(rate_date).
-- The PK is (base_currency, quote_currency, rate_date) — wrong column order.
-- INCLUDE (rate) makes rate_ranges / latest_rates CTEs index-only scans.

CREATE INDEX idx_exchange_rates_quote_base_date
    ON exchange_rates (quote_currency, base_currency, rate_date)
    INCLUDE (rate);


-- ============================================================================
-- ledger_entries: workspace-prefixed composite indexes
-- ============================================================================
--
-- Drop indexes superseded by new composites. Keep idx_ledger_entries_ts
-- (worker runs MIN(ts) without RLS context) and idx_ledger_entries_event
-- (event_id point lookups on INSERT dedup).

DROP INDEX idx_ledger_entries_account_ts;
DROP INDEX idx_ledger_entries_kind_category_ts;
DROP INDEX idx_ledger_entries_workspace_id;

-- Default ORDER BY ts DESC + date-range filters.
-- Covers: getTransactions (default sort), budget actual CTE, cumulative_balance,
-- ACCOUNTS_QUERY balance aggregation, MONTH_END_BALANCES monthly_deltas.

CREATE INDEX idx_le_ws_ts
    ON ledger_entries (workspace_id, ts DESC);

-- Account-level queries: balances, staleness window functions, accounts view.
-- Covers: ACCOUNTS_QUERY (GROUP BY account_id), STALENESS_QUERY
-- (PARTITION BY account_id ORDER BY ts), account filter in getTransactions.

CREATE INDEX idx_le_ws_account_ts
    ON ledger_entries (workspace_id, account_id, ts);

-- Kind/category filter in transactions + budget grid actual CTE.
-- Covers: getTransactions filtered by kind/category, budget actual grouping
-- by (kind AS direction, category).

CREATE INDEX idx_le_ws_kind_cat_ts
    ON ledger_entries (workspace_id, kind, category, ts);

-- Covering index for accounts view (GROUP BY account_id with MODE(currency),
-- MIN(inserted_at)). Enables index-only scan when building the view through RLS.

CREATE INDEX idx_le_ws_account_covering
    ON ledger_entries (workspace_id, account_id)
    INCLUDE (currency, inserted_at);

-- Partial index for non-transfer queries. STALENESS_QUERY runs three CTEs
-- that all filter kind != 'transfer' (txns, counts, counts_30d). Smaller
-- index = faster scans + less memory.

CREATE INDEX idx_le_ws_account_ts_no_transfer
    ON ledger_entries (workspace_id, account_id, ts)
    WHERE kind != 'transfer';


-- ============================================================================
-- budget_lines: workspace-prefixed lookup
-- ============================================================================
--
-- latest_plans CTE uses ROW_NUMBER() OVER (PARTITION BY budget_month,
-- direction, category, kind ORDER BY inserted_at DESC) with a range filter
-- on budget_month. Old index lacked workspace_id, so RLS forced a recheck
-- on every row. New index satisfies both RLS and the window function.

DROP INDEX idx_budget_lines_lookup;
DROP INDEX idx_budget_lines_workspace_id;

CREATE INDEX idx_budget_lines_lookup
    ON budget_lines (workspace_id, budget_month, direction, category, kind, inserted_at DESC);


-- ============================================================================
-- budget_comments: workspace-prefixed lookup
-- ============================================================================
--
-- getCommentedCells: range scan on budget_month + ROW_NUMBER partitioned by
-- (budget_month, direction, category) ordered by inserted_at DESC.
-- getLatestComment: point lookup on (budget_month, direction, category) +
-- ORDER BY inserted_at DESC LIMIT 1.
-- Both patterns served by the same index with workspace_id leading.

DROP INDEX idx_budget_comments_lookup;
DROP INDEX idx_budget_comments_workspace_id;

CREATE INDEX idx_budget_comments_lookup
    ON budget_comments (workspace_id, budget_month, direction, category, inserted_at DESC);
