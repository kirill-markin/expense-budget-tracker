-- Add user_id to ledger_entries for per-user RLS isolation.
-- Existing rows get user_id = 'local' (single-user localhost default).

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'local';

CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_id
  ON ledger_entries (user_id);
