/**
 * Email OTP verification endpoint. Reads the opaque OTP session handle from a
 * cookie, resolves the server-side browser challenge, validates the 8-digit
 * code via Cognito RespondToAuthChallenge, and on success sets session (35d) +
 * refresh (35d) + logged_in (35d) cookies with Domain=COOKIE_DOMAIN so they
 * are visible on app.* and the marketing site.
 *
 * Returns { ok: true } on success — client JS redirects to redirect_uri.
 *
 * CSRF token is compared with crypto.timingSafeEqual to prevent timing attacks.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  lookupBrowserOtpChallenge,
  markBrowserOtpChallengeUsed,
  recordBrowserOtpChallengeFailure,
  type BrowserOtpChallengeLookup,
} from "../server/otp/otpChallengeStore.js";
import { verifyEmailOtp } from "../server/cognitoAuth.js";
import { log, maskEmail } from "../server/logger.js";

const CODE_RE = /^\d{8}$/;

type CognitoFailure = Error & Readonly<{
  cognitoType?: string;
}>;

type VerifyCodeDependencies = Readonly<{
  lookupBrowserOtpChallenge: (otpSessionToken: string, nowMs: number) => Promise<BrowserOtpChallengeLookup>;
  verifyEmailOtp: (email: string, code: string, session: string) => Promise<Awaited<ReturnType<typeof verifyEmailOtp>>>;
  recordBrowserOtpChallengeFailure: (
    normalizedEmail: string,
    cognitoSession: string,
    nowMs: number,
  ) => Promise<Readonly<{ expired: boolean }>>;
  markBrowserOtpChallengeUsed: (normalizedEmail: string, cognitoSession: string, nowMs: number) => Promise<void>;
  now: () => number;
}>;

const getCookieDomain = (): string | undefined => {
  const domain = process.env.COOKIE_DOMAIN ?? "";
  return domain === "" ? undefined : domain;
};

const clearOtpSessionCookie = (c: Context): void => {
  deleteCookie(c, "otp_session", { path: "/", secure: true });
};

const isInvalidOtpCodeError = (error: unknown): boolean => {
  const cognitoError = error as CognitoFailure;
  return cognitoError.cognitoType === "CodeMismatchException"
    || cognitoError.cognitoType === "NotAuthorizedException";
};

const isExpiredOtpCodeError = (error: unknown): boolean => {
  const cognitoError = error as CognitoFailure;
  return cognitoError.cognitoType === "ExpiredCodeException"
    || cognitoError.cognitoType === "InvalidParameterException";
};

export const createVerifyCodeApp = (dependencies: VerifyCodeDependencies): Hono => {
  const app = new Hono();

  app.post("/api/verify-code", async (c) => {
    const otpSessionToken = getCookie(c, "otp_session") ?? "";
    if (otpSessionToken === "") {
      clearOtpSessionCookie(c);
      return c.json({ error: "Session expired — request a new code" }, 400);
    }

    const challenge = await dependencies.lookupBrowserOtpChallenge(otpSessionToken, dependencies.now());
    if (challenge.status !== "active") {
      clearOtpSessionCookie(c);
      return c.json({ error: "Session expired — request a new code" }, 400);
    }

    let body: { code?: string; csrfToken?: string };
    try {
      body = await c.req.json<{ code?: string; csrfToken?: string }>();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const csrfToken = typeof body.csrfToken === "string" ? body.csrfToken : "";
    const csrfMatch =
      csrfToken.length === challenge.csrfToken.length
      && timingSafeEqual(Buffer.from(csrfToken), Buffer.from(challenge.csrfToken));
    if (!csrfMatch) {
      return c.json({ error: "Session expired — request a new code" }, 400);
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!CODE_RE.test(code)) {
      return c.json({ error: "Enter an 8-digit code" }, 400);
    }

    let tokens: Awaited<ReturnType<typeof verifyEmailOtp>>;
    try {
      tokens = await dependencies.verifyEmailOtp(challenge.email, code, challenge.cognitoSession);
    } catch (error) {
      if (isInvalidOtpCodeError(error)) {
        const failure = await dependencies.recordBrowserOtpChallengeFailure(
          challenge.email,
          challenge.cognitoSession,
          dependencies.now(),
        );
        if (failure.expired) {
          log({
            domain: "auth",
            action: "verify_code_challenge_expired",
            transport: "browser",
            maskedEmail: maskEmail(challenge.email),
          });
          clearOtpSessionCookie(c);
          return c.json({ error: "Session expired — request a new code" }, 400);
        }
        log({ domain: "auth", action: "verify_code_error", error: error instanceof Error ? error.message : String(error) });
        return c.json({ error: "Verification failed — please try again" }, 400);
      }

      if (isExpiredOtpCodeError(error)) {
        clearOtpSessionCookie(c);
        return c.json({ error: "Session expired — request a new code" }, 400);
      }

      log({ domain: "auth", action: "verify_code_error", error: error instanceof Error ? error.message : String(error) });
      return c.json({ error: "Verification failed — please try again" }, 400);
    }

    await dependencies.markBrowserOtpChallengeUsed(
      challenge.email,
      challenge.cognitoSession,
      dependencies.now(),
    );

    const cookieDomain = getCookieDomain();

    setCookie(c, "session", tokens.idToken, {
      path: "/",
      maxAge: 3024000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      domain: cookieDomain,
    });

    setCookie(c, "refresh", tokens.refreshToken, {
      path: "/",
      maxAge: 3024000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      domain: cookieDomain,
    });

    setCookie(c, "logged_in", "1", {
      path: "/",
      maxAge: 3024000,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      domain: cookieDomain,
    });

    clearOtpSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
};

const app = createVerifyCodeApp({
  lookupBrowserOtpChallenge,
  verifyEmailOtp,
  recordBrowserOtpChallengeFailure,
  markBrowserOtpChallengeUsed,
  now: () => Date.now(),
});

export default app;
