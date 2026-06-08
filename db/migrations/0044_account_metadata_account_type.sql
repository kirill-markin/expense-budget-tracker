ALTER TABLE account_metadata
  ADD COLUMN account_type TEXT NOT NULL DEFAULT 'personal'
    CHECK (account_type IN ('personal', 'business'));
