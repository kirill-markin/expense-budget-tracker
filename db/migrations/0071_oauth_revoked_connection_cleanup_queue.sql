-- Bound revoked OAuth tombstone cleanup with a database-enforced fair queue.

CREATE SEQUENCE auth.oauth_revoked_cleanup_queue_position_seq AS BIGINT;

CREATE TABLE auth.oauth_revoked_connection_cleanup_queue (
  connection_id  TEXT   NOT NULL PRIMARY KEY
    REFERENCES auth.oauth_connections(connection_id) ON DELETE CASCADE,
  queue_position BIGINT NOT NULL DEFAULT nextval('auth.oauth_revoked_cleanup_queue_position_seq'::regclass)
);

ALTER SEQUENCE auth.oauth_revoked_cleanup_queue_position_seq
  OWNED BY auth.oauth_revoked_connection_cleanup_queue.queue_position;

CREATE UNIQUE INDEX idx_oauth_revoked_cleanup_queue_position
  ON auth.oauth_revoked_connection_cleanup_queue (queue_position);

REVOKE ALL ON TABLE auth.oauth_revoked_connection_cleanup_queue FROM PUBLIC, auth_service;
REVOKE ALL ON SEQUENCE auth.oauth_revoked_cleanup_queue_position_seq FROM PUBLIC, auth_service;

CREATE FUNCTION auth.enqueue_revoked_oauth_connection_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
BEGIN
  INSERT INTO auth.oauth_revoked_connection_cleanup_queue (connection_id)
  VALUES (NEW.connection_id)
  ON CONFLICT (connection_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION auth.enqueue_revoked_oauth_connection_cleanup() FROM PUBLIC;

CREATE TRIGGER enqueue_inserted_revoked_oauth_connection_cleanup
AFTER INSERT ON auth.oauth_connections
FOR EACH ROW
WHEN (NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION auth.enqueue_revoked_oauth_connection_cleanup();

CREATE TRIGGER enqueue_newly_revoked_oauth_connection_cleanup
AFTER UPDATE OF revoked_at ON auth.oauth_connections
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION auth.enqueue_revoked_oauth_connection_cleanup();

INSERT INTO auth.oauth_revoked_connection_cleanup_queue (connection_id)
SELECT connection.connection_id
FROM auth.oauth_connections AS connection
WHERE connection.revoked_at IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM auth.oauth_authorization_codes AS authorization_code
      WHERE authorization_code.connection_id = connection.connection_id
        AND authorization_code.used_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM auth.oauth_refresh_tokens AS refresh_token
      WHERE refresh_token.connection_id = connection.connection_id
        AND refresh_token.used_at IS NOT NULL
    )
  )
ORDER BY connection.connection_id
ON CONFLICT (connection_id) DO NOTHING;

CREATE OR REPLACE FUNCTION auth.cleanup_expired_oauth_transient_state()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
DECLARE
  v_cleanup_connection_id TEXT;
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

  SELECT queued_connection.connection_id
  INTO v_cleanup_connection_id
  FROM auth.oauth_revoked_connection_cleanup_queue AS queued_connection
  ORDER BY queued_connection.queue_position
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_cleanup_connection_id IS NOT NULL THEN
    WITH used_on_revoked_connection AS MATERIALIZED (
      SELECT authorization_code.code_hash
      FROM auth.oauth_authorization_codes AS authorization_code
      WHERE authorization_code.connection_id = v_cleanup_connection_id
        AND authorization_code.used_at IS NOT NULL
      ORDER BY authorization_code.used_at DESC, authorization_code.code_hash
      LIMIT (100 - v_deleted_count)
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM auth.oauth_authorization_codes AS authorization_code
    USING used_on_revoked_connection
    WHERE authorization_code.code_hash = used_on_revoked_connection.code_hash;
  END IF;

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

  IF v_cleanup_connection_id IS NOT NULL THEN
    WITH used_on_revoked_connection AS MATERIALIZED (
      SELECT refresh_token.token_hash
      FROM auth.oauth_refresh_tokens AS refresh_token
      WHERE refresh_token.connection_id = v_cleanup_connection_id
        AND refresh_token.used_at IS NOT NULL
      ORDER BY refresh_token.used_at DESC, refresh_token.token_hash
      LIMIT (100 - v_deleted_count)
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM auth.oauth_refresh_tokens AS refresh_token
    USING used_on_revoked_connection
    WHERE refresh_token.token_hash = used_on_revoked_connection.token_hash;

    DELETE FROM auth.oauth_revoked_connection_cleanup_queue AS queued_connection
    WHERE queued_connection.connection_id = v_cleanup_connection_id
      AND NOT EXISTS (
        SELECT 1
        FROM auth.oauth_authorization_codes AS authorization_code
        WHERE authorization_code.connection_id = queued_connection.connection_id
          AND authorization_code.used_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM auth.oauth_refresh_tokens AS refresh_token
        WHERE refresh_token.connection_id = queued_connection.connection_id
          AND refresh_token.used_at IS NOT NULL
      );

    UPDATE auth.oauth_revoked_connection_cleanup_queue AS queued_connection
    SET queue_position = nextval('auth.oauth_revoked_cleanup_queue_position_seq'::regclass)
    WHERE queued_connection.connection_id = v_cleanup_connection_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION auth.cleanup_expired_oauth_transient_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.cleanup_expired_oauth_transient_state() TO auth_service;
