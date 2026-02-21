-- Add user_id to budget_comments for per-user RLS isolation.
-- Existing rows get user_id = 'local' (single-user localhost default).

ALTER TABLE budget_comments
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'local';

CREATE INDEX IF NOT EXISTS idx_budget_comments_user_id
  ON budget_comments (user_id);
