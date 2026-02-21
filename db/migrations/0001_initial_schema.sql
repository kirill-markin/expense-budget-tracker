-- Initial schema: all tables, indexes, RLS policies, and default workspace.

-- Workspaces and membership

CREATE TABLE workspaces (
  workspace_id TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_id      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_workspace_members_user_id ON workspace_members (user_id);

-- Ledger entries: one row per account movement.

CREATE TABLE ledger_entries (
  entry_id     TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  event_id     TEXT        NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  account_id   TEXT        NOT NULL,
  amount       NUMERIC     NOT NULL,
  currency     TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('income', 'spend', 'transfer')),
  category     TEXT,
  counterparty TEXT,
  note         TEXT,
  external_id  TEXT,
  workspace_id TEXT        NOT NULL DEFAULT 'local',
  inserted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (entry_id)
);

CREATE INDEX idx_ledger_entries_ts ON ledger_entries (ts);
CREATE INDEX idx_ledger_entries_account_ts ON ledger_entries (account_id, ts);
CREATE INDEX idx_ledger_entries_event ON ledger_entries (event_id);
CREATE INDEX idx_ledger_entries_kind_category_ts ON ledger_entries (kind, category, ts);
CREATE INDEX idx_ledger_entries_workspace_id ON ledger_entries (workspace_id);

-- Exchange rates: one row per currency pair per day (global, no workspace scoping).

CREATE TABLE exchange_rates (
  base_currency  TEXT    NOT NULL,
  quote_currency TEXT    NOT NULL,
  rate_date      DATE    NOT NULL,
  rate           NUMERIC NOT NULL,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (base_currency, quote_currency, rate_date)
);

-- Budget lines: append-only, last-write-wins by inserted_at.

CREATE TABLE budget_lines (
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('base', 'modifier')),
  currency      TEXT        NOT NULL,
  planned_value NUMERIC     NOT NULL,
  workspace_id  TEXT        NOT NULL DEFAULT 'local',
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_budget_lines_lookup ON budget_lines (budget_month, direction, category, kind, inserted_at DESC);
CREATE INDEX idx_budget_lines_workspace_id ON budget_lines (workspace_id);

-- Budget comments: append-only, last-write-wins by inserted_at.

CREATE TABLE budget_comments (
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  comment       TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL DEFAULT 'local',
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_budget_comments_lookup ON budget_comments (direction, category, budget_month, inserted_at DESC);
CREATE INDEX idx_budget_comments_workspace_id ON budget_comments (workspace_id);

-- Workspace settings: per-workspace config.

CREATE TABLE workspace_settings (
  workspace_id       TEXT NOT NULL PRIMARY KEY,
  reporting_currency TEXT NOT NULL DEFAULT 'USD'
);

-- Row Level Security

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;

ALTER TABLE budget_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_comments FORCE ROW LEVEL SECURITY;

ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;

-- RLS policies: workspace isolation via membership check + optional workspace_id filter.

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

CREATE POLICY user_memberships ON workspace_members
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

CREATE POLICY workspace_member_access ON workspaces
  USING (workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id', true)));

-- Default workspace for single-user localhost mode.

INSERT INTO workspaces (workspace_id, name) VALUES ('local', 'local');
INSERT INTO workspace_members (workspace_id, user_id) VALUES ('local', 'local');
INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ('local', 'USD');
