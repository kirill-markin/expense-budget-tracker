-- Add account group classification to account metadata.
--
-- Missing metadata rows remain valid. Existing rows are backfilled through the
-- non-null default, and balances treat absent rows as regular accounts.

ALTER TABLE account_metadata
  ADD COLUMN account_group TEXT NOT NULL DEFAULT 'regular';

ALTER TABLE account_metadata
  ADD CONSTRAINT account_metadata_account_group_check
  CHECK (account_group IN ('regular', 'investment'));
