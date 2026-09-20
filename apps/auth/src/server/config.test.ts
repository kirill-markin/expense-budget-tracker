import assert from "node:assert/strict";
import test from "node:test";
import { validateAuthEnvironment } from "./config.js";

const AUTH_ENV_KEYS = [
  "AUTH_MODE",
  "COGNITO_CLIENT_ID",
  "COGNITO_USER_POOL_ID",
  "COGNITO_REGION",
  "SESSION_ENCRYPTION_KEY",
  "ALLOWED_REDIRECT_URIS",
  "COOKIE_DOMAIN",
  "OAUTH_ISSUER",
  "OAUTH_RESOURCE",
  "AUTH_DATABASE_URL",
  "DB_HOST",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "AUTH_PROXY_JWT_HEADER",
  "AUTH_PROXY_JWKS_URL",
  "AUTH_PROXY_JWT_ISSUER",
  "AUTH_PROXY_JWT_AUDIENCE",
  "CORS_ORIGIN",
  "NODE_ENV",
] as const;

type AuthEnvironment = Readonly<Partial<Record<typeof AUTH_ENV_KEYS[number], string>>>;

/** Every tracked variable is cleared first, so only `values` is visible. */
const withEnvironment = (values: AuthEnvironment, operation: () => void): void => {
  const previous = new Map<string, string | undefined>(
    AUTH_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const COGNITO_ENVIRONMENT: AuthEnvironment = {
  COGNITO_CLIENT_ID: "client-id",
  COGNITO_USER_POOL_ID: "eu-west-1_pool",
  COGNITO_REGION: "eu-west-1",
  SESSION_ENCRYPTION_KEY: "test-key",
  ALLOWED_REDIRECT_URIS: "https://app.example.com",
  COOKIE_DOMAIN: ".example.com",
  OAUTH_ISSUER: "https://auth.example.com",
  OAUTH_RESOURCE: "https://mcp.example.com/mcp",
  AUTH_DATABASE_URL: "postgres://auth@example.invalid/auth",
  NODE_ENV: "production",
};

const PROXY_JWT_ENVIRONMENT: AuthEnvironment = {
  AUTH_MODE: "proxy_jwt",
  AUTH_PROXY_JWT_HEADER: "cf-access-jwt-assertion",
  AUTH_PROXY_JWKS_URL: "https://proxy.example.com/cdn-cgi/access/certs",
  AUTH_PROXY_JWT_ISSUER: "https://proxy.example.com",
  AUTH_PROXY_JWT_AUDIENCE: "6a1b2c3d4e5f",
  ALLOWED_REDIRECT_URIS: "https://app.example.com",
  COOKIE_DOMAIN: ".example.com",
  OAUTH_ISSUER: "https://auth.example.com",
  OAUTH_RESOURCE: "https://mcp.example.com/mcp",
  AUTH_DATABASE_URL: "postgres://auth@example.invalid/auth",
  NODE_ENV: "production",
};

const withoutKey = (
  environment: AuthEnvironment,
  key: typeof AUTH_ENV_KEYS[number],
): AuthEnvironment => Object.fromEntries(
  Object.entries(environment).filter(([name]): boolean => name !== key),
) as AuthEnvironment;

test("auth startup validates the complete OAuth issuer/resource pair", (): void => {
  withEnvironment(
    COGNITO_ENVIRONMENT,
    () => assert.doesNotThrow(validateAuthEnvironment),
  );
  withEnvironment(
    { ...COGNITO_ENVIRONMENT, NODE_ENV: "development", OAUTH_RESOURCE: "https://mcp.other.example/mcp" },
    () => assert.throws(validateAuthEnvironment, /misconfigured/u),
  );
});

test("cognito mode requires the Cognito and session variables, with or without an explicit AUTH_MODE", (): void => {
  for (const authMode of [undefined, "cognito"] as const) {
    const environment = authMode === undefined
      ? COGNITO_ENVIRONMENT
      : { ...COGNITO_ENVIRONMENT, AUTH_MODE: authMode };
    withEnvironment(environment, () => assert.doesNotThrow(validateAuthEnvironment));
    for (const key of ["COGNITO_CLIENT_ID", "COGNITO_USER_POOL_ID", "COGNITO_REGION", "SESSION_ENCRYPTION_KEY"] as const) {
      withEnvironment(
        withoutKey(environment, key),
        () => assert.throws(validateAuthEnvironment, new RegExp(`missing required env vars: ${key}`, "u")),
      );
    }
  }
});

test("proxy_jwt mode drops the Cognito requirements and demands the proxy variables", (): void => {
  withEnvironment(PROXY_JWT_ENVIRONMENT, () => assert.doesNotThrow(validateAuthEnvironment));

  for (const key of ["AUTH_PROXY_JWT_HEADER", "AUTH_PROXY_JWKS_URL", "AUTH_PROXY_JWT_ISSUER", "AUTH_PROXY_JWT_AUDIENCE"] as const) {
    withEnvironment(
      withoutKey(PROXY_JWT_ENVIRONMENT, key),
      () => assert.throws(validateAuthEnvironment, new RegExp(`${key} must be set`, "u")),
    );
  }
});

test("the shared variables stay required in proxy_jwt mode", (): void => {
  for (const key of ["ALLOWED_REDIRECT_URIS", "COOKIE_DOMAIN", "OAUTH_ISSUER", "OAUTH_RESOURCE", "AUTH_DATABASE_URL"] as const) {
    withEnvironment(
      withoutKey(PROXY_JWT_ENVIRONMENT, key),
      () => assert.throws(validateAuthEnvironment, /missing required env vars/u),
    );
  }
});

test("an unknown AUTH_MODE fails startup instead of silently using Cognito", (): void => {
  withEnvironment(
    { ...COGNITO_ENVIRONMENT, AUTH_MODE: "none" },
    () => assert.throws(validateAuthEnvironment, /Invalid AUTH_MODE="none"/u),
  );
});
