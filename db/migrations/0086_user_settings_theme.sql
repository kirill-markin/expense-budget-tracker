-- Carry the theme preference with the user instead of the browser it was chosen in.
ALTER TABLE user_settings
  ADD COLUMN theme TEXT NOT NULL DEFAULT 'system',
  ADD CONSTRAINT user_settings_theme_check
  CHECK (theme IN ('system', 'light', 'dark'));
