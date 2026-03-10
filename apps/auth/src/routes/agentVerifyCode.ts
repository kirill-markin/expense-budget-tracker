/**
 * Agent OTP verification.
 *
 * Resolves a short opaque OTP handle to the server-side Cognito session, then
 * exchanges a valid Email OTP challenge for a long-lived agent API key.
 */
import { Hono } from "hono";
import {
  lookupAgentOtpChallenge,
  markAgentOtpChallengeUsed,
  type AgentOtpChallengeLookup,
} from "../server/agentOtpChallenges.js";
import { createAgentConnection, type AgentConnectionResult } from "../server/agentApiKeys.js";
import { buildErrorEnvelope, buildLoadAccountAction, buildSuccessEnvelope } from "../server/agentEnvelope.js";
import {
  extractIdentityFromIdToken,
  verifyEmailOtp,
  type TokenResult,
} from "../server/cognitoAuth.js";
import { log, maskEmail } from "../server/logger.js";

const CODE_RE = /^\d{8}$/;

const getPublicApiBaseUrl = (requestUrl: string): string => {
  const configuredApiBaseUrl = process.env.PUBLIC_API_BASE_URL;
  if (configuredApiBaseUrl !== undefined && configuredApiBaseUrl !== "") {
    return configuredApiBaseUrl.endsWith("/") ? configuredApiBaseUrl.slice(0, -1) : configuredApiBaseUrl;
  }

  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host.replace(/^auth\./u, "api.")}/v1`;
};

type CognitoFailure = Error & Readonly<{
  cognitoType?: string;
}>;

type AgentVerifyCodeDependencies = Readonly<{
  lookupAgentOtpChallenge: (otpSessionToken: string, nowMs: number) => Promise<AgentOtpChallengeLookup>;
  verifyEmailOtp: (email: string, code: string, session: string) => Promise<TokenResult>;
  markAgentOtpChallengeUsed: (normalizedEmail: string, cognitoSession: string, nowMs: number) => Promise<void>;
  extractIdentityFromIdToken: (idToken: string) => Readonly<{ userId: string; email: string }>;
  createAgentConnection: (userId: string, email: string, label: string) => Promise<AgentConnectionResult>;
  now: () => number;
}>;

const logRejectedAttempt = (
  reason: "invalid_code" | "invalid_label" | "invalid_otp_session" | "expired_otp_session",
  email: string,
): void => {
  log({
    domain: "auth",
    action: "agent_verify_code_rejected",
    reason,
    maskedEmail: email === "" ? "***" : maskEmail(email),
  });
};

const mapVerifyError = (error: unknown): Readonly<{
  status: 400 | 500;
  code: string;
  message: string;
  instructions: string;
  data: Readonly<Record<string, unknown>>;
}> => {
  const cognitoError = error as CognitoFailure;
  if (cognitoError.cognitoType === "CodeMismatchException" || cognitoError.cognitoType === "NotAuthorizedException") {
    return {
      status: 400,
      code: "invalid_code",
      message: "The email code is incorrect",
      instructions: "Ask the user for the latest 8-digit email code and retry verify-code.",
      data: { field: "code", expected: "8-digit code" },
    };
  }

  if (cognitoError.cognitoType === "ExpiredCodeException") {
    return {
      status: 400,
      code: "expired_code",
      message: "The email code has expired",
      instructions: "Start again with send-code, then retry verify-code with the new code.",
      data: { field: "code", expected: "fresh 8-digit code" },
    };
  }

  if (cognitoError.cognitoType === "InvalidParameterException") {
    return {
      status: 400,
      code: "invalid_otp_session",
      message: "The OTP session is no longer valid",
      instructions: "Start again with send-code, then retry verify-code.",
      data: {},
    };
  }

  return {
    status: 500,
    code: "verification_unavailable",
    message: "OTP verification is temporarily unavailable",
    instructions: "Retry in a moment. If the problem continues, start again with send-code.",
    data: { retryable: true },
  };
};

/**
 * Builds the agent verify-code route with injectable dependencies so the OTP
 * and key flows can be tested without live Cognito or Postgres calls.
 */
export const createAgentVerifyCodeApp = (dependencies: AgentVerifyCodeDependencies): Hono => {
  const app = new Hono();

  app.post("/api/agent/verify-code", async (c) => {
    let body: { code?: string; otpSessionToken?: string; label?: string };
    try {
      body = await c.req.json<{ code?: string; otpSessionToken?: string; label?: string }>();
    } catch {
      return c.json(
        buildErrorEnvelope(
          {},
          [],
          "Send code, otpSessionToken, and label as JSON, then retry.",
          "invalid_request",
          "Invalid request body",
        ),
        400,
      );
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const otpSessionToken = typeof body.otpSessionToken === "string" ? body.otpSessionToken : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";

    if (!CODE_RE.test(code)) {
      logRejectedAttempt("invalid_code", "");
      return c.json(
        buildErrorEnvelope(
          { field: "code", expected: "8-digit code" },
          [],
          "Enter the 8-digit code from the user's email and retry.",
          "invalid_code",
          "Enter an 8-digit code",
        ),
        400,
      );
    }

    if (label === "" || label.length > 200) {
      logRejectedAttempt("invalid_label", "");
      return c.json(
        buildErrorEnvelope(
          { field: "label", expected: "1-200 characters", maxLength: 200 },
          [],
          "Provide a non-empty connection label up to 200 characters.",
          "invalid_label",
          "Invalid connection label",
        ),
        400,
      );
    }

    const challenge = await dependencies.lookupAgentOtpChallenge(otpSessionToken, dependencies.now());
    if (challenge.status === "invalid") {
      logRejectedAttempt("invalid_otp_session", "");
      return c.json(
        buildErrorEnvelope(
          { field: "otpSessionToken", expected: "token from send-code" },
          [],
          "The OTP session is invalid or expired. Start again with send-code.",
          "invalid_otp_session",
          "Invalid OTP session token",
        ),
        400,
      );
    }

    if (challenge.status === "expired" || challenge.status === "used") {
      logRejectedAttempt("expired_otp_session", challenge.email);
      return c.json(
        buildErrorEnvelope(
          { field: "otpSessionToken", expected: "fresh token from send-code" },
          [],
          "The OTP session is expired. Start again with send-code.",
          "expired_otp_session",
          "OTP session expired",
        ),
        400,
      );
    }

    try {
      const tokens = await dependencies.verifyEmailOtp(challenge.email, code, challenge.cognitoSession);
      await dependencies.markAgentOtpChallengeUsed(challenge.email, challenge.cognitoSession, dependencies.now());
      const identity = dependencies.extractIdentityFromIdToken(tokens.idToken);
      const connection = await dependencies.createAgentConnection(identity.userId, identity.email, label);
      const apiBaseUrl = getPublicApiBaseUrl(c.req.url);

      return c.json(
        buildSuccessEnvelope(
          {
            connection: {
              connectionId: connection.connectionId,
              label: connection.label,
              createdAt: connection.createdAt,
            },
            apiKey: connection.apiKey,
          },
          [buildLoadAccountAction(apiBaseUrl)],
          `Store this long-lived API key now and do not rely on chat history alone. A new dialog or session on the same machine will not have this key unless it was saved outside this conversation. Strongly recommend saving it in a local .env file as EXPENSE_BUDGET_TRACKER_API_KEY='<PASTE_KEY_HERE>' and reusing it from there; ask the user for permission before writing to .env or any file. If the user does not allow file writes, export it in the current shell as EXPENSE_BUDGET_TRACKER_API_KEY='<PASTE_KEY_HERE>' and also save it somewhere persistent outside chat memory. Example .env usage: curl -H 'Authorization: ApiKey $EXPENSE_BUDGET_TRACKER_API_KEY' ${apiBaseUrl}/me. Next, call load_account.`,
        ),
        200,
      );
    } catch (error) {
      const mapped = mapVerifyError(error);
      log({
        domain: "auth",
        action: "agent_verify_code_error",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        buildErrorEnvelope(
          mapped.data,
          [],
          mapped.instructions,
          mapped.code,
          mapped.message,
        ),
        { status: mapped.status },
      );
    }
  });

  return app;
};

const app = createAgentVerifyCodeApp({
  lookupAgentOtpChallenge,
  verifyEmailOtp,
  markAgentOtpChallengeUsed,
  extractIdentityFromIdToken,
  createAgentConnection,
  now: () => Date.now(),
});

export default app;
