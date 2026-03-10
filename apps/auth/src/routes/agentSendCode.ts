/**
 * Terminal-first agent auth bootstrap.
 *
 * Accepts an email address, applies DB-backed abuse controls, starts the
 * Cognito Email OTP flow when allowed, and always returns the next action
 * envelope instead of browser cookies or redirects.
 */
import { randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import { createAgentOtpChallenge, reissueLatestAgentOtpChallenge } from "../server/agentOtpChallenges.js";
import { buildErrorEnvelope, buildSuccessEnvelope, buildVerifyCodeAction } from "../server/agentEnvelope.js";
import { getClientIp } from "../server/clientIp.js";
import { initiateEmailOtp } from "../server/cognitoAuth.js";
import { log, maskEmail } from "../server/logger.js";
import { checkAndRecordOtpSendDecision, type OtpSendDecision } from "../server/otpRateLimit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 800;

const delay = (): Promise<void> =>
  new Promise((resolve) => {
    const ms = randomInt(JITTER_MIN_MS, JITTER_MAX_MS);
    setTimeout(resolve, ms);
  });

type AgentSendCodeDependencies = Readonly<{
  delay: () => Promise<void>;
  getClientIp: (context: Context) => string;
  initiateEmailOtp: (email: string) => Promise<Readonly<{ session: string }>>;
  checkAndRecordOtpSendDecision: (normalizedEmail: string, requestIp: string) => Promise<OtpSendDecision>;
  createAgentOtpChallenge: (normalizedEmail: string, cognitoSession: string, nowMs: number) => Promise<string>;
  reissueLatestAgentOtpChallenge: (normalizedEmail: string, nowMs: number) => Promise<string | null>;
  now: () => number;
}>;

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export const createAgentSendCodeApp = (dependencies: AgentSendCodeDependencies): Hono => {
  const app = new Hono();

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

    const requestIp = dependencies.getClientIp(c);

    let decision: OtpSendDecision;
    try {
      decision = await dependencies.checkAndRecordOtpSendDecision(email, requestIp);
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

    let otpSessionToken = "";
    try {
      if (decision === "allowed") {
        const [result] = await Promise.all([dependencies.initiateEmailOtp(email), dependencies.delay()]);
        otpSessionToken = await dependencies.createAgentOtpChallenge(email, result.session, dependencies.now());
      } else if (decision === "blocked_email_limit") {
        await dependencies.delay();
        const reissuedChallenge = await dependencies.reissueLatestAgentOtpChallenge(email, dependencies.now());
        if (reissuedChallenge === null) {
          return c.json(
            buildErrorEnvelope(
              {},
              [],
              "Too many recent codes for this email. Wait before trying again.",
              "rate_limited",
              "Too many OTP requests for this email",
            ),
            429,
          );
        }
        otpSessionToken = reissuedChallenge;
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

    return c.json(
      buildSuccessEnvelope(
        { otpSessionToken },
        [buildVerifyCodeAction()],
        "Ask the user for the 8-digit code from email, then call verify_code.",
      ),
      200,
    );
  });

  return app;
};

const app = createAgentSendCodeApp({
  delay,
  getClientIp,
  initiateEmailOtp,
  checkAndRecordOtpSendDecision,
  createAgentOtpChallenge,
  reissueLatestAgentOtpChallenge,
  now: () => Date.now(),
});

export default app;
