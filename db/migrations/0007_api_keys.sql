-- API keys: Bearer token authentication for the SQL query API endpoint.
--
-- Replaces the need for direct Postgres credentials (NLB on port 5432) with
-- standard HTTP: users generate an API key, pass it as a Bearer token, and
-- send SQL in a JSON body. Simpler for LLM agents (just curl), cheaper
-- (no NLB), and easier to control.
--
-- Key format: ebt_ + 40 alphanumeric chars (~238 bits entropy).
-- Storage: SHA-256 hash only — plaintext never stored.
-- Auth flow: hash the Bearer token → look up via SECURITY DEFINER function
-- (bypasses RLS since identity is unknown at validation time) → set
-- app.user_id + app.workspace_id → execute query with full RLS.

-- ==========================================================================
-- 1. Table
-- ==========================================================================

CREATE TABLE api_keys (
  id            TEXT        NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  workspace_id  TEXT        NOT NULL REFERENCES workspaces(workspace_id),
  user_id       TEXT        NOT NULL,
  key_hash      TEXT        NOT NULL UNIQUE,
  key_prefix    TEXT        NOT NULL,
  label         TEXT        NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- ==========================================================================
-- 2. RLS policies (same dual-layer pattern as all other tables)
-- ==========================================================================

-- PERMISSIVE: app role sees keys for user's workspaces.
CREATE POLICY app_access ON api_keys
  USING (
    current_user = 'app'
    AND workspace_id IN (
      SELECT get_user_workspace_ids(current_setting('app.user_id', true))
    )
  );

-- RESTRICTIVE: same current_user guard as other tables.
CREATE POLICY role_restriction ON api_keys AS RESTRICTIVE
  USING (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  )
  WITH CHECK (
    current_user = 'app'
    OR workspace_id = (
      SELECT dar.workspace_id FROM direct_access_roles dar
      WHERE dar.pg_role = current_user
    )
  );

-- ==========================================================================
-- 3. SECURITY DEFINER validation function
-- ==========================================================================
--
-- At validation time we don't know userId/workspaceId — that's what we're
-- looking up. SECURITY DEFINER bypasses RLS for this specific lookup.
-- Safe because key_hash is derived from a high-entropy secret.

CREATE FUNCTION validate_api_key(p_key_hash TEXT)
RETURNS TABLE(user_id TEXT, workspace_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ak.user_id, ak.workspace_id
  FROM api_keys ak
  WHERE ak.key_hash = p_key_hash;
$$;

-- ==========================================================================
-- 4. Auto-revoke trigger on workspace member removal
-- ==========================================================================
--
-- Same pattern as trg_revoke_direct_access_on_member_removal: when a user
-- is removed from a workspace, delete all their API keys for that workspace.

CREATE OR REPLACE FUNCTION on_workspace_member_removed_api_keys()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM api_keys
  WHERE workspace_id = OLD.workspace_id
    AND user_id = OLD.user_id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_revoke_api_keys_on_member_removal
  AFTER DELETE ON workspace_members
  FOR EACH ROW
  EXECUTE FUNCTION on_workspace_member_removed_api_keys();

-- ==========================================================================
-- 5. Grants
-- ==========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE api_keys TO app;
GRANT EXECUTE ON FUNCTION validate_api_key(TEXT) TO app;
