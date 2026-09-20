import assert from "node:assert/strict";
import test from "node:test";

import { getAuthModeValidationErrors, getConfiguredAuthMode } from "@/server/authMode";

const LOCAL_ORIGIN = "http://127.0.0.1:3000";

const PROXY_JWT_ENV = {
  AUTH_MODE: "proxy_jwt",
  AUTH_PROXY_JWT_HEADER: "cf-access-jwt-assertion",
  AUTH_PROXY_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  AUTH_PROXY_JWT_ISSUER: "https://team.cloudflareaccess.com",
  AUTH_PROXY_JWT_AUDIENCE: "application-audience-tag",
  CORS_ORIGIN: "https://tracker.example.com",
};

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
    'AUTH_MODE must be set explicitly to "none", "cognito", or "proxy_jwt"',
  ]);
  assert.deepEqual(
    getAuthModeValidationErrors({ AUTH_MODE: "proxy", ALLOW_INSECURE_NO_AUTH: "true" }),
    ['Invalid AUTH_MODE="proxy". Expected "none", "cognito", or "proxy_jwt"'],
  );
});

test("AUTH_MODE=proxy_jwt accepts a production build on any host once configured", (): void => {
  const env = { ...PROXY_JWT_ENV, NODE_ENV: "production", HOST: "0.0.0.0" };

  assert.deepEqual(getAuthModeValidationErrors(env), []);
  assert.equal(getConfiguredAuthMode(env), "proxy_jwt");
});

test("AUTH_MODE=proxy_jwt names every missing AUTH_PROXY_* variable", (): void => {
  const errors = getAuthModeValidationErrors({ AUTH_MODE: "proxy_jwt", CORS_ORIGIN: "https://tracker.example.com" });

  assert.deepEqual(errors.length, 4);
  for (const name of [
    "AUTH_PROXY_JWT_HEADER",
    "AUTH_PROXY_JWKS_URL",
    "AUTH_PROXY_JWT_ISSUER",
    "AUTH_PROXY_JWT_AUDIENCE",
  ]) {
    assert.ok(errors.some((error) => error.includes(name)), `${name} must be reported`);
  }
  assert.throws(() => getConfiguredAuthMode({ AUTH_MODE: "proxy_jwt" }), /AUTH_PROXY_JWT_HEADER/u);
});

test("AUTH_MODE=proxy_jwt requires CORS_ORIGIN, in any scheme or host shape", (): void => {
  const withoutOrigin = { ...PROXY_JWT_ENV, CORS_ORIGIN: undefined };

  assert.deepEqual(getAuthModeValidationErrors(withoutOrigin), [
    "AUTH_MODE=proxy_jwt requires CORS_ORIGIN to be set to the public origin the upstream proxy serves",
  ]);
  assert.deepEqual(getAuthModeValidationErrors({ ...PROXY_JWT_ENV, CORS_ORIGIN: "  " }), [
    "AUTH_MODE=proxy_jwt requires CORS_ORIGIN to be set to the public origin the upstream proxy serves",
  ]);
  assert.deepEqual(getAuthModeValidationErrors({ ...PROXY_JWT_ENV, CORS_ORIGIN: LOCAL_ORIGIN }), []);

  for (const origin of [
    "https://tracker.example.com",
    "http://tracker.example.com",
    "https://tracker.example.com:8443",
  ]) {
    assert.deepEqual(
      getAuthModeValidationErrors({ ...PROXY_JWT_ENV, CORS_ORIGIN: origin }),
      [],
      `CORS_ORIGIN="${origin}" must be accepted`,
    );
  }
});

test("AUTH_MODE=proxy_jwt rejects a CORS_ORIGIN that is not an absolute origin", (): void => {
  for (const origin of [
    "tracker.example.com",
    "https://tracker.example.com/",
    "https://tracker.example.com/app",
    "https://tracker.example.com?a=b",
    " https://tracker.example.com ",
  ]) {
    const errors = getAuthModeValidationErrors({ ...PROXY_JWT_ENV, CORS_ORIGIN: origin });

    assert.equal(errors.length, 1, `CORS_ORIGIN="${origin}" must be rejected`);
    assert.ok(errors[0]?.includes("CORS_ORIGIN"));
    assert.ok(errors[0]?.includes("absolute origin"));
    assert.ok(errors[0]?.includes(origin));
    assert.throws(
      () => getConfiguredAuthMode({ ...PROXY_JWT_ENV, CORS_ORIGIN: origin }),
      /CORS_ORIGIN/u,
    );
  }
});

test("AUTH_MODE=cognito never depends on the AUTH_PROXY_* variables", (): void => {
  const cognitoEnv = {
    AUTH_MODE: "cognito",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    CORS_ORIGIN: "https://tracker.example.com",
  };

  assert.deepEqual(getAuthModeValidationErrors(cognitoEnv), []);
  assert.equal(getConfiguredAuthMode(cognitoEnv), "cognito");
});
