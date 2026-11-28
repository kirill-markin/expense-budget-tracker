import { type SupportedLocale } from "@expense-budget-tracker/agent-shared/locales";

const browserErrorMessages = {
  internal_server_error: "Internal server error",
  invalid_request_body: "Invalid request body",
  invalid_email: "Invalid email",
  demo_sign_in_failed: "Demo sign-in failed",
  send_code_failed: "Failed to send code — please try again",
  send_rate_limited: "Too many requests — please wait before trying again",
  otp_session_expired: "Session expired — request a new code",
  invalid_otp_code: "Enter an 8-digit code",
  verify_code_failed: "Verification failed — please try again",
} as const;

type BrowserErrorCode = keyof typeof browserErrorMessages;

export const browserError = (errorCode: BrowserErrorCode): Readonly<{ error: string; errorCode: BrowserErrorCode }> => ({
  error: browserErrorMessages[errorCode],
  errorCode,
});

const englishFeedback = { ...browserErrorMessages, httpError: "Error: {status}" };
type LoginFeedback = Readonly<Record<keyof typeof englishFeedback, string>>;

const feedbackTranslations: Readonly<Partial<Record<SupportedLocale, Partial<LoginFeedback>>>> = {};

export const getLoginFeedback = (locale: SupportedLocale): LoginFeedback => ({
  ...englishFeedback,
  ...feedbackTranslations[locale],
});
