import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createProxyJwtAuthenticator,
  type ProxyJwtAuthenticator,
} from "@expense-budget-tracker/agent-shared/proxy-jwt";
import {
  JwkInvalidKtyError,
  JwkInvalidUseError,
  JwtExpiredError,
  JwtParseError,
} from "aws-jwt-verify/error";
import { SimpleJwksCache, type Jwks } from "aws-jwt-verify/jwk";
import { Hono } from "hono";
import type { ProxyIdentityRejectedEvent } from "../logger.js";
import {
  clearBrowserSessionCookies,
  isExpiredBrowserSessionError,
  isInvalidBrowserSessionError,
  readBrowserIdentityClaims,
  resolveBrowserSessionWithDependencies,
  resolveProxyJwtSessionWithDependencies,
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

const requestSession = async (
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

const PROXY_HEADER_NAME = "cf-access-jwt-assertion";
const PROXY_JWKS_URL = "https://proxy.example.com/cdn-cgi/access/certs";
const PROXY_ISSUER = "https://proxy.example.com";
const PROXY_AUDIENCE = "6a1b2c3d4e5f";
const PROXY_KEY_ID = "test-key";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const buildProxyJwtAuthenticator = (): ProxyJwtAuthenticator => {
  const { n, e } = publicKey.export({ format: "jwk" });
  if (typeof n !== "string" || typeof e !== "string") {
    throw new Error("Generated RSA public key exported without n/e JWK parameters");
  }
  const jwks: Jwks = { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: PROXY_KEY_ID, n, e }] };
  const jwksCache = new SimpleJwksCache();
  jwksCache.addJwks(PROXY_JWKS_URL, jwks);
  return createProxyJwtAuthenticator(
    {
      headerName: PROXY_HEADER_NAME,
      jwksUrl: PROXY_JWKS_URL,
      issuer: PROXY_ISSUER,
      audience: PROXY_AUDIENCE,
    },
    jwksCache,
  );
};

const signProxyJwt = (payload: Readonly<Record<string, unknown>>): string => {
  const encodeSegment = (value: Readonly<Record<string, unknown>>): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encodeSegment({ alg: "RS256", kid: PROXY_KEY_ID, typ: "JWT" })}.${encodeSegment(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
};

const validProxyJwtPayload = (): Readonly<Record<string, unknown>> => {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: "edge-user-1",
    email: "edge@example.com",
    iss: PROXY_ISSUER,
    aud: PROXY_AUDIENCE,
    iat: nowInSeconds,
    exp: nowInSeconds + 300,
  };
};

const requestProxyJwtSession = async (
  headers: Readonly<Record<string, string>>,
  rejections: Array<ProxyIdentityRejectedEvent>,
): Promise<Response> => {
  const app = new Hono();
  app.onError((error) => { throw error; });
  app.get("/", async (c) => c.json(await resolveProxyJwtSessionWithDependencies(c, {
    getProxyJwtAuthenticator: buildProxyJwtAuthenticator,
    log: (event) => { rejections.push(event); },
  })));
  return app.request("https://auth.example.com/", { headers });
};

test("a token signed by the proxy key becomes the browser identity", async (): Promise<void> => {
  const rejections: Array<ProxyIdentityRejectedEvent> = [];
  const response = await requestProxyJwtSession(
    { [PROXY_HEADER_NAME]: signProxyJwt(validProxyJwtPayload()) },
    rejections,
  );

  assert.deepEqual(await response.json(), { userId: "edge-user-1", email: "edge@example.com" });
  assert.deepEqual(rejections, []);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("an invalid edge token resolves to no identity and is logged", async (): Promise<void> => {
  const rejections: Array<ProxyIdentityRejectedEvent> = [];
  const foreignToken = signProxyJwt({ ...validProxyJwtPayload(), iss: "https://attacker.example.com" });

  const response = await requestProxyJwtSession({ [PROXY_HEADER_NAME]: foreignToken }, rejections);

  assert.equal(await response.json(), null);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.action, "proxy_identity_rejected");
});

test("an absent edge token resolves to no identity without reading cookies", async (): Promise<void> => {
  const rejections: Array<ProxyIdentityRejectedEvent> = [];
  const response = await requestProxyJwtSession(
    { Cookie: "session=cognito-id-token; refresh=cognito-refresh-token" },
    rejections,
  );

  assert.equal(await response.json(), null);
  assert.equal(rejections.length, 1);
  assert.match(rejections[0]?.error ?? "", new RegExp(PROXY_HEADER_NAME, "u"));
  assert.equal(response.headers.getSetCookie().length, 0);
});
