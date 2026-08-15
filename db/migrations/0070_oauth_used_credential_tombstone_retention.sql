-- Retain used OAuth credentials as replay-detection tombstones while their
-- connection is active, and keep each cleanup path directly indexable.

CREATE INDEX idx_oauth_connections_revoked_connection_id
  ON auth.oauth_connections (connection_id)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX idx_oauth_authorization_codes_unused_expires_at
  ON auth.oauth_authorization_codes (expires_at, code_hash)
  WHERE used_at IS NULL;

CREATE INDEX idx_oauth_refresh_tokens_unused_expires_at
  ON auth.oauth_refresh_tokens (expires_at, token_hash)
  WHERE used_at IS NULL;

CREATE OR REPLACE FUNCTION auth.cleanup_expired_oauth_transient_state()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  WITH expired_unused AS MATERIALIZED (
    SELECT code_hash
    FROM auth.oauth_authorization_codes
    WHERE used_at IS NULL
      AND expires_at <= now()
    ORDER BY expires_at, code_hash
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth.oauth_authorization_codes AS authorization_code
  USING expired_unused
  WHERE authorization_code.code_hash = expired_unused.code_hash;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  WITH used_on_revoked_connection AS MATERIALIZED (
    SELECT used_authorization_code.code_hash
    FROM (
      SELECT connection_id
      FROM auth.oauth_connections
      WHERE revoked_at IS NOT NULL
      ORDER BY connection_id
    ) AS revoked_connection
    CROSS JOIN LATERAL (
      SELECT authorization_code.code_hash
      FROM auth.oauth_authorization_codes AS authorization_code
      WHERE authorization_code.connection_id = revoked_connection.connection_id
        AND authorization_code.used_at IS NOT NULL
      ORDER BY authorization_code.used_at DESC
      LIMIT (100 - v_deleted_count)
      FOR UPDATE SKIP LOCKED
    ) AS used_authorization_code
    LIMIT (100 - v_deleted_count)
  )
  DELETE FROM auth.oauth_authorization_codes AS authorization_code
  USING used_on_revoked_connection
  WHERE authorization_code.code_hash = used_on_revoked_connection.code_hash;

  WITH expired AS MATERIALIZED (
    SELECT token_hash
    FROM auth.oauth_access_tokens
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth.oauth_access_tokens AS access_token
  USING expired
  WHERE access_token.token_hash = expired.token_hash;

  WITH expired_unused AS MATERIALIZED (
    SELECT token_hash
    FROM auth.oauth_refresh_tokens
    WHERE used_at IS NULL
      AND expires_at <= now()
    ORDER BY expires_at, token_hash
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth.oauth_refresh_tokens AS refresh_token
  USING expired_unused
  WHERE refresh_token.token_hash = expired_unused.token_hash;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  WITH used_on_revoked_connection AS MATERIALIZED (
    SELECT used_refresh_token.token_hash
    FROM (
      SELECT connection_id
      FROM auth.oauth_connections
      WHERE revoked_at IS NOT NULL
      ORDER BY connection_id
    ) AS revoked_connection
    CROSS JOIN LATERAL (
      SELECT refresh_token.token_hash
      FROM auth.oauth_refresh_tokens AS refresh_token
      WHERE refresh_token.connection_id = revoked_connection.connection_id
        AND refresh_token.used_at IS NOT NULL
      ORDER BY refresh_token.used_at DESC
      LIMIT (100 - v_deleted_count)
      FOR UPDATE SKIP LOCKED
    ) AS used_refresh_token
    LIMIT (100 - v_deleted_count)
  )
  DELETE FROM auth.oauth_refresh_tokens AS refresh_token
  USING used_on_revoked_connection
  WHERE refresh_token.token_hash = used_on_revoked_connection.token_hash;
END;
$$;

REVOKE ALL ON FUNCTION auth.cleanup_expired_oauth_transient_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.cleanup_expired_oauth_transient_state() TO auth_service;
