import assert from "node:assert/strict";
import test from "node:test";
import { validateAuthEnvironment } from "./config.js";

const AUTH_ENV_KEYS = [
  "COGNITO_CLIENT_ID",
  "COGNITO_USER_POOL_ID",
  "COGNITO_REGION",
  "SESSION_ENCRYPTION_KEY",
  "ALLOWED_REDIRECT_URIS",
  "COOKIE_DOMAIN",
  "OAUTH_ISSUER",
  "OAUTH_RESOURCE",
  "AUTH_DATABASE_URL",
  "NODE_ENV",
] as const;

const withAuthEnvironment = (
  nodeEnvironment: string,
  issuer: string,
  resource: string,
  operation: () => void,
): void => {
  const previous = new Map<string, string | undefined>(
    AUTH_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    COGNITO_CLIENT_ID: "client-id",
    COGNITO_USER_POOL_ID: "eu-west-1_pool",
    COGNITO_REGION: "eu-west-1",
    SESSION_ENCRYPTION_KEY: "test-key",
    ALLOWED_REDIRECT_URIS: "https://app.example.com",
    COOKIE_DOMAIN: ".example.com",
    OAUTH_ISSUER: issuer,
    OAUTH_RESOURCE: resource,
    AUTH_DATABASE_URL: "postgres://auth@example.invalid/auth",
    NODE_ENV: nodeEnvironment,
  });
  try {
    operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("auth startup validates the complete OAuth issuer/resource pair", (): void => {
  withAuthEnvironment(
    "production",
    "https://auth.example.com",
    "https://mcp.example.com/mcp",
    () => assert.doesNotThrow(validateAuthEnvironment),
  );
  withAuthEnvironment(
    "development",
    "https://auth.example.com",
    "https://mcp.other.example/mcp",
    () => assert.throws(validateAuthEnvironment, /misconfigured/u),
  );
});
