-- Owner-scoped OAuth connection metadata and revocation for human settings.

CREATE INDEX idx_oauth_connections_user_created_at
  ON auth.oauth_connections (user_id, created_at DESC);

CREATE INDEX idx_oauth_authorization_codes_connection_used_at
  ON auth.oauth_authorization_codes (connection_id, used_at DESC)
  WHERE used_at IS NOT NULL;

CREATE INDEX idx_oauth_refresh_tokens_connection_used_at
  ON auth.oauth_refresh_tokens (connection_id, used_at DESC)
  WHERE used_at IS NOT NULL;

CREATE FUNCTION auth.list_current_user_oauth_connections()
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
           activity.last_activity_at,
           connection.revoked_at
    FROM auth.oauth_connections AS connection
    JOIN auth.oauth_clients AS client ON client.client_id = connection.client_id
    LEFT JOIN LATERAL (
      SELECT max(event.occurred_at) AS last_activity_at
      FROM (
        SELECT code.used_at AS occurred_at
        FROM auth.oauth_authorization_codes AS code
        WHERE code.connection_id = connection.connection_id
          AND code.used_at IS NOT NULL

        UNION ALL

        SELECT refresh_token.used_at AS occurred_at
        FROM auth.oauth_refresh_tokens AS refresh_token
        WHERE refresh_token.connection_id = connection.connection_id
          AND refresh_token.used_at IS NOT NULL
      ) AS event
    ) AS activity ON true
    WHERE connection.user_id = v_user_id
    ORDER BY connection.created_at DESC;
END;
$$;

CREATE FUNCTION auth.revoke_current_user_oauth_connection(p_connection_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION 'auth.revoke_current_user_oauth_connection: app.user_id is not set';
  END IF;

  UPDATE auth.oauth_connections AS connection
  SET revoked_at = COALESCE(connection.revoked_at, now())
  WHERE connection.connection_id = p_connection_id
    AND connection.user_id = v_user_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION auth.list_current_user_oauth_connections() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_current_user_oauth_connection(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.list_current_user_oauth_connections() TO app;
GRANT EXECUTE ON FUNCTION auth.revoke_current_user_oauth_connection(TEXT) TO app;
