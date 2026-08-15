import assert from "node:assert/strict";
import test from "node:test";
import {
  isDefinitiveCognitoRefreshRejection,
  refreshCognitoSessionWithDependencies,
  type RefreshCognitoSessionDependencies,
} from "./cognitoAuth.js";
import type { CognitoRefreshRetryEvent } from "./logger.js";

const refreshedAuthenticationResult: Readonly<Record<string, unknown>> = {
  AuthenticationResult: {
    IdToken: "fresh-id-token",
    RefreshToken: "rotated-refresh-token",
  },
};

const cognitoError = (cognitoType: string, status: number): Error => Object.assign(
  new Error(`Cognito InitiateAuth failed with ${cognitoType} (HTTP ${status})`),
  { cognitoType, cognitoStatus: status, cognitoTarget: "InitiateAuth" },
);

const withCognitoClientId = async (operation: () => Promise<void>): Promise<void> => {
  const previous = process.env.COGNITO_CLIENT_ID;
  process.env.COGNITO_CLIENT_ID = "test-client-id";
  try {
    await operation();
  } finally {
    if (previous === undefined) delete process.env.COGNITO_CLIENT_ID;
    else process.env.COGNITO_CLIENT_ID = previous;
  }
};

test("Cognito refresh retries a transient network failure and then succeeds", async (): Promise<void> => {
  await withCognitoClientId(async () => {
    let requests = 0;
    const delays: Array<number> = [];
    const events: Array<CognitoRefreshRetryEvent> = [];
    const dependencies: RefreshCognitoSessionDependencies = {
      request: async () => {
        requests += 1;
        if (requests === 1) throw new TypeError("fetch failed");
        return refreshedAuthenticationResult;
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
      logRetry: (event) => { events.push(event); },
    };

    const result = await refreshCognitoSessionWithDependencies("sensitive-refresh-token", dependencies);

    assert.deepEqual(result, { idToken: "fresh-id-token", refreshToken: "rotated-refresh-token" });
    assert.equal(requests, 2);
    assert.deepEqual(delays, [100]);
    assert.deepEqual(events, [{
      domain: "auth",
      action: "cognito_refresh_retry",
      level: "warn",
      attempt: 1,
      retryInMs: 100,
      cognitoType: null,
      status: null,
      error: "fetch failed",
    }]);
    assert.equal(JSON.stringify(events).includes("sensitive-refresh-token"), false);
  });
});

test("Cognito refresh raises the final transient error after bounded retries", async (): Promise<void> => {
  await withCognitoClientId(async () => {
    let requests = 0;
    const delays: Array<number> = [];
    const events: Array<CognitoRefreshRetryEvent> = [];
    const finalError = cognitoError("InternalErrorException", 503);
    const dependencies: RefreshCognitoSessionDependencies = {
      request: async () => {
        requests += 1;
        throw finalError;
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
      logRetry: (event) => { events.push(event); },
    };

    await assert.rejects(
      refreshCognitoSessionWithDependencies("sensitive-refresh-token", dependencies),
      (error: unknown) => error === finalError,
    );
    assert.equal(requests, 3);
    assert.deepEqual(delays, [100, 200]);
    assert.deepEqual(events.map(({ attempt, retryInMs, cognitoType, status }) => ({
      attempt, retryInMs, cognitoType, status,
    })), [
      { attempt: 1, retryInMs: 100, cognitoType: "InternalErrorException", status: 503 },
      { attempt: 2, retryInMs: 200, cognitoType: "InternalErrorException", status: 503 },
    ]);
  });
});

test("Cognito refresh does not retry a definitive authentication rejection", async (): Promise<void> => {
  await withCognitoClientId(async () => {
    let requests = 0;
    const delays: Array<number> = [];
    const events: Array<CognitoRefreshRetryEvent> = [];
    const rejection = cognitoError("NotAuthorizedException", 400);
    const dependencies: RefreshCognitoSessionDependencies = {
      request: async () => {
        requests += 1;
        throw rejection;
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
      logRetry: (event) => { events.push(event); },
    };

    await assert.rejects(
      refreshCognitoSessionWithDependencies("invalid-refresh-token", dependencies),
      (error: unknown) => error === rejection,
    );
    assert.equal(isDefinitiveCognitoRefreshRejection(rejection), true);
    assert.equal(isDefinitiveCognitoRefreshRejection(cognitoError("InternalErrorException", 503)), false);
    assert.equal(requests, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(events, []);
  });
});
