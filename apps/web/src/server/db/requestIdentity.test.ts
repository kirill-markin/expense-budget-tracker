import assert from "node:assert/strict";
import test from "node:test";

import { buildRequestIdentity } from "@/server/db/requestIdentity";

const buildHeaders = (userId: string, email: string): Headers =>
  new Headers({
    "x-user-id": userId,
    "x-user-email": email,
    "x-user-email-verified": "true",
  });

const withAuthMode = (authMode: string, run: () => void): void => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = authMode;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = previous;
    }
  }
};

test("local and cognito identities keep their mirrored status", (): void => {
  withAuthMode("none", (): void => {
    assert.deepEqual(buildRequestIdentity(buildHeaders("local", "local@example.invalid")), {
      userId: "local",
      email: "local@example.invalid",
      emailVerified: true,
      cognitoStatus: "LOCAL",
      cognitoEnabled: true,
    });
  });

  withAuthMode("cognito", (): void => {
    assert.deepEqual(buildRequestIdentity(buildHeaders("cognito-sub-1", "person@example.com")), {
      userId: "cognito-sub-1",
      email: "person@example.com",
      emailVerified: true,
      cognitoStatus: "CONFIRMED",
      cognitoEnabled: true,
    });
  });
});

test("a proxy-authenticated identity is mirrored with the proxy status", (): void => {
  withAuthMode("proxy_jwt", (): void => {
    assert.deepEqual(buildRequestIdentity(buildHeaders("proxy-sub-1", "person@example.com")), {
      userId: "proxy-sub-1",
      email: "person@example.com",
      emailVerified: true,
      cognitoStatus: "PROXY",
      cognitoEnabled: true,
    });
  });
});
