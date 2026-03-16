-- Unified OTP challenge lockout and browser persistence.
--
-- The existing agent challenge table becomes the shared challenge store for
-- both browser and agent flows. Browser rows add CSRF state; all rows use the
-- same failed-attempt lockout counter.

ALTER TABLE auth.agent_otp_challenges
  RENAME TO otp_challenges;

ALTER INDEX auth.idx_agent_otp_challenges_expires_at
  RENAME TO idx_otp_challenges_expires_at;

ALTER INDEX auth.idx_agent_otp_challenges_email_created_at
  RENAME TO idx_otp_challenges_email_created_at;

ALTER TABLE auth.otp_challenges
  ADD COLUMN transport TEXT NOT NULL DEFAULT 'agent'
    CHECK (transport IN ('browser', 'agent')),
  ADD COLUMN csrf_token TEXT,
  ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT otp_challenges_transport_csrf_check CHECK (
    (transport = 'browser' AND csrf_token IS NOT NULL AND btrim(csrf_token) <> '')
    OR (transport = 'agent' AND csrf_token IS NULL)
  );

GRANT SELECT, INSERT, UPDATE ON TABLE auth.otp_challenges TO auth_service;
