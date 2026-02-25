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
