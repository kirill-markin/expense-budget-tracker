import assert from "node:assert/strict";
import test from "node:test";
import { getConfiguredAuthMode, getAuthModeValidationErrors } from "./authMode";

test("getConfiguredAuthMode rejects missing AUTH_MODE in development", () => {
  assert.throws(
    () => getConfiguredAuthMode({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      CORS_ORIGIN: "http://localhost:3000",
    }),
    /AUTH_MODE must be set explicitly/,
  );
});

test("getConfiguredAuthMode rejects missing AUTH_MODE in production", () => {
  assert.throws(
    () => getConfiguredAuthMode({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      CORS_ORIGIN: "http://localhost:3000",
    }),
    /AUTH_MODE must be set explicitly/,
  );
});

test("getConfiguredAuthMode accepts explicit local none mode", () => {
  assert.equal(
    getConfiguredAuthMode({
      AUTH_MODE: "none",
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      CORS_ORIGIN: "http://localhost:3000",
    }),
    "none",
  );
});

test("getConfiguredAuthMode rejects none mode for docker-style bind", () => {
  assert.throws(
    () => getConfiguredAuthMode({
      AUTH_MODE: "none",
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      CORS_ORIGIN: "http://localhost:3000",
    }),
    /requires HOST to be localhost/,
  );
});

test("getConfiguredAuthMode rejects none mode for non-local origin", () => {
  assert.throws(
    () => getConfiguredAuthMode({
      AUTH_MODE: "none",
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      CORS_ORIGIN: "https://app.example.com",
    }),
    /requires CORS_ORIGIN to be a local http origin/,
  );
});

test("getAuthModeValidationErrors keeps cognito-specific env validation separate", () => {
  assert.deepEqual(
    getAuthModeValidationErrors({
      AUTH_MODE: "cognito",
      NODE_ENV: "production",
    }),
    [],
  );
});

test("getConfiguredAuthMode accepts explicit cognito mode", () => {
  assert.equal(
    getConfiguredAuthMode({
      AUTH_MODE: "cognito",
      NODE_ENV: "production",
    }),
    "cognito",
  );
});

test("getConfiguredAuthMode rejects invalid values", () => {
  assert.throws(
    () => getConfiguredAuthMode({
      AUTH_MODE: "disabled",
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      CORS_ORIGIN: "http://localhost:3000",
    }),
    /Invalid AUTH_MODE="disabled"/,
  );
});
