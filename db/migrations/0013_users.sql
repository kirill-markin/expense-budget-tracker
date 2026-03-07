-- Users: Postgres mirror of Cognito identities.
--
-- user_id is the Cognito sub (or "local" in dev). This table is an identity
-- mirror, not the primary auth source. Workspace authorization remains based on
-- workspace_members and workspace-scoped RLS.

CREATE TABLE users (
  user_id             TEXT        NOT NULL PRIMARY KEY,
  email               TEXT        NOT NULL CHECK (email <> ''),
  email_verified      BOOLEAN     NOT NULL,
  cognito_status      TEXT        NOT NULL,
  cognito_enabled     BOOLEAN     NOT NULL,
  cognito_created_at  TIMESTAMPTZ,
  cognito_updated_at  TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_last_seen_at ON users (last_seen_at);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY user_self_access ON users
  FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE ON TABLE users TO app;

INSERT INTO users (
  user_id,
  email,
  email_verified,
  cognito_status,
  cognito_enabled
) VALUES (
  'local',
  'local@example.invalid',
  true,
  'LOCAL',
  true
);
