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
import { log } from "../server/logger.js";

const app = new Hono();

const CODE_RE = /^\d{8}$/;
const OTP_TTL_MS = 180_000;

type AgentOtpPayload = Readonly<{
  s: string;
  e: string;
  t: number;
}>;

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
    return c.json(
      buildErrorEnvelope(
        {},
        [],
        "Enter the 8-digit code from the user's email and retry.",
        "invalid_code",
        "Enter an 8-digit code",
      ),
      400,
    );
  }

  if (label === "" || label.length > 200) {
    return c.json(
      buildErrorEnvelope(
        {},
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
    return c.json(
      buildErrorEnvelope(
        {},
        [],
        "The OTP session is invalid or expired. Start again with send-code.",
        "invalid_otp_session",
        "Invalid OTP session token",
      ),
      400,
    );
  }

  if (Date.now() - payload.t > OTP_TTL_MS || payload.s === "") {
    return c.json(
      buildErrorEnvelope(
        {},
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
    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "auth", action: "agent_verify_code_error", error: message });
    return c.json(
      buildErrorEnvelope(
        {},
        [],
        "Verification failed. Check the code and retry, or start again with send-code.",
        "verification_failed",
        "Verification failed",
      ),
      400,
    );
  }
});

export default app;
