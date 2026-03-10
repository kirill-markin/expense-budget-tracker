-- Opaque OTP handles for terminal-first agent auth.
--
-- The client only receives a short random handle. The underlying Cognito
-- session stays server-side for the three-minute OTP lifetime.

CREATE TABLE auth.agent_otp_challenges (
  challenge_id_hash  TEXT        NOT NULL PRIMARY KEY CHECK (length(challenge_id_hash) = 64),
  normalized_email   TEXT        NOT NULL CHECK (length(normalized_email) <= 256),
  cognito_session    TEXT        NOT NULL CHECK (btrim(cognito_session) <> ''),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ
);

CREATE INDEX idx_agent_otp_challenges_expires_at
  ON auth.agent_otp_challenges (expires_at);

CREATE INDEX idx_agent_otp_challenges_email_created_at
  ON auth.agent_otp_challenges (normalized_email, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE auth.agent_otp_challenges TO auth_service;
