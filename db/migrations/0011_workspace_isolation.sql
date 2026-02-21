-- Migrate from per-user isolation (user_id) to workspace-based isolation (workspace_id).
-- Adds workspaces and workspace_members tables, renames user_id → workspace_id on
-- four tables, and replaces RLS policies with workspace membership checks.

-- 1. Create workspace tables
CREATE TABLE workspaces (
  workspace_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user_id ON workspace_members (user_id);

-- 2. Migrate existing data: each distinct user_id → workspace + self-membership
INSERT INTO workspaces (workspace_id, name)
SELECT DISTINCT user_id, user_id
FROM (
  SELECT user_id FROM ledger_entries
  UNION SELECT user_id FROM budget_lines
  UNION SELECT user_id FROM budget_comments
  UNION SELECT user_id FROM workspace_settings
) all_users;

INSERT INTO workspace_members (workspace_id, user_id)
SELECT workspace_id, workspace_id FROM workspaces;

-- 3. Rename user_id → workspace_id on 4 tables
ALTER TABLE ledger_entries RENAME COLUMN user_id TO workspace_id;
ALTER TABLE budget_lines RENAME COLUMN user_id TO workspace_id;
ALTER TABLE budget_comments RENAME COLUMN user_id TO workspace_id;
ALTER TABLE workspace_settings RENAME COLUMN user_id TO workspace_id;

-- 4. Rename indexes
ALTER INDEX idx_ledger_entries_user_id RENAME TO idx_ledger_entries_workspace_id;
ALTER INDEX idx_budget_lines_user_id RENAME TO idx_budget_lines_workspace_id;
ALTER INDEX idx_budget_comments_user_id RENAME TO idx_budget_comments_workspace_id;

-- 5. Drop old RLS policies
DROP POLICY user_isolation ON ledger_entries;
DROP POLICY user_isolation ON budget_lines;
DROP POLICY user_isolation ON budget_comments;
DROP POLICY user_isolation ON workspace_settings;

-- 6. New RLS policies on main tables
-- Two conditions: membership check (security) + workspace_id equality (performance).
-- If app.workspace_id is NULL, only the membership check applies (direct DB users
-- see all their workspaces).
CREATE POLICY workspace_isolation ON ledger_entries
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  )
  WITH CHECK (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  );

CREATE POLICY workspace_isolation ON budget_lines
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  )
  WITH CHECK (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  );

CREATE POLICY workspace_isolation ON budget_comments
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  )
  WITH CHECK (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  );

CREATE POLICY workspace_isolation ON workspace_settings
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  )
  WITH CHECK (
    workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true))
    AND (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true))
  );

-- 7. RLS on workspace_members (user sees only their own memberships)
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY user_memberships ON workspace_members
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

-- 8. RLS on workspaces (user sees only workspaces they belong to)
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_member_access ON workspaces
  USING (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true)));
