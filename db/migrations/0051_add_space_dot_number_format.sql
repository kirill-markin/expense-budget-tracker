ALTER TABLE user_settings
  DROP CONSTRAINT user_settings_number_format_check;

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_number_format_check
  CHECK (number_format IN ('1,234.56', '1 234,56', '1.234,56', '1 234.56'));
