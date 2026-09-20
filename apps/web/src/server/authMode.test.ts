import assert from "node:assert/strict";
import test from "node:test";

import { getAuthModeValidationErrors, getConfiguredAuthMode } from "@/server/authMode";

const LOCAL_ORIGIN = "http://127.0.0.1:3000";

test("AUTH_MODE=none rejects a production build on a non-loopback host without the insecure flag", (): void => {
  const errors = getAuthModeValidationErrors({
    AUTH_MODE: "none",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    CORS_ORIGIN: LOCAL_ORIGIN,
  });

  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.includes("NODE_ENV=production")));
  assert.ok(errors.some((error) => error.includes("HOST")));
});

test("ALLOW_INSECURE_NO_AUTH=true accepts a production build bound to 0.0.0.0", (): void => {
  const env = {
    AUTH_MODE: "none",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    CORS_ORIGIN: LOCAL_ORIGIN,
    ALLOW_INSECURE_NO_AUTH: "true",
  };

  assert.deepEqual(getAuthModeValidationErrors(env), []);
  assert.equal(getConfiguredAuthMode(env), "none");
});

test("ALLOW_INSECURE_NO_AUTH=true still requires a local CORS_ORIGIN", (): void => {
  const missingOrigin = getAuthModeValidationErrors({
    AUTH_MODE: "none",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    ALLOW_INSECURE_NO_AUTH: "true",
  });
  assert.equal(missingOrigin.length, 1);
  assert.ok(missingOrigin[0]?.includes("CORS_ORIGIN"));

  const remoteOrigin = getAuthModeValidationErrors({
    AUTH_MODE: "none",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    CORS_ORIGIN: "https://tracker.example.com",
    ALLOW_INSECURE_NO_AUTH: "true",
  });
  assert.equal(remoteOrigin.length, 1);
  assert.ok(remoteOrigin[0]?.includes("CORS_ORIGIN"));
});

test("only the exact value true relaxes the AUTH_MODE=none checks", (): void => {
  for (const flag of ["false", "1", "yes", "", "TRUE", "True", " true ", "true\n"]) {
    const errors = getAuthModeValidationErrors({
      AUTH_MODE: "none",
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      CORS_ORIGIN: LOCAL_ORIGIN,
      ALLOW_INSECURE_NO_AUTH: flag,
    });
    assert.equal(errors.length, 2, `ALLOW_INSECURE_NO_AUTH="${flag}" must not relax validation`);
  }
});

test("ALLOW_INSECURE_NO_AUTH never changes AUTH_MODE=cognito validation", (): void => {
  const cognitoEnv = {
    AUTH_MODE: "cognito",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    CORS_ORIGIN: "https://tracker.example.com",
  };

  assert.deepEqual(getAuthModeValidationErrors(cognitoEnv), []);
  assert.deepEqual(
    getAuthModeValidationErrors({ ...cognitoEnv, ALLOW_INSECURE_NO_AUTH: "true" }),
    getAuthModeValidationErrors(cognitoEnv),
  );
  assert.equal(
    getConfiguredAuthMode({ ...cognitoEnv, ALLOW_INSECURE_NO_AUTH: "true" }),
    "cognito",
  );
});

test("ALLOW_INSECURE_NO_AUTH alone does not make an unset or invalid AUTH_MODE valid", (): void => {
  assert.deepEqual(getAuthModeValidationErrors({ ALLOW_INSECURE_NO_AUTH: "true" }), [
    'AUTH_MODE must be set explicitly to "none" or "cognito"',
  ]);
  assert.deepEqual(
    getAuthModeValidationErrors({ AUTH_MODE: "proxy", ALLOW_INSECURE_NO_AUTH: "true" }),
    ['Invalid AUTH_MODE="proxy". Expected "none" or "cognito"'],
  );
});
