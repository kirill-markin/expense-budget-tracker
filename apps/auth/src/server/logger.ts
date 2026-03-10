/**
 * Structured logger for auth service.
 *
 * Auth-only event types. Chat/API/SQL events stay in the web app.
 */
type AuthEvent =
  | Readonly<{ domain: "auth"; action: "send_code"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "send_code_rate_limited"; maskedEmail: string; decision: "blocked_email_limit" | "blocked_ip_limit" }>
  | Readonly<{ domain: "auth"; action: "send_code_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "agent_send_code"; maskedEmail: string; decision: "allowed" | "blocked_email_limit" | "blocked_ip_limit" }>
  | Readonly<{ domain: "auth"; action: "agent_verify_code_rejected"; reason: "invalid_code" | "invalid_label" | "invalid_otp_session" | "expired_otp_session"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "agent_verify_code_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "verify_code"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "verify_code_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "otp_sweep_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "error"; error: string }>;

type LogEvent = AuthEvent;

export const maskEmail = (email: string): string => {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***@${domain}`;
};

export const log = (event: LogEvent): void => {
  console.log(JSON.stringify(event));
};
