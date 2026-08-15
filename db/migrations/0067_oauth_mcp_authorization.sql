-- OAuth 2.1 authorization state for public MCP clients.

CREATE TABLE auth.oauth_clients (
  client_id       TEXT        NOT NULL PRIMARY KEY CHECK (length(client_id) BETWEEN 20 AND 128),
  client_name     TEXT        NOT NULL CHECK (btrim(client_name) <> '' AND length(client_name) <= 200),
  redirect_uris   TEXT[]      NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth.oauth_connections (
  connection_id   TEXT        NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  client_id       TEXT        NOT NULL REFERENCES auth.oauth_clients(client_id) ON DELETE CASCADE,
  user_id         TEXT        NOT NULL CHECK (btrim(user_id) <> ''),
  resource        TEXT        NOT NULL CHECK (
    resource ~ '^https://mcp[.][A-Za-z0-9.-]+/mcp$'
    OR resource ~ '^http://localhost(:[0-9]{1,5})?/mcp$'
    OR resource ~ '^http://127([.][0-9]{1,3}){3}(:[0-9]{1,5})?/mcp$'
    OR resource ~ '^http://[[]::1[]](:[0-9]{1,5})?/mcp$'
  ),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_oauth_connections_active_grant
  ON auth.oauth_connections (client_id, user_id, resource)
  WHERE revoked_at IS NULL;

CREATE TABLE auth.oauth_authorization_codes (
  code_hash        TEXT        NOT NULL PRIMARY KEY CHECK (length(code_hash) = 64),
  connection_id    TEXT        NOT NULL REFERENCES auth.oauth_connections(connection_id) ON DELETE CASCADE,
  redirect_uri     TEXT        NOT NULL CHECK (btrim(redirect_uri) <> ''),
  code_challenge   TEXT        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes           TEXT[]      NOT NULL CHECK (
    scopes = ARRAY['expenses:read']::TEXT[]
    OR scopes = ARRAY['expenses:read', 'expenses:write']::TEXT[]
  ),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  used_at          TIMESTAMPTZ
);

CREATE INDEX idx_oauth_authorization_codes_expires_at
  ON auth.oauth_authorization_codes (expires_at);

CREATE TABLE auth.oauth_access_tokens (
  token_hash       TEXT        NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64),
  connection_id    TEXT        NOT NULL REFERENCES auth.oauth_connections(connection_id) ON DELETE CASCADE,
  scopes           TEXT[]      NOT NULL CHECK (
    scopes = ARRAY['expenses:read']::TEXT[]
    OR scopes = ARRAY['expenses:read', 'expenses:write']::TEXT[]
  ),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '1 hour')
);

CREATE INDEX idx_oauth_access_tokens_expires_at
  ON auth.oauth_access_tokens (expires_at);

CREATE TABLE auth.oauth_refresh_tokens (
  token_hash       TEXT        NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64),
  connection_id    TEXT        NOT NULL REFERENCES auth.oauth_connections(connection_id) ON DELETE CASCADE,
  scopes           TEXT[]      NOT NULL CHECK (
    scopes = ARRAY['expenses:read']::TEXT[]
    OR scopes = ARRAY['expenses:read', 'expenses:write']::TEXT[]
  ),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'),
  used_at          TIMESTAMPTZ
);

CREATE INDEX idx_oauth_refresh_tokens_expires_at
  ON auth.oauth_refresh_tokens (expires_at);

GRANT SELECT, INSERT ON TABLE auth.oauth_clients TO auth_service;
GRANT SELECT, INSERT ON TABLE auth.oauth_connections TO auth_service;
GRANT UPDATE (updated_at, revoked_at) ON TABLE auth.oauth_connections TO auth_service;
GRANT SELECT, INSERT ON TABLE auth.oauth_authorization_codes TO auth_service;
GRANT UPDATE (used_at) ON TABLE auth.oauth_authorization_codes TO auth_service;
GRANT INSERT ON TABLE auth.oauth_access_tokens TO auth_service;
GRANT SELECT, INSERT ON TABLE auth.oauth_refresh_tokens TO auth_service;
GRANT UPDATE (used_at) ON TABLE auth.oauth_refresh_tokens TO auth_service;

CREATE FUNCTION auth.validate_oauth_access_token(p_token_hash TEXT)
RETURNS TABLE(
  connection_id TEXT,
  user_id TEXT,
  client_id TEXT,
  resource TEXT,
  scopes TEXT[],
  expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth
AS $$
  SELECT oat.connection_id,
         oc.user_id,
         oc.client_id,
         oc.resource,
         oat.scopes,
         oat.expires_at
  FROM auth.oauth_access_tokens oat
  JOIN auth.oauth_connections oc ON oc.connection_id = oat.connection_id
  WHERE oat.token_hash = p_token_hash
    AND oat.expires_at > now()
    AND oc.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION auth.validate_oauth_access_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.validate_oauth_access_token(TEXT) TO app;
