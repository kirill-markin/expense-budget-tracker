-- Enable Row Level Security on all user-scoped tables.
-- Policy reads app.user_id session variable set per-transaction by the app role.
-- current_setting('app.user_id', true) returns NULL if unset — queries return nothing (fail-safe).

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE budget_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_comments FORCE ROW LEVEL SECURITY;

ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_isolation ON ledger_entries;
DROP POLICY IF EXISTS user_isolation ON budget_lines;
DROP POLICY IF EXISTS user_isolation ON budget_comments;
DROP POLICY IF EXISTS user_isolation ON workspace_settings;

CREATE POLICY user_isolation ON ledger_entries
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

CREATE POLICY user_isolation ON budget_lines
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

CREATE POLICY user_isolation ON budget_comments
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

CREATE POLICY user_isolation ON workspace_settings
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
