-- Budget comments: append-only, last-write-wins by inserted_at.

CREATE TABLE IF NOT EXISTS budget_comments (
  budget_month  DATE        NOT NULL,
  direction     TEXT        NOT NULL,
  category      TEXT        NOT NULL,
  comment       TEXT        NOT NULL,
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_budget_comments_lookup
  ON budget_comments (direction, category, budget_month, inserted_at DESC);
