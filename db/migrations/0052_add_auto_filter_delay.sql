ALTER TABLE user_settings
  ADD COLUMN auto_filter_delay_minutes SMALLINT DEFAULT 2,
  ADD CONSTRAINT user_settings_auto_filter_delay_minutes_check
  CHECK (auto_filter_delay_minutes IS NULL OR auto_filter_delay_minutes IN (1, 2, 5, 10, 30));
