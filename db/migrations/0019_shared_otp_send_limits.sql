-- Share OTP send limiter state across browser and agent flows.

ALTER TABLE auth.agent_otp_send_events
  RENAME TO otp_send_events;

ALTER INDEX auth.idx_agent_otp_send_events_email_created_at
  RENAME TO idx_otp_send_events_email_created_at;

ALTER INDEX auth.idx_agent_otp_send_events_ip_created_at
  RENAME TO idx_otp_send_events_ip_created_at;

UPDATE auth.otp_send_events
SET decision = 'blocked_email_limit'
WHERE decision = 'suppressed_email_limit';

ALTER TABLE auth.otp_send_events
  DROP CONSTRAINT agent_otp_send_events_decision_check;

ALTER TABLE auth.otp_send_events
  ADD CONSTRAINT otp_send_events_decision_check
  CHECK (decision IN ('allowed', 'blocked_email_limit', 'blocked_ip_limit'));
