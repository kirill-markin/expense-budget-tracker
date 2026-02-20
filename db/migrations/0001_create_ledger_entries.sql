-- Ledger entries: one row per account movement.

CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id    TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  event_id    TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  account_id  TEXT        NOT NULL,
  amount      NUMERIC     NOT NULL,
  currency    TEXT        NOT NULL,
  kind        TEXT        NOT NULL CHECK (kind IN ('income', 'spend', 'transfer')),
  category    TEXT,
  counterparty TEXT,
  note        TEXT,
  external_id TEXT,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (entry_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_ts
  ON ledger_entries (ts);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_ts
  ON ledger_entries (account_id, ts);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_event
  ON ledger_entries (event_id);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_kind_category_ts
  ON ledger_entries (kind, category, ts);
