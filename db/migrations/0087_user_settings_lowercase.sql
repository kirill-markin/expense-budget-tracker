-- Lowercase affects presentation only; stored text retains its original case.
ALTER TABLE user_settings
  ADD COLUMN lowercase BOOLEAN NOT NULL DEFAULT FALSE;
