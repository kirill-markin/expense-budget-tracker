-- Accounts view: derived from ledger_entries (no physical table).

CREATE OR REPLACE VIEW accounts AS
SELECT
  account_id,
  MODE() WITHIN GROUP (ORDER BY currency) AS currency,
  MIN(inserted_at) AS inserted_at
FROM ledger_entries
GROUP BY account_id;
