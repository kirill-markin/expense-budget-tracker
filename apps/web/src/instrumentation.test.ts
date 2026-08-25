import assert from "node:assert/strict";
import test from "node:test";
import { getLangfuseConfigValidationErrors } from "@/instrumentation";

const LANGFUSE_CONNECTION_ENVIRONMENT = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
  LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
};

const LANGFUSE_ENVIRONMENT = {
  ...LANGFUSE_CONNECTION_ENVIRONMENT,
  LANGFUSE_RELEASE: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

test("Langfuse configuration accepts disabled telemetry", (): void => {
  assert.deepEqual(getLangfuseConfigValidationErrors({}), []);
  assert.deepEqual(getLangfuseConfigValidationErrors({ LANGFUSE_RELEASE: "local" }), []);
});

test("Langfuse configuration rejects partial connection settings", (): void => {
  assert.deepEqual(
    getLangfuseConfigValidationErrors({
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_RELEASE: LANGFUSE_ENVIRONMENT.LANGFUSE_RELEASE,
    }),
    [
      "LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL must be configured together with non-empty values",
    ],
  );
});

test("Langfuse configuration requires a release when telemetry is enabled", (): void => {
  assert.deepEqual(getLangfuseConfigValidationErrors(LANGFUSE_CONNECTION_ENVIRONMENT), [
    "LANGFUSE_RELEASE must be an explicit 64-character lowercase hexadecimal release fingerprint when Langfuse telemetry is enabled",
  ]);
});

test("Langfuse configuration rejects a non-fingerprint release", (): void => {
  assert.deepEqual(
    getLangfuseConfigValidationErrors({
      ...LANGFUSE_CONNECTION_ENVIRONMENT,
      LANGFUSE_RELEASE: "0123456789abcdef0123456789abcdef01234567",
    }),
    [
      "LANGFUSE_RELEASE must be an explicit 64-character lowercase hexadecimal release fingerprint when Langfuse telemetry is enabled",
    ],
  );
});

test("Langfuse configuration accepts a complete telemetry contract", (): void => {
  assert.deepEqual(getLangfuseConfigValidationErrors(LANGFUSE_ENVIRONMENT), []);
});
