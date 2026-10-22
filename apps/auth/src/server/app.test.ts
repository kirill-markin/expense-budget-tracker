import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createLoginPageApp } from "../routes/loginPage.js";
import { createSendCodeApp } from "../routes/sendCode.js";
import { createAuthApp, getAuthRoutes } from "./app.js";
import type { TokenResult } from "./cognitoAuth.js";
import { getDemoEmailPassword, resetDemoEmailAccessConfigForTests } from "./demoEmailAccess.js";
import type { AuthUnhandledErrorEvent } from "./logger.js";

test("root failures are structured and generic without logging request credentials", async (): Promise<void> => {
  const authorizationCode = "ebt_ac_must-not-log";
  const sessionCookie = "session=session-must-not-log";
  const routes = new Hono();
  routes.get("/.well-known/oauth-authorization-server", () => {
    throw new Error(`Metadata failed near ${authorizationCode}`);
  });
  routes.get("/oauth/authorize", () => {
    throw new RangeError(`Client lookup failed near ${authorizationCode}`);
  });
  const loginPage = createLoginPageApp({
    resolveBrowserSession: async () => {
      throw new TypeError(`Session failed near ${sessionCookie}`);
    },
  });
  const events: AuthUnhandledErrorEvent[] = [];
  const app = createAuthApp({
    routes: [routes, loginPage],
    log: (event) => { events.push(event); },
  });

  const previousRedirects = process.env.ALLOWED_REDIRECT_URIS;
  process.env.ALLOWED_REDIRECT_URIS = "https://app.example.com";
  try {
    const metadata = await app.request(
      `https://auth.example.com/.well-known/oauth-authorization-server?code=${authorizationCode}`,
      { headers: { Cookie: sessionCookie } },
    );
    const login = await app.request(
      `https://auth.example.com/login?redirect_uri=${encodeURIComponent(`https://app.example.com/?code=${authorizationCode}`)}`,
      { headers: { Cookie: sessionCookie } },
    );
    const unvalidatedAuthorization = await app.request(
      `https://auth.example.com/oauth/authorize?redirect_uri=${encodeURIComponent("https://attacker.example/callback")}&state=state-1&code=${authorizationCode}`,
      { headers: { Cookie: sessionCookie } },
    );

    for (const response of [metadata, login, unvalidatedAuthorization]) {
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("pragma"), "no-cache");
      assert.deepEqual(await response.json(), { error: "Internal server error" });
    }
    assert.equal(unvalidatedAuthorization.headers.get("location"), null);
  } finally {
    if (previousRedirects === undefined) delete process.env.ALLOWED_REDIRECT_URIS;
    else process.env.ALLOWED_REDIRECT_URIS = previousRedirects;
  }
  assert.deepEqual(events, [
    { domain: "auth", action: "unhandled_error", surface: "oauth", method: "GET", errorType: "error" },
    { domain: "auth", action: "unhandled_error", surface: "login", method: "GET", errorType: "type_error" },
    { domain: "auth", action: "unhandled_error", surface: "oauth", method: "GET", errorType: "range_error" },
  ]);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(authorizationCode), false);
  assert.equal(serializedEvents.includes(sessionCookie), false);
});

const EMAIL_LOGIN_PATHS = [
  "/login",
  "/api/send-code",
  "/api/verify-code",
  "/api/agent/send-code",
  "/api/agent/verify-code",
] as const;

const ALWAYS_REGISTERED_PATHS = [
  "/health",
  "/robots.txt",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/register",
  "/.well-known/oauth-authorization-server",
] as const;

const registeredPaths = (authMode: "cognito" | "proxy_jwt"): ReadonlySet<string> =>
  new Set(createAuthApp({ routes: getAuthRoutes(authMode), log: () => {} })
    .routes
    .map((route) => route.path));

test("cognito mode registers the email login routes and proxy_jwt mode omits them", async (): Promise<void> => {
  const cognitoPaths = registeredPaths("cognito");
  const proxyJwtPaths = registeredPaths("proxy_jwt");

  for (const path of ALWAYS_REGISTERED_PATHS) {
    assert.equal(cognitoPaths.has(path), true, `${path} must stay registered in cognito mode`);
    assert.equal(proxyJwtPaths.has(path), true, `${path} must stay registered in proxy_jwt mode`);
  }
  for (const path of EMAIL_LOGIN_PATHS) {
    assert.equal(cognitoPaths.has(path), true, `${path} must stay registered in cognito mode`);
    assert.equal(proxyJwtPaths.has(path), false, `${path} must not be registered in proxy_jwt mode`);
  }

  const app = createAuthApp({ routes: getAuthRoutes("proxy_jwt"), log: () => {} });
  assert.equal((await app.request("https://auth.example.com/login")).status, 404);
  assert.equal(
    (await app.request("https://auth.example.com/api/send-code", { method: "POST" })).status,
    404,
  );
});

const DEMO_REVIEW_EMAIL = "e2e-test@example.com";
const DEMO_REVIEW_PASSWORD = "demo-shared-password";

const postBrowserSendCode = async (app: Hono, email: string): Promise<Response> =>
  await app.request("https://auth.example.com/api/send-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

test("the browser send-code route refuses a reserved email domain", async (): Promise<void> => {
  // A reserved domain cannot receive mail, so Cognito's email sender fails on it and its
  // asynchronous retries turn one caller mistake into a paging Lambda error alarm. The
  // browser answer stays the generic one shown for any unusable address.
  const previousEmail = process.env.DEMO_EMAIL_DOSTIP;
  const previousPassword = process.env.DEMO_PASSWORD_DOSTIP;
  process.env.DEMO_EMAIL_DOSTIP = DEMO_REVIEW_EMAIL;
  process.env.DEMO_PASSWORD_DOSTIP = DEMO_REVIEW_PASSWORD;
  resetDemoEmailAccessConfigForTests();
  try {
    const app = createSendCodeApp({
      delay: async (): Promise<void> => undefined,
      createCsrfToken: (): string => "csrf-token",
      getClientIp: (): string => {
        throw new Error("A reserved email domain must be refused before the send limiter");
      },
      initiateEmailOtp: async (): Promise<never> => {
        throw new Error("A reserved email domain must not start a Cognito OTP flow");
      },
      signInWithPassword: async (): Promise<TokenResult> => ({
        idToken: "id-token",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      }),
      getDemoEmailPassword,
      checkAndRecordOtpSendDecision: async (): Promise<never> => {
        throw new Error("A reserved email domain must not be metered");
      },
      createBrowserOtpChallenge: async (): Promise<never> => {
        throw new Error("A reserved email domain must not store a challenge");
      },
      now: (): number => 1_700_000_000_000,
    });

    const refused = await postBrowserSendCode(app, "demo@example.com");
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "Invalid email" });

    // The guard sits behind the review-email branch, so the allowlisted address on the
    // same reserved domain still signs in.
    const review = await postBrowserSendCode(app, DEMO_REVIEW_EMAIL);
    assert.equal(review.status, 200);
  } finally {
    if (previousEmail === undefined) delete process.env.DEMO_EMAIL_DOSTIP;
    else process.env.DEMO_EMAIL_DOSTIP = previousEmail;
    if (previousPassword === undefined) delete process.env.DEMO_PASSWORD_DOSTIP;
    else process.env.DEMO_PASSWORD_DOSTIP = previousPassword;
    resetDemoEmailAccessConfigForTests();
  }
});
