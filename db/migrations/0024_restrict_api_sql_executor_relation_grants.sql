-- Tighten the restricted SQL execution role to the published allowlist.
--
-- User-submitted SQL should not rely on raw access to identity or membership
-- tables. Workspace listing and selection already run through trusted server
-- paths outside api_sql_executor.

REVOKE ALL ON TABLE user_settings FROM api_sql_executor;
REVOKE ALL ON TABLE workspaces FROM api_sql_executor;
REVOKE ALL ON TABLE workspace_members FROM api_sql_executor;
