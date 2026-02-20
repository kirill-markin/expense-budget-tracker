-- Budget lines: append-only, last-write-wins by inserted_at.

CREATE TABLE IF NOT EXISTS budget_lines (
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('base', 'modifier')),
  currency      TEXT        NOT NULL,
  planned_value NUMERIC     NOT NULL,
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_lookup
  ON budget_lines (budget_month, direction, category, kind, inserted_at DESC);
