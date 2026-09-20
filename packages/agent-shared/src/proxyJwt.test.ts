import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  JwtExpiredError,
  JwtInvalidAudienceError,
  JwtInvalidIssuerError,
  JwtInvalidSignatureAlgorithmError,
} from "aws-jwt-verify/error";
import { SimpleJwksCache, type Jwks } from "aws-jwt-verify/jwk";

import {
  createProxyJwtAuthenticator,
  extractProxyJwtToken,
  getProxyJwtConfigErrors,
  readProxyJwtConfig,
  type ProxyJwtAuthenticator,
  type ProxyJwtConfig,
} from "./proxyJwt.js";

const HEADER_NAME = "cf-access-jwt-assertion";
const JWKS_URL = "https://proxy.example.com/cdn-cgi/access/certs";
const ISSUER = "https://proxy.example.com";
const AUDIENCE = "6a1b2c3d4e5f";
const KEY_ID = "test-key";

const CONFIG: ProxyJwtConfig = {
  headerName: HEADER_NAME,
  jwksUrl: JWKS_URL,
  issuer: ISSUER,
  audience: AUDIENCE,
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/**
 * A JWKS entry for the generated key. Omitting `alg` mirrors a gateway that
 * publishes no algorithm on its key, where only the app's own check narrows the
 * library's RS/ES/EdDSA allowlist down to RS256.
 */
const buildJwks = (withAlg: boolean = true): Jwks => {
  const { n, e } = publicKey.export({ format: "jwk" });
  if (typeof n !== "string" || typeof e !== "string") {
    throw new Error("Generated RSA public key exported without n/e JWK parameters");
  }
  return { keys: [{ kty: "RSA", use: "sig", ...(withAlg ? { alg: "RS256" } : {}), kid: KEY_ID, n, e }] };
};

const buildAuthenticator = (jwks: Jwks = buildJwks()): ProxyJwtAuthenticator => {
  const jwksCache = new SimpleJwksCache();
  jwksCache.addJwks(JWKS_URL, jwks);
  return createProxyJwtAuthenticator(CONFIG, jwksCache);
};

const encodeSegment = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

const validPayload = (): Record<string, unknown> => ({
  sub: "user-subject-1",
  email: "person@example.com",
  iss: ISSUER,
  aud: AUDIENCE,
  iat: nowInSeconds(),
  exp: nowInSeconds() + 300,
});

const payloadWithout = (claim: string): Record<string, unknown> => {
  const payload = validPayload();
  delete payload[claim];
  return payload;
};

const signRsa = (payload: Record<string, unknown>, alg: "RS256" | "RS512" = "RS256"): string => {
  const signingInput = `${encodeSegment({ alg, kid: KEY_ID, typ: "JWT" })}.${encodeSegment(payload)}`;
  const digest = alg === "RS256" ? "RSA-SHA256" : "RSA-SHA512";
  const signature = createSign(digest).update(signingInput).sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
};

const signRs256 = (payload: Record<string, unknown>): string => signRsa(payload);

test("a token signed by the proxy key yields the subject and email", async (): Promise<void> => {
  const identity = await buildAuthenticator().verify(signRs256(validPayload()));

  assert.deepEqual(identity, {
    userId: "user-subject-1",
    email: "person@example.com",
    emailVerified: true,
  });
});

test("a token from another issuer is rejected", async (): Promise<void> => {
  const token = signRs256({ ...validPayload(), iss: "https://attacker.example.com" });

  await assert.rejects(buildAuthenticator().verify(token), JwtInvalidIssuerError);
});

test("a token for another audience is rejected", async (): Promise<void> => {
  const token = signRs256({ ...validPayload(), aud: "some-other-application" });

  await assert.rejects(buildAuthenticator().verify(token), JwtInvalidAudienceError);
});

test("an expired token is rejected beyond the clock-skew grace", async (): Promise<void> => {
  const token = signRs256({ ...validPayload(), iat: nowInSeconds() - 3600, exp: nowInSeconds() - 600 });

  await assert.rejects(buildAuthenticator().verify(token), JwtExpiredError);
});

test("the clock-skew grace accepts 30 seconds of drift and rejects 90", async (): Promise<void> => {
  const withinGrace = signRs256({ ...validPayload(), iat: nowInSeconds() - 300, exp: nowInSeconds() - 30 });
  const beyondGrace = signRs256({ ...validPayload(), iat: nowInSeconds() - 300, exp: nowInSeconds() - 90 });

  assert.equal((await buildAuthenticator().verify(withinGrace)).userId, "user-subject-1");
  await assert.rejects(buildAuthenticator().verify(beyondGrace), JwtExpiredError);
});

test("a token without an exp claim is rejected", async (): Promise<void> => {
  await assert.rejects(buildAuthenticator().verify(signRs256(payloadWithout("exp"))), /exp claim/u);
});

test("an unsigned alg=none token is rejected", async (): Promise<void> => {
  // A non-empty signature segment keeps the token past the JWT syntax check, so
  // the algorithm itself is what rejects it.
  const signingInput = `${encodeSegment({ alg: "none", kid: KEY_ID, typ: "JWT" })}.${encodeSegment(validPayload())}`;

  await assert.rejects(
    buildAuthenticator().verify(`${signingInput}.AAAA`),
    JwtInvalidSignatureAlgorithmError,
  );
});

test("an HS256 token signed with the public key as secret is rejected", async (): Promise<void> => {
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signingInput = `${encodeSegment({ alg: "HS256", kid: KEY_ID, typ: "JWT" })}.${encodeSegment(validPayload())}`;
  const signature = createHmac("sha256", publicKeyPem).update(signingInput).digest("base64url");

  await assert.rejects(
    buildAuthenticator().verify(`${signingInput}.${signature}`),
    JwtInvalidSignatureAlgorithmError,
  );
});

test("an RS512 token signed by the proxy key is rejected even when the JWKS pins no alg", async (): Promise<void> => {
  const token = signRsa(validPayload(), "RS512");

  await assert.rejects(
    buildAuthenticator(buildJwks(false)).verify(token),
    /only RS256 is accepted/u,
  );
  assert.equal(
    (await buildAuthenticator(buildJwks(false)).verify(signRs256(validPayload()))).userId,
    "user-subject-1",
  );
});

test("a token without a sub claim is rejected", async (): Promise<void> => {
  await assert.rejects(buildAuthenticator().verify(signRs256(payloadWithout("sub"))), /sub claim/u);
});

test("a token without an email claim is rejected", async (): Promise<void> => {
  await assert.rejects(buildAuthenticator().verify(signRs256(payloadWithout("email"))), /email claim/u);
});

test("the token is read from the configured header only", (): void => {
  const headers = new Headers({ [HEADER_NAME]: "  header-token  " });

  assert.equal(extractProxyJwtToken(headers, HEADER_NAME), "header-token");
  assert.throws(() => extractProxyJwtToken(new Headers(), HEADER_NAME), /cf-access-jwt-assertion/u);
  assert.throws(
    () => extractProxyJwtToken(new Headers({ cookie: `${HEADER_NAME}=cookie-token` }), HEADER_NAME),
    /cf-access-jwt-assertion/u,
  );
});

test("every missing configuration variable is reported by name", (): void => {
  assert.equal(getProxyJwtConfigErrors({}).length, 4);
  assert.deepEqual(
    getProxyJwtConfigErrors({
      AUTH_PROXY_JWT_HEADER: HEADER_NAME,
      AUTH_PROXY_JWKS_URL: JWKS_URL,
      AUTH_PROXY_JWT_ISSUER: ISSUER,
      AUTH_PROXY_JWT_AUDIENCE: "   ",
    }),
    ["AUTH_PROXY_JWT_AUDIENCE must be set to a non-empty value when AUTH_MODE=proxy_jwt"],
  );

  assert.throws(
    () => readProxyJwtConfig({ AUTH_PROXY_JWT_HEADER: HEADER_NAME }),
    /AUTH_PROXY_JWKS_URL/u,
  );
  assert.deepEqual(
    readProxyJwtConfig({
      AUTH_PROXY_JWT_HEADER: ` ${HEADER_NAME} `,
      AUTH_PROXY_JWKS_URL: JWKS_URL,
      AUTH_PROXY_JWT_ISSUER: ISSUER,
      AUTH_PROXY_JWT_AUDIENCE: AUDIENCE,
    }),
    CONFIG,
  );
});
