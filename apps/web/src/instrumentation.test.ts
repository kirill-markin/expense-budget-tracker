import assert from "node:assert/strict";
import test from "node:test";
import { register } from "./instrumentation";

const ORIGINAL_ENV = { ...process.env };
const MUTABLE_ENV = process.env as Record<string, string | undefined>;

const restoreEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

test.afterEach(() => {
  restoreEnv();
});

test("register rejects missing AUTH_MODE in production", () => {
  MUTABLE_ENV.NODE_ENV = "production";
  delete process.env.AUTH_MODE;
  process.env.DATABASE_URL = "postgresql://app:app@localhost:5432/tracker";

  assert.throws(
    () => register(),
    /AUTH_MODE must be set explicitly to "none" or "cognito"/,
  );
});

test("register rejects AUTH_MODE=none in non-local production", () => {
  MUTABLE_ENV.NODE_ENV = "production";
  process.env.AUTH_MODE = "none";
  process.env.HOST = "0.0.0.0";
  process.env.CORS_ORIGIN = "https://app.example.com";
  process.env.DATABASE_URL = "postgresql://app:app@localhost:5432/tracker";

  assert.throws(
    () => register(),
    /AUTH_MODE=none is not allowed when NODE_ENV=production/,
  );
});

test("register rejects incomplete cognito configuration in production", () => {
  MUTABLE_ENV.NODE_ENV = "production";
  process.env.AUTH_MODE = "cognito";
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_CLIENT_ID;
  delete process.env.COGNITO_REGION;
  delete process.env.AUTH_DOMAIN;
  delete process.env.DB_HOST;
  delete process.env.DB_PASSWORD;
  process.env.CORS_ORIGIN = "https://app.example.com";

  assert.throws(
    () => register(),
    /COGNITO_USER_POOL_ID must be set when AUTH_MODE=cognito/,
  );
});
