-- Sessions: server-side session store for cookie-based auth.

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT        PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions (expires_at);
