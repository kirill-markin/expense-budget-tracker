-- User settings table + new workspace settings columns for i18n/l10n.
--
-- user_settings: per-user display preferences (language, number/date format).
-- workspace_settings: adds first_day_of_week and timezone (shared across members).
--
-- user_id is the Cognito sub (or "local" in dev). No FK to a users table —
-- Cognito is the source of truth for user identity.

-- ==========================================================================
-- 1. user_settings table
-- ==========================================================================

CREATE TABLE user_settings (
  user_id       TEXT        NOT NULL PRIMARY KEY,
  locale        TEXT        NOT NULL DEFAULT 'en',
  number_format TEXT        NOT NULL DEFAULT '1,234.56'
                  CHECK (number_format IN ('1,234.56', '1 234,56', '1.234,56')),
  date_format   TEXT        NOT NULL DEFAULT 'YYYY-MM-DD'
                  CHECK (date_format IN ('DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==========================================================================
-- 2. RLS for user_settings
-- ==========================================================================

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY user_own_settings ON user_settings
  FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

-- ==========================================================================
-- 3. Grants for user_settings
-- ==========================================================================

GRANT SELECT, INSERT, UPDATE ON TABLE user_settings TO app;

-- ==========================================================================
-- 4. New columns on workspace_settings
-- ==========================================================================

ALTER TABLE workspace_settings
  ADD COLUMN first_day_of_week SMALLINT NOT NULL DEFAULT 1
    CHECK (first_day_of_week BETWEEN 1 AND 7),
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- ==========================================================================
-- 5. Default user_settings for local dev workspace
-- ==========================================================================

INSERT INTO user_settings (user_id) VALUES ('local');
