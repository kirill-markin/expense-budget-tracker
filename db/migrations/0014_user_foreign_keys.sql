-- Stage 2: add user foreign keys without validating historical rows yet.
--
-- NOT VALID keeps the migration non-blocking for existing data while still
-- enforcing the constraints for new writes after deployment.

ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) NOT VALID;

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) NOT VALID;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) NOT VALID;
