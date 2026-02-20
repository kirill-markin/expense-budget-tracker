-- Workspace settings: single-row config table.

CREATE TABLE IF NOT EXISTS workspace_settings (
  id                 INT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  reporting_currency TEXT NOT NULL DEFAULT 'USD'
);

INSERT INTO workspace_settings (id, reporting_currency)
VALUES (1, 'USD')
ON CONFLICT (id) DO NOTHING;
