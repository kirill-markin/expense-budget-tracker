/**
 * Terminal-first agent auth bootstrap.
 *
 * Accepts an email address, applies DB-backed abuse controls, starts the
 * Cognito Email OTP flow when allowed, and always returns the next action
 * envelope instead of browser cookies or redirects.
 */
import { randomInt } from "node:crypto";
import { Hono } from "hono";
import { buildErrorEnvelope, buildSuccessEnvelope, buildVerifyCodeAction } from "../server/agentEnvelope.js";
import { checkAndRecordAgentOtpDecision } from "../server/agentRateLimit.js";
import { getClientIp } from "../server/clientIp.js";
import { initiateEmailOtp } from "../server/cognitoAuth.js";
import { sign } from "../server/crypto.js";
import { log, maskEmail } from "../server/logger.js";

const app = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 800;

const delay = (): Promise<void> =>
  new Promise((resolve) => {
    const ms = randomInt(JITTER_MIN_MS, JITTER_MAX_MS);
    setTimeout(resolve, ms);
  });

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

app.post("/api/agent/send-code", async (c) => {
  let body: { email?: string };
  try {
    body = await c.req.json<{ email?: string }>();
  } catch {
    return c.json(
      buildErrorEnvelope(
        {},
        [],
        "Send a JSON body with a valid email address and retry.",
        "invalid_request",
        "Invalid request body",
      ),
      400,
    );
  }

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!EMAIL_RE.test(email) || email.length > 256) {
    return c.json(
      buildErrorEnvelope(
        { field: "email", expected: "valid email address" },
        [],
        "Provide a valid email address and retry.",
        "invalid_email",
        "Invalid email",
      ),
      400,
    );
  }

  const requestIp = getClientIp(c);

  let decision: Awaited<ReturnType<typeof checkAndRecordAgentOtpDecision>>;
  try {
    decision = await checkAndRecordAgentOtpDecision(email, requestIp);
  } catch (error) {
    log({ domain: "auth", action: "error", error: error instanceof Error ? error.message : String(error) });
    return c.json(
      buildErrorEnvelope(
        { retryable: true },
        [],
        "Agent auth is temporarily unavailable. Retry in a moment.",
        "agent_send_unavailable",
        "Failed to evaluate send limits",
      ),
      500,
    );
  }

  if (decision === "blocked_ip_limit") {
    return c.json(
      buildErrorEnvelope(
        {},
        [],
        "Too many requests from this network. Wait before trying again.",
        "rate_limited",
        "Too many OTP requests from this IP",
      ),
      429,
    );
  }

  let session = "";
  try {
    if (decision === "allowed") {
      const [result] = await Promise.all([initiateEmailOtp(email), delay()]);
      session = result.session;
    } else {
      await delay();
    }
  } catch (error) {
    log({ domain: "auth", action: "send_code_error", error: error instanceof Error ? error.message : String(error) });
    return c.json(
      buildErrorEnvelope(
        { retryable: true },
        [],
        "The auth backend is temporarily unavailable. Retry in a moment.",
        "auth_backend_unavailable",
        "Failed to send code",
      ),
      500,
    );
  }

  log({ domain: "auth", action: "agent_send_code", maskedEmail: maskEmail(email), decision });

  const otpSessionToken = sign(JSON.stringify({
    s: session,
    e: email,
    t: Date.now(),
  }));

  return c.json(
    buildSuccessEnvelope(
      { otpSessionToken },
      [buildVerifyCodeAction()],
      "Ask the user for the 8-digit code from email, then call verify_code.",
    ),
    200,
  );
});

export default app;
