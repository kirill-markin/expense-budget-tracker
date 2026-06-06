/**
 * Email OTP initiation endpoint. Accepts an email address, calls Cognito
 * InitiateAuth with EMAIL_OTP challenge, and stores a short-lived opaque
 * browser challenge handle in a cookie after shared app-level anti-abuse
 * checks pass.
 *
 * Auto-creates the Cognito account if the user doesn't exist yet.
 *
 * A random delay (200–800 ms) is added before responding to equalise timing
 * between new and existing users, preventing email-existence enumeration.
 *
 * Security: opaque challenge cookie + CSRF token + 3-min TTL.
 */
import { randomBytes, randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { createBrowserOtpChallenge } from "../server/otp/otpChallengeStore.js";
import { getClientIp } from "../server/clientIp.js";
import { initiateEmailOtp, signInWithPassword, type TokenResult } from "../server/cognitoAuth.js";
import { getDemoEmailPassword } from "../server/demoEmailAccess.js";
import { log, maskEmail } from "../server/logger.js";
import { checkAndRecordOtpSendDecision, type OtpSendDecision } from "../server/otp/otpRateLimit.js";

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
  signInWithPassword: (email: string, password: string) => Promise<TokenResult>;
  getDemoEmailPassword: (email: string) => string | null;
  checkAndRecordOtpSendDecision: (normalizedEmail: string, requestIp: string) => Promise<OtpSendDecision>;
  createBrowserOtpChallenge: (
    normalizedEmail: string,
    cognitoSession: string,
    csrfToken: string,
    nowMs: number,
  ) => Promise<string>;
  now: () => number;
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

    const demoPassword = dependencies.getDemoEmailPassword(email);
    if (demoPassword !== null) {
      try {
        const tokens = await dependencies.signInWithPassword(email, demoPassword);
        const cookieDomain = process.env.COOKIE_DOMAIN ?? "";
        const domainOpt = cookieDomain === "" ? undefined : cookieDomain;
        const cookieOpts = { path: "/", maxAge: 3024000, httpOnly: true, secure: true, sameSite: "Lax" as const, domain: domainOpt };

        setCookie(c, "session", tokens.idToken, cookieOpts);
        setCookie(c, "refresh", tokens.refreshToken, cookieOpts);
        setCookie(c, "logged_in", "1", { ...cookieOpts, httpOnly: false });

        log({ domain: "auth", action: "send_code_demo_sign_in", maskedEmail: maskEmail(email) });
        return c.json({ ok: true, idToken: tokens.idToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn });
      } catch (err) {
        log({ domain: "auth", action: "send_code_demo_sign_in_error", error: err instanceof Error ? err.message : String(err) });
        return c.json({ error: "Demo sign-in failed" }, 500);
      }
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

    const csrfToken = dependencies.createCsrfToken();

    let otpSessionToken: string;
    try {
      const [result] = await Promise.all([dependencies.initiateEmailOtp(email), dependencies.delay()]);
      otpSessionToken = await dependencies.createBrowserOtpChallenge(
        email,
        result.session,
        csrfToken,
        dependencies.now(),
      );
    } catch (err) {
      log({ domain: "auth", action: "send_code_error", error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to send code — please try again" }, 500);
    }

    log({ domain: "auth", action: "send_code", maskedEmail: maskEmail(email) });

    setCookie(c, "otp_session", otpSessionToken, {
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
  signInWithPassword,
  getDemoEmailPassword,
  checkAndRecordOtpSendDecision,
  createBrowserOtpChallenge,
  now: () => Date.now(),
});

export default app;
