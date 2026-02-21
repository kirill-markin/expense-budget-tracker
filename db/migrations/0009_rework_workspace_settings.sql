-- Replace singleton workspace_settings (CHECK id = 1) with per-user rows (PK = user_id).
-- Preserves existing reporting_currency for the 'local' user.

DO $$
DECLARE
  old_currency TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspace_settings' AND column_name = 'id'
  ) THEN
    SELECT reporting_currency INTO old_currency
    FROM workspace_settings
    WHERE id = 1;

    DROP TABLE workspace_settings;

    CREATE TABLE workspace_settings (
      user_id            TEXT NOT NULL,
      reporting_currency TEXT NOT NULL DEFAULT 'USD',
      PRIMARY KEY (user_id)
    );

    INSERT INTO workspace_settings (user_id, reporting_currency)
    VALUES ('local', COALESCE(old_currency, 'USD'));
  END IF;
END
$$;
