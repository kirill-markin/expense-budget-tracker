-- Initial schema: tables, indexes, RLS policies, and default workspace.

-- ==========================================================================
-- Tables
-- ==========================================================================

CREATE TABLE workspaces (
  workspace_id TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) <= 200),
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
  account_id   TEXT        NOT NULL CHECK (length(account_id)   <= 200),
  amount       NUMERIC     NOT NULL,
  currency     TEXT        NOT NULL CHECK (length(currency)     <= 10),
  kind         TEXT        NOT NULL CHECK (kind IN ('income', 'spend', 'transfer')),
  category     TEXT                 CHECK (length(category)     <= 200),
  counterparty TEXT                 CHECK (length(counterparty) <= 200),
  note         TEXT                 CHECK (length(note)         <= 1000),
  external_id  TEXT                 CHECK (length(external_id)  <= 200),
  workspace_id TEXT        NOT NULL DEFAULT 'local',
  inserted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (entry_id)
);

-- Worker runs MIN(ts) without RLS context.
CREATE INDEX idx_ledger_entries_ts ON ledger_entries (ts);
-- event_id point lookups on INSERT dedup.
CREATE INDEX idx_ledger_entries_event ON ledger_entries (event_id);
-- Workspace-prefixed composites for RLS + business filters.
CREATE INDEX idx_le_ws_ts
    ON ledger_entries (workspace_id, ts DESC);
CREATE INDEX idx_le_ws_account_ts
    ON ledger_entries (workspace_id, account_id, ts);
CREATE INDEX idx_le_ws_kind_cat_ts
    ON ledger_entries (workspace_id, kind, category, ts);
CREATE INDEX idx_le_ws_account_covering
    ON ledger_entries (workspace_id, account_id)
    INCLUDE (currency, inserted_at);
CREATE INDEX idx_le_ws_account_ts_no_transfer
    ON ledger_entries (workspace_id, account_id, ts)
    WHERE kind != 'transfer';

-- Exchange rates: one row per currency pair per day (global, no workspace scoping).

CREATE TABLE exchange_rates (
  base_currency  TEXT    NOT NULL CHECK (length(base_currency)  <= 10),
  quote_currency TEXT    NOT NULL CHECK (length(quote_currency) <= 10),
  rate_date      DATE    NOT NULL,
  rate           NUMERIC NOT NULL,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (base_currency, quote_currency, rate_date)
);

CREATE INDEX idx_exchange_rates_quote_base_date
    ON exchange_rates (quote_currency, base_currency, rate_date)
    INCLUDE (rate);

-- Budget lines: append-only, last-write-wins by inserted_at.

CREATE TABLE budget_lines (
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL CHECK (length(category) <= 200),
  kind          TEXT        NOT NULL CHECK (kind IN ('base', 'modifier')),
  currency      TEXT        NOT NULL CHECK (length(currency) <= 10),
  planned_value NUMERIC     NOT NULL,
  workspace_id  TEXT        NOT NULL DEFAULT 'local',
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_budget_lines_lookup
    ON budget_lines (workspace_id, budget_month, direction, category, kind, inserted_at DESC);

-- Budget comments: append-only, last-write-wins by inserted_at.

CREATE TABLE budget_comments (
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL CHECK (length(category) <= 200),
  comment       TEXT        NOT NULL CHECK (length(comment)  <= 2000),
  workspace_id  TEXT        NOT NULL DEFAULT 'local',
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_budget_comments_lookup
    ON budget_comments (workspace_id, budget_month, direction, category, inserted_at DESC);

-- Workspace settings: per-workspace config.

CREATE TABLE workspace_settings (
  workspace_id       TEXT NOT NULL PRIMARY KEY,
  reporting_currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(reporting_currency) <= 10)
);

-- ==========================================================================
-- Row Level Security
-- ==========================================================================

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

-- PERMISSIVE policies: workspace isolation via membership check + optional workspace_id filter.

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

-- Allow users to self-provision their own workspace.
-- In AUTH_MODE=proxy, app.workspace_id is set server-side to the user's
-- Cognito sub (trusted). This INSERT-only policy lets the auto-provisioning
-- code create a workspace row matching that value before any membership exists.
CREATE POLICY workspace_self_provision ON workspaces
  FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ==========================================================================
-- Default workspace for single-user localhost mode
-- ==========================================================================

INSERT INTO workspaces (workspace_id, name) VALUES ('local', 'local');
INSERT INTO workspace_members (workspace_id, user_id) VALUES ('local', 'local');
INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ('local', 'USD');
