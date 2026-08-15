-- Preserve durable OAuth activity and remove bounded batches of expired transient state.

ALTER TABLE auth.oauth_connections
  ADD COLUMN last_activity_at TIMESTAMPTZ;

UPDATE auth.oauth_connections AS connection
SET last_activity_at = activity.last_activity_at
FROM (
  SELECT event.connection_id, max(event.used_at) AS last_activity_at
  FROM (
    SELECT code.connection_id, code.used_at
    FROM auth.oauth_authorization_codes AS code
    WHERE code.used_at IS NOT NULL

    UNION ALL

    SELECT refresh_token.connection_id, refresh_token.used_at
    FROM auth.oauth_refresh_tokens AS refresh_token
    WHERE refresh_token.used_at IS NOT NULL
  ) AS event
  GROUP BY event.connection_id
) AS activity
WHERE connection.connection_id = activity.connection_id;

CREATE OR REPLACE FUNCTION auth.list_current_user_oauth_connections()
RETURNS TABLE(
  connection_id TEXT,
  client_name TEXT,
  created_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION 'auth.list_current_user_oauth_connections: app.user_id is not set';
  END IF;

  RETURN QUERY
    SELECT connection.connection_id,
           client.client_name,
           connection.created_at,
           connection.last_activity_at,
           connection.revoked_at
    FROM auth.oauth_connections AS connection
    JOIN auth.oauth_clients AS client ON client.client_id = connection.client_id
    WHERE connection.user_id = v_user_id
    ORDER BY connection.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION auth.list_current_user_oauth_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.list_current_user_oauth_connections() TO app;

CREATE FUNCTION auth.record_oauth_connection_activity(p_connection_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
BEGIN
  UPDATE auth.oauth_connections AS connection
  SET last_activity_at = GREATEST(
    COALESCE(connection.last_activity_at, '-infinity'::TIMESTAMPTZ),
    clock_timestamp()
  )
  WHERE connection.connection_id = p_connection_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth.record_oauth_connection_activity: OAuth connection % does not exist', p_connection_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION auth.record_oauth_connection_activity(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.record_oauth_connection_activity(TEXT) TO auth_service;

CREATE FUNCTION auth.cleanup_expired_oauth_transient_state()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
BEGIN
  WITH expired AS MATERIALIZED (
    SELECT code_hash
    FROM auth.oauth_authorization_codes
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth.oauth_authorization_codes AS authorization_code
  USING expired
  WHERE authorization_code.code_hash = expired.code_hash;

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

  WITH expired AS MATERIALIZED (
    SELECT token_hash
    FROM auth.oauth_refresh_tokens
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM auth.oauth_refresh_tokens AS refresh_token
  USING expired
  WHERE refresh_token.token_hash = expired.token_hash;
END;
$$;

REVOKE ALL ON FUNCTION auth.cleanup_expired_oauth_transient_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.cleanup_expired_oauth_transient_state() TO auth_service;
