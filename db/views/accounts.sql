-- Accounts view: derived from ledger_entries (no physical table).
--
-- security_invoker = true (PG 15+): RLS policies on ledger_entries evaluate
-- current_user as the querying role, not the view owner (tracker). Without this,
-- direct access roles (ws_xxx) would have current_user='tracker' inside the
-- view, and the RESTRICTIVE policy would block all rows.

CREATE OR REPLACE VIEW accounts WITH (security_invoker = true) AS
SELECT
  account_id,
  MODE() WITHIN GROUP (ORDER BY currency) AS currency,
  MIN(inserted_at) AS inserted_at
FROM ledger_entries
GROUP BY account_id;

-- Grant after view creation (can't live in migrations — view doesn't exist yet).
GRANT SELECT ON accounts TO app;

-- Grant to api_sql_executor if the role exists (created by migration 0012).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_sql_executor') THEN
    EXECUTE 'GRANT SELECT ON accounts TO api_sql_executor';
  END IF;
END
$$;
