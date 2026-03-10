/**
 * Agent OTP verification.
 *
 * Exchanges a valid Email OTP challenge for a long-lived agent API key instead
 * of browser session cookies. The returned key is shown once and must be
 * stored by the terminal client.
 */
import { Hono } from "hono";
import { createAgentConnection } from "../server/agentApiKeys.js";
import { buildErrorEnvelope, buildLoadAccountAction, buildSuccessEnvelope } from "../server/agentEnvelope.js";
import { extractIdentityFromIdToken, verifyEmailOtp } from "../server/cognitoAuth.js";
import { verify } from "../server/crypto.js";
import { log, maskEmail } from "../server/logger.js";

const app = new Hono();

const CODE_RE = /^\d{8}$/;
const OTP_TTL_MS = 180_000;

type AgentOtpPayload = Readonly<{
  s: string;
  e: string;
  t: number;
}>;

type CognitoFailure = Error & Readonly<{
  cognitoType?: string;
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

  let payload: AgentOtpPayload;
  try {
    payload = JSON.parse(verify(otpSessionToken)) as AgentOtpPayload;
  } catch {
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

  if (Date.now() - payload.t > OTP_TTL_MS || payload.s === "") {
    logRejectedAttempt("expired_otp_session", payload.e);
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
    const tokens = await verifyEmailOtp(payload.e, code, payload.s);
    const identity = extractIdentityFromIdToken(tokens.idToken);
    const connection = await createAgentConnection(identity.userId, identity.email, label);

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
        [buildLoadAccountAction()],
        "Store the API key securely. It will not be shown again. Use Authorization: ApiKey <key>.",
      ),
      200,
    );
  } catch (error) {
    const mapped = mapVerifyError(error);
    log({ domain: "auth", action: "agent_verify_code_error", error: error instanceof Error ? error.message : String(error) });
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

export default app;
