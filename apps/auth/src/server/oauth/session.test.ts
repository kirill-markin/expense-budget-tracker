import assert from "node:assert/strict";
import test from "node:test";
import {
  JwkInvalidKtyError,
  JwkInvalidUseError,
  JwtExpiredError,
  JwtParseError,
} from "aws-jwt-verify/error";
import { Hono } from "hono";
import {
  clearBrowserSessionCookies,
  isExpiredBrowserSessionError,
  isInvalidBrowserSessionError,
  readBrowserIdentityClaims,
  resolveBrowserSessionWithDependencies,
  type BrowserIdentity,
  type BrowserSessionDependencies,
} from "./session.js";

const identity: BrowserIdentity = { userId: "user-1", email: "user@example.com" };

const createDependencies = (
  overrides: Partial<BrowserSessionDependencies>,
): BrowserSessionDependencies => ({
  verifyBrowserSession: async () => identity,
  refreshCognitoSession: async () => ({ idToken: "fresh-id-token", refreshToken: undefined }),
  isDefinitiveCognitoRefreshRejection: () => false,
  isExpiredBrowserSessionError,
  isInvalidBrowserSessionError,
  clearBrowserSessionCookies,
  ...overrides,
});

const requestSession = (
  cookie: string,
  dependencies: BrowserSessionDependencies,
): Promise<Response> => {
  const app = new Hono();
  app.onError((error) => { throw error; });
  app.get("/", async (c) => c.json(await resolveBrowserSessionWithDependencies(c, dependencies)));
  return app.request("https://auth.example.com/", { headers: { Cookie: cookie } });
};

test("Cognito expiry is distinct from malformed browser sessions", (): void => {
  const expired = new JwtExpiredError("expired", 0);
  assert.equal(isExpiredBrowserSessionError(expired), true);
  assert.equal(isInvalidBrowserSessionError(expired), false);
  assert.equal(isExpiredBrowserSessionError(new JwtParseError("malformed")), false);
  assert.equal(isInvalidBrowserSessionError(new JwtParseError("malformed")), true);
  assert.equal(isInvalidBrowserSessionError(new JwkInvalidUseError("invalid JWK use", "enc", "sig")), false);
  assert.equal(isInvalidBrowserSessionError(new JwkInvalidKtyError("invalid JWK type", "EC", "RSA")), false);
  assert.equal(isInvalidBrowserSessionError(new Error("JWKS unavailable")), false);
});

test("an initial-token JWK verifier failure propagates without clearing cookies", async (): Promise<void> => {
  const jwkError = new JwkInvalidUseError("invalid JWK use", "enc", "sig");
  let cookiesCleared = false;
  await assert.rejects(
    requestSession(
      "session=existing-id-token; refresh=existing-refresh-token",
      createDependencies({
        verifyBrowserSession: async () => { throw jwkError; },
        clearBrowserSessionCookies: () => { cookiesCleared = true; },
      }),
    ),
    (error: unknown) => error === jwkError,
  );
  assert.equal(cookiesCleared, false);
});

test("an expired ID token refreshes and continues the browser session", async (): Promise<void> => {
  const expired = new Error("expired");
  const response = await requestSession(
    "session=expired-id-token; refresh=existing-refresh-token",
    createDependencies({
      verifyBrowserSession: async (token) => {
        if (token === "expired-id-token") throw expired;
        assert.equal(token, "fresh-id-token");
        return identity;
      },
      refreshCognitoSession: async (token) => {
        assert.equal(token, "existing-refresh-token");
        return { idToken: "fresh-id-token", refreshToken: "rotated-refresh-token" };
      },
      isExpiredBrowserSessionError: (error) => error === expired,
    }),
  );

  assert.deepEqual(await response.json(), identity);
  const cookies = response.headers.getSetCookie().join("\n");
  assert.match(cookies, /session=fresh-id-token/u);
  assert.match(cookies, /refresh=rotated-refresh-token/u);
  assert.match(cookies, /logged_in=1/u);
});

test("an expired ID token without a refresh cookie clears the cookie family", async (): Promise<void> => {
  const expired = new Error("expired");
  let refreshCalled = false;
  const response = await requestSession("session=expired-id-token", createDependencies({
    verifyBrowserSession: async () => { throw expired; },
    refreshCognitoSession: async () => {
      refreshCalled = true;
      return { idToken: "unused", refreshToken: undefined };
    },
    isExpiredBrowserSessionError: (error) => error === expired,
  }));

  assert.equal(await response.json(), null);
  assert.equal(refreshCalled, false);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;[\s\S]*refresh=;[\s\S]*logged_in=;/u);
});

test("a definitive Cognito refresh rejection clears the cookie family", async (): Promise<void> => {
  const expired = new Error("expired");
  const rejected = new Error("refresh rejected");
  const response = await requestSession(
    "session=expired-id-token; refresh=invalid-refresh-token",
    createDependencies({
      verifyBrowserSession: async () => { throw expired; },
      refreshCognitoSession: async () => { throw rejected; },
      isDefinitiveCognitoRefreshRejection: (error) => error === rejected,
      isExpiredBrowserSessionError: (error) => error === expired,
    }),
  );

  assert.equal(await response.json(), null);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;[\s\S]*refresh=;[\s\S]*logged_in=;/u);
});

test("a transient Cognito refresh failure propagates without clearing cookies", async (): Promise<void> => {
  const expired = new Error("expired");
  const unavailable = new Error("Cognito refresh unavailable after retries");
  let cookiesCleared = false;
  await assert.rejects(
    requestSession(
      "session=expired-id-token; refresh=existing-refresh-token",
      createDependencies({
        verifyBrowserSession: async () => { throw expired; },
        refreshCognitoSession: async () => { throw unavailable; },
        isExpiredBrowserSessionError: (error) => error === expired,
        clearBrowserSessionCookies: () => { cookiesCleared = true; },
      }),
    ),
    (error: unknown) => error === unavailable,
  );
  assert.equal(cookiesCleared, false);
});

test("a refreshed ID token that fails verification clears the cookie family", async (): Promise<void> => {
  const expired = new Error("expired");
  const invalid = new Error("refreshed token rejected");
  const response = await requestSession(
    "session=expired-id-token; refresh=existing-refresh-token",
    createDependencies({
      verifyBrowserSession: async (token) => {
        if (token === "expired-id-token") throw expired;
        throw invalid;
      },
      isExpiredBrowserSessionError: (error) => error === expired,
      isInvalidBrowserSessionError: (error) => error === invalid,
    }),
  );

  assert.equal(await response.json(), null);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;[\s\S]*refresh=;[\s\S]*logged_in=;/u);
});

test("a refreshed-token JWK verifier failure propagates without clearing cookies", async (): Promise<void> => {
  const expired = new Error("expired");
  const jwkError = new JwkInvalidKtyError("invalid JWK type", "EC", "RSA");
  let cookiesCleared = false;
  await assert.rejects(
    requestSession(
      "session=expired-id-token; refresh=existing-refresh-token",
      createDependencies({
        verifyBrowserSession: async (token) => {
          if (token === "expired-id-token") throw expired;
          throw jwkError;
        },
        isExpiredBrowserSessionError: (error) => error === expired,
        clearBrowserSessionCookies: () => { cookiesCleared = true; },
      }),
    ),
    (error: unknown) => error === jwkError,
  );
  assert.equal(cookiesCleared, false);
});

test("an empty initial subject claim clears the browser cookie family", async (): Promise<void> => {
  const response = await requestSession(
    "session=empty-subject-id-token; refresh=existing-refresh-token",
    createDependencies({
      verifyBrowserSession: async () => readBrowserIdentityClaims({
        sub: "",
        email: "user@example.com",
        email_verified: true,
      }),
    }),
  );

  assert.equal(await response.json(), null);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;[\s\S]*refresh=;[\s\S]*logged_in=;/u);
});

test("an empty refreshed subject claim clears the browser cookie family", async (): Promise<void> => {
  const expired = new Error("expired");
  const response = await requestSession(
    "session=expired-id-token; refresh=existing-refresh-token",
    createDependencies({
      verifyBrowserSession: async (token) => {
        if (token === "expired-id-token") throw expired;
        return readBrowserIdentityClaims({
          sub: "",
          email: "user@example.com",
          email_verified: true,
        });
      },
      isExpiredBrowserSessionError: (error) => error === expired,
    }),
  );

  assert.equal(await response.json(), null);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;[\s\S]*refresh=;[\s\S]*logged_in=;/u);
});

test("a malformed non-expired ID token clears cookies without attempting refresh", async (): Promise<void> => {
  const invalid = new Error("invalid");
  let refreshCalled = false;
  const response = await requestSession(
    "session=malformed-id-token; refresh=existing-refresh-token",
    createDependencies({
      verifyBrowserSession: async () => { throw invalid; },
      refreshCognitoSession: async () => {
        refreshCalled = true;
        return { idToken: "unused", refreshToken: undefined };
      },
      isInvalidBrowserSessionError: (error) => error === invalid,
    }),
  );

  assert.equal(await response.json(), null);
  assert.equal(refreshCalled, false);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;[\s\S]*refresh=;[\s\S]*logged_in=;/u);
});
