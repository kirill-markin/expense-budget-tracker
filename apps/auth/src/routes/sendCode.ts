/**
 * Email OTP initiation endpoint. Accepts an email address, calls Cognito
 * InitiateAuth with EMAIL_OTP challenge, and stores the Cognito session
 * in an HMAC-signed cookie after shared app-level anti-abuse checks pass.
 *
 * Auto-creates the Cognito account if the user doesn't exist yet.
 *
 * A random delay (200–800 ms) is added before responding to equalise timing
 * between new and existing users, preventing email-existence enumeration.
 *
 * Security: HMAC-signed cookie + CSRF token + 3-min TTL.
 */
import { randomBytes, randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { getClientIp } from "../server/clientIp.js";
import { initiateEmailOtp } from "../server/cognitoAuth.js";
import { sign } from "../server/crypto.js";
import { log, maskEmail } from "../server/logger.js";
import { checkAndRecordOtpSendDecision, type OtpSendDecision } from "../server/otpRateLimit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 800;
const jitterDelay = (): Promise<void> =>
  new Promise((resolve) => {
    const ms = randomInt(JITTER_MIN_MS, JITTER_MAX_MS);
    setTimeout(resolve, ms);
  });

type SendCodeDependencies = Readonly<{
  delay: () => Promise<void>;
  createCsrfToken: () => string;
  getClientIp: (context: Context) => string;
  initiateEmailOtp: (email: string) => Promise<Readonly<{ session: string }>>;
  checkAndRecordOtpSendDecision: (normalizedEmail: string, requestIp: string) => Promise<OtpSendDecision>;
}>;

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const createCsrfToken = (): string => randomBytes(32).toString("hex");

export const createSendCodeApp = (dependencies: SendCodeDependencies): Hono => {
  const app = new Hono();

  app.post("/api/send-code", async (c) => {
    let body: { email?: string };
    try {
      body = await c.req.json<{ email?: string }>();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";

    if (!EMAIL_RE.test(email) || email.length > 256) {
      return c.json({ error: "Invalid email" }, 400);
    }

    const requestIp = dependencies.getClientIp(c);

    let decision: OtpSendDecision;
    try {
      decision = await dependencies.checkAndRecordOtpSendDecision(email, requestIp);
    } catch (err) {
      log({ domain: "auth", action: "error", error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to send code — please try again" }, 500);
    }

    if (decision !== "allowed") {
      await dependencies.delay();
      log({ domain: "auth", action: "send_code_rate_limited", maskedEmail: maskEmail(email), decision });
      return c.json({ error: "Too many requests — please wait before trying again" }, 429);
    }

    let session: string;
    try {
      const [result] = await Promise.all([dependencies.initiateEmailOtp(email), dependencies.delay()]);
      session = result.session;
    } catch (err) {
      log({ domain: "auth", action: "send_code_error", error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to send code — please try again" }, 500);
    }

    log({ domain: "auth", action: "send_code", maskedEmail: maskEmail(email) });

    const csrfToken = dependencies.createCsrfToken();

    const payload = JSON.stringify({
      s: session,
      e: email,
      csrf: csrfToken,
      t: Date.now(),
    });

    const signed = sign(payload);

    setCookie(c, "otp_session", signed, {
      path: "/",
      maxAge: 180,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    });

    return c.json({ ok: true, csrfToken });
  });

  return app;
};

const app = createSendCodeApp({
  delay: jitterDelay,
  createCsrfToken,
  getClientIp,
  initiateEmailOtp,
  checkAndRecordOtpSendDecision,
});

export default app;
