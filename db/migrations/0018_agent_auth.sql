-- Agent auth: terminal-first OTP flow + long-lived agent API keys.
--
-- auth schema is intentionally isolated from the main workspace data model.
-- auth_service gets access only to limiter events, key rows, and narrow helper
-- functions for syncing the identity mirror.

CREATE SCHEMA IF NOT EXISTS auth;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_service') THEN
    CREATE ROLE auth_service WITH LOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO auth_service', current_database());
END
$$;

GRANT USAGE ON SCHEMA auth TO app;
GRANT USAGE ON SCHEMA auth TO auth_service;

-- ==========================================================================
-- 1. OTP send events
-- ==========================================================================

CREATE TABLE auth.agent_otp_send_events (
  event_id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  normalized_email  TEXT        NOT NULL CHECK (length(normalized_email) <= 256),
  request_ip        TEXT        NOT NULL CHECK (length(request_ip) <= 128),
  decision          TEXT        NOT NULL CHECK (decision IN ('allowed', 'suppressed_email_limit', 'blocked_ip_limit')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_otp_send_events_email_created_at
  ON auth.agent_otp_send_events (normalized_email, created_at DESC);

CREATE INDEX idx_agent_otp_send_events_ip_created_at
  ON auth.agent_otp_send_events (request_ip, created_at DESC);

GRANT SELECT, INSERT ON TABLE auth.agent_otp_send_events TO auth_service;

-- ==========================================================================
-- 2. Agent API keys
-- ==========================================================================

CREATE TABLE auth.agent_api_keys (
  connection_id  TEXT        NOT NULL DEFAULT gen_random_uuid()::text PRIMARY KEY,
  user_id        TEXT        NOT NULL,
  label          TEXT        NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 200),
  key_id         TEXT        NOT NULL UNIQUE CHECK (length(key_id) <= 64),
  key_hash       TEXT        NOT NULL CHECK (length(key_hash) = 64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX idx_agent_api_keys_user_created_at
  ON auth.agent_api_keys (user_id, created_at DESC);

ALTER TABLE auth.agent_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.agent_api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_api_keys_app_self_access ON auth.agent_api_keys
  FOR ALL
  USING (
    current_user = 'app'
    AND user_id = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_user = 'app'
    AND user_id = current_setting('app.user_id', true)
  );

CREATE POLICY agent_api_keys_auth_service_access ON auth.agent_api_keys
  FOR ALL
  USING (current_user = 'auth_service')
  WITH CHECK (current_user = 'auth_service');

GRANT SELECT, UPDATE ON TABLE auth.agent_api_keys TO app;
GRANT SELECT, INSERT, UPDATE ON TABLE auth.agent_api_keys TO auth_service;

-- ==========================================================================
-- 3. SECURITY DEFINER helpers
-- ==========================================================================

CREATE FUNCTION auth.validate_agent_api_key(p_key_id TEXT)
RETURNS TABLE(
  connection_id TEXT,
  user_id TEXT,
  email TEXT,
  key_hash TEXT,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  label TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT ak.connection_id,
         ak.user_id,
         u.email,
         ak.key_hash,
         ak.revoked_at,
         ak.last_used_at,
         ak.label,
         ak.created_at
  FROM auth.agent_api_keys ak
  LEFT JOIN public.users u ON u.user_id = ak.user_id
  WHERE ak.key_id = p_key_id;
$$;

CREATE FUNCTION auth.touch_agent_api_key_usage(p_connection_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  UPDATE auth.agent_api_keys
  SET last_used_at = now()
  WHERE connection_id = p_connection_id
    AND revoked_at IS NULL
    AND (
      last_used_at IS NULL
      OR last_used_at < now() - INTERVAL '5 minutes'
    );
END;
$$;

CREATE FUNCTION auth.sync_authenticated_user(p_user_id TEXT, p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'auth.sync_authenticated_user: p_user_id must be non-empty';
  END IF;

  IF p_email IS NULL OR p_email = '' THEN
    RAISE EXCEPTION 'auth.sync_authenticated_user: p_email must be non-empty';
  END IF;

  INSERT INTO public.users (
    user_id,
    email,
    email_verified,
    cognito_status,
    cognito_enabled
  ) VALUES (
    p_user_id,
    p_email,
    true,
    'CONFIRMED',
    true
  )
  ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email,
        email_verified = true,
        cognito_status = 'CONFIRMED',
        cognito_enabled = true,
        last_seen_at = now(),
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION auth.validate_agent_api_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.touch_agent_api_key_usage(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.sync_authenticated_user(TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.validate_agent_api_key(TEXT) TO app;
GRANT EXECUTE ON FUNCTION auth.touch_agent_api_key_usage(TEXT) TO app;
GRANT EXECUTE ON FUNCTION auth.sync_authenticated_user(TEXT, TEXT) TO auth_service;
