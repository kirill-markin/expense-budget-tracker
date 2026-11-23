/**
 * The Cognito gate end to end with a locally signed ID token: the verifier gets
 * the test key through `cacheJwks`, so verification itself is real. A separate
 * file from proxy.test.ts because the admin config is cached per process.
 */
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";
import { getJwtVerifier } from "./server/cognitoAuth";
import { getAdminConfig } from "./server/config";
import { ADMIN_EMAIL_HEADER } from "./server/identity";

const REGION = "us-east-1";
const USER_POOL_ID = "us-east-1_AdminTest";
const CLIENT_ID = "admin-test-client";
const KEY_ID = "admin-test-key";
const ADMIN_EMAIL = "admin@example.com";

Object.assign(process.env, {
  ADMIN_AUTH_MODE: "cognito",
  ADMIN_ORIGIN: "https://admin.example.com",
  ADMIN_EMAILS: ADMIN_EMAIL,
  ANALYTICS_EXCLUDED_EMAILS: "",
  AUTH_DOMAIN: "auth.example.com",
  COOKIE_DOMAIN: ".example.com",
  COGNITO_REGION: REGION,
  COGNITO_USER_POOL_ID: USER_POOL_ID,
  COGNITO_CLIENT_ID: CLIENT_ID,
  DB_USER: "unused",
  DB_PASSWORD: "unused",
  DB_HOST: "unused",
  DB_NAME: "unused",
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const auth = getAdminConfig().auth;
if (auth.mode !== "cognito") {
  throw new Error(`expected ADMIN_AUTH_MODE=cognito in the test config, got ${auth.mode}`);
}
const { n, e } = publicKey.export({ format: "jwk" });
if (n === undefined || e === undefined) {
  throw new Error("the generated RSA public key exported no modulus or exponent");
}
getJwtVerifier(auth).cacheJwks({ keys: [{ kty: "RSA", n, e, kid: KEY_ID, alg: "RS256", use: "sig" }] });

const base64Url = (value: string): string => Buffer.from(value).toString("base64url");

const signIdToken = (sub: string, email: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    sub,
    email,
    email_verified: true,
    token_use: "id",
    aud: CLIENT_ID,
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
    iat: now,
    exp: now + 600,
  }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

const requestWithSession = (token: string): NextRequest =>
  new NextRequest("https://admin.example.com/users", { headers: { cookie: `session=${token}` } });

test("admits the exact admin email and forwards it unchanged", async () => {
  const response = await proxy(requestWithSession(signIdToken("admin-sub", ADMIN_EMAIL)));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get(`x-middleware-request-${ADMIN_EMAIL_HEADER}`), ADMIN_EMAIL);
});

test("forbids a case variant of the admin email and logs the user id, not the email", async () => {
  const logMock = mock.method(console, "log", (): void => {});
  try {
    const response = await proxy(requestWithSession(signIdToken("variant-sub", "Admin@Example.com")));

    assert.equal(response.status, 403);
    const lines = logMock.mock.calls.map((call): string => String(call.arguments[0]));
    assert.deepEqual(lines.map((line: string): unknown => JSON.parse(line)), [
      { domain: "admin_auth", action: "forbidden", userId: "variant-sub", path: "/users" },
    ]);
    assert.ok(lines.every((line: string): boolean => !line.toLowerCase().includes(ADMIN_EMAIL)));
  } finally {
    logMock.mock.restore();
  }
});
