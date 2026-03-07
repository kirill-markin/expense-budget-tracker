-- Restrict SECURITY DEFINER helpers to the app role only.
--
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. That is too
-- broad for SECURITY DEFINER helpers, because user-controlled SQL can call
-- them directly unless EXECUTE is revoked explicitly.

REVOKE ALL ON FUNCTION validate_api_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION validate_api_key(TEXT) TO app;

REVOKE ALL ON FUNCTION get_user_workspace_ids(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_workspace_ids(TEXT) TO app;

REVOKE ALL ON FUNCTION on_workspace_member_removed_api_keys() FROM PUBLIC;
