/**
 * Structured logger for auth service.
 *
 * Auth-only event types. Chat/API/SQL events stay in the web app.
 */
export type SafeErrorType = "error" | "type_error" | "range_error" | "non_error";

export type CognitoRefreshRetryEvent = Readonly<{
  domain: "auth";
  action: "cognito_refresh_retry";
  level: "warn";
  attempt: number;
  retryInMs: number;
  cognitoType: string | null;
  status: number | null;
  error: string;
}>;

export type CognitoOAuthOwnerRetryEvent = Readonly<{
  domain: "auth";
  action: "cognito_oauth_owner_retry";
  level: "warn";
  attempt: number;
  retryInMs: number;
  cognitoType: string | null;
  status: number | null;
  errorType: SafeErrorType;
}>;

export const getSafeErrorType = (error: unknown): SafeErrorType => {
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error) return "error";
  return "non_error";
};

export type OAuthAuthorizationServerErrorEvent = Readonly<{
  domain: "auth";
  action: "oauth_authorization_server_error";
  method: "GET" | "POST";
  clientId: string;
  errorType: SafeErrorType;
}>;

export type OAuthEndpointServerErrorEvent = Readonly<{
  domain: "auth";
  action: "oauth_endpoint_server_error";
  endpoint: "registration" | "token";
  errorType: SafeErrorType;
}>;

export type AuthUnhandledErrorEvent = Readonly<{
  domain: "auth";
  action: "unhandled_error";
  surface: "oauth" | "login" | "api" | "other";
  method: "GET" | "POST" | "OPTIONS" | "OTHER";
  errorType: SafeErrorType;
}>;

type AuthEvent =
  | Readonly<{ domain: "auth"; action: "send_code"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "send_code_rate_limited"; maskedEmail: string; decision: "blocked_email_limit" | "blocked_ip_limit" }>
  | Readonly<{ domain: "auth"; action: "send_code_demo_sign_in"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "send_code_demo_sign_in_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "send_code_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "agent_send_code"; maskedEmail: string; decision: "allowed" | "blocked_email_limit" | "blocked_ip_limit" }>
  | Readonly<{ domain: "auth"; action: "agent_send_code_demo_sign_in"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "agent_verify_code_rejected"; reason: "invalid_code" | "invalid_label" | "invalid_otp_session" | "expired_otp_session"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "agent_verify_code_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "verify_code"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "verify_code_challenge_expired"; transport: "browser" | "agent"; maskedEmail: string }>
  | Readonly<{ domain: "auth"; action: "verify_code_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "otp_sweep_error"; error: string }>
  | CognitoRefreshRetryEvent
  | CognitoOAuthOwnerRetryEvent
  | OAuthAuthorizationServerErrorEvent
  | OAuthEndpointServerErrorEvent
  | AuthUnhandledErrorEvent
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
