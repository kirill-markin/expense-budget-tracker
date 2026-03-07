-- Validate user foreign keys after the one-off Cognito -> Postgres backfill.
--
-- This runs separately from 0014 so production can first deploy the schema,
-- backfill historical users, and only then validate existing rows.

ALTER TABLE workspace_members
  VALIDATE CONSTRAINT workspace_members_user_id_fkey;

ALTER TABLE user_settings
  VALIDATE CONSTRAINT user_settings_user_id_fkey;

ALTER TABLE api_keys
  VALIDATE CONSTRAINT api_keys_user_id_fkey;
