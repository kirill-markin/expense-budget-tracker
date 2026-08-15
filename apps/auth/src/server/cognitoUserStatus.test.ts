import assert from "node:assert/strict";
import test from "node:test";
import {
  CognitoIdentityProviderServiceException,
  TooManyRequestsException,
  UserNotFoundException,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  getCognitoOAuthOwnerStatusWithDependencies,
  type CognitoUserStatusDependencies,
} from "./cognitoUserStatus.js";
import type { CognitoOAuthOwnerRetryEvent } from "./logger.js";

const userPoolId = "eu-west-1_pool";
const userId = "sensitive-user-id";

type TransientErrorCase = Readonly<{
  label: string;
  createError: (attempt: number) => Error;
  expectedCognitoType: string | null;
  expectedStatus: number | null;
  expectedErrorType: "error" | "type_error";
}>;

const transientErrorCases: ReadonlyArray<TransientErrorCase> = [
  {
    label: "ENOTFOUND",
    createError: (attempt) => Object.assign(
      new Error(`DNS lookup failed for ${userId} on attempt ${attempt}`),
      { code: "ENOTFOUND" },
    ),
    expectedCognitoType: null,
    expectedStatus: null,
    expectedErrorType: "error",
  },
  {
    label: "EAI_AGAIN",
    createError: (attempt) => Object.assign(
      new Error(`Temporary DNS failure for ${userId} on attempt ${attempt}`),
      { code: "EAI_AGAIN" },
    ),
    expectedCognitoType: null,
    expectedStatus: null,
    expectedErrorType: "error",
  },
  {
    label: "TypeError",
    createError: (attempt) => new TypeError(
      `Smithy request failed for ${userId} on attempt ${attempt}`,
    ),
    expectedCognitoType: null,
    expectedStatus: null,
    expectedErrorType: "type_error",
  },
  {
    label: "TimeoutError",
    createError: (attempt) => Object.assign(
      new Error(`Socket timed out for ${userId} on attempt ${attempt}`),
      { name: "TimeoutError" },
    ),
    expectedCognitoType: null,
    expectedStatus: null,
    expectedErrorType: "error",
  },
  {
    label: "ECONNRESET",
    createError: (attempt) => Object.assign(
      new Error(`Socket reset for ${userId} on attempt ${attempt}`),
      { code: "ECONNRESET" },
    ),
    expectedCognitoType: null,
    expectedStatus: null,
    expectedErrorType: "error",
  },
  {
    label: "RequestTimeoutException",
    createError: (attempt) => new CognitoIdentityProviderServiceException({
      name: "RequestTimeoutException",
      $fault: "client",
      $metadata: { httpStatusCode: 400 },
      message: `Request timed out for ${userId} on attempt ${attempt}`,
    }),
    expectedCognitoType: "RequestTimeoutException",
    expectedStatus: 400,
    expectedErrorType: "error",
  },
  {
    label: "server fault",
    createError: (attempt) => new CognitoIdentityProviderServiceException({
      name: "ServerFaultForTest",
      $fault: "server",
      $metadata: { httpStatusCode: 400 },
      message: `Server fault for ${userId} on attempt ${attempt}`,
    }),
    expectedCognitoType: "ServerFaultForTest",
    expectedStatus: 400,
    expectedErrorType: "error",
  },
  {
    label: "HTTP 5xx",
    createError: (attempt) => new CognitoIdentityProviderServiceException({
      name: "HttpFailureForTest",
      $fault: "client",
      $metadata: { httpStatusCode: 503 },
      message: `HTTP failure for ${userId} on attempt ${attempt}`,
    }),
    expectedCognitoType: "HttpFailureForTest",
    expectedStatus: 503,
    expectedErrorType: "error",
  },
  {
    label: "HTTP 429",
    createError: (attempt) => new CognitoIdentityProviderServiceException({
      name: "StatusOnlyThrottleForTest",
      $fault: "client",
      $metadata: { httpStatusCode: 429 },
      message: `Status-only throttle for ${userId} on attempt ${attempt}`,
    }),
    expectedCognitoType: "StatusOnlyThrottleForTest",
    expectedStatus: 429,
    expectedErrorType: "error",
  },
  {
    label: "transient service name",
    createError: (attempt) => new CognitoIdentityProviderServiceException({
      name: "ServiceUnavailableException",
      $fault: "client",
      $metadata: { httpStatusCode: 400 },
      message: `Service unavailable for ${userId} on attempt ${attempt}`,
    }),
    expectedCognitoType: "ServiceUnavailableException",
    expectedStatus: 400,
    expectedErrorType: "error",
  },
];

type InvalidResponseCase = Readonly<{
  label: string;
  response: AdminGetUserCommandOutput;
  expectedError: RegExp;
}>;

const invalidResponseCases: ReadonlyArray<InvalidResponseCase> = [
  {
    label: "missing Enabled",
    response: { $metadata: {}, Username: "cognito-username", UserStatus: "CONFIRMED" },
    expectedError: /missing a boolean Enabled value/u,
  },
  {
    label: "invalid Enabled",
    response: {
      $metadata: {},
      Username: "cognito-username",
      Enabled: "true",
      UserStatus: "CONFIRMED",
    } as unknown as AdminGetUserCommandOutput,
    expectedError: /missing a boolean Enabled value/u,
  },
  {
    label: "missing UserStatus",
    response: { $metadata: {}, Username: "cognito-username", Enabled: true },
    expectedError: /invalid UserStatus value/u,
  },
  {
    label: "invalid UserStatus",
    response: {
      $metadata: {},
      Username: "cognito-username",
      Enabled: true,
      UserStatus: "ACTIVE",
    } as unknown as AdminGetUserCommandOutput,
    expectedError: /invalid UserStatus value/u,
  },
];

const response = (
  enabled: boolean,
  userStatus: AdminGetUserCommandOutput["UserStatus"],
): AdminGetUserCommandOutput => ({
  $metadata: {},
  Username: "cognito-username",
  Enabled: enabled,
  UserStatus: userStatus,
});

const withUserPoolId = async (operation: () => Promise<void>): Promise<void> => {
  const previous = process.env.COGNITO_USER_POOL_ID;
  process.env.COGNITO_USER_POOL_ID = userPoolId;
  try {
    await operation();
  } finally {
    if (previous === undefined) delete process.env.COGNITO_USER_POOL_ID;
    else process.env.COGNITO_USER_POOL_ID = previous;
  }
};

const createDependencies = (
  adminGetUser: CognitoUserStatusDependencies["adminGetUser"],
  events: Array<CognitoOAuthOwnerRetryEvent>,
  delays: Array<number>,
): CognitoUserStatusDependencies => ({
  adminGetUser,
  wait: async (delayMs) => { delays.push(delayMs); },
  logRetry: (event) => { events.push(event); },
});

test("confirmed enabled Cognito owners remain eligible for OAuth renewal", async (): Promise<void> => {
  await withUserPoolId(async () => {
    const calls: Array<Readonly<{ requestedPoolId: string; requestedUserId: string }>> = [];
    const dependencies = createDependencies(async (requestedPoolId, requestedUserId) => {
      calls.push({ requestedPoolId, requestedUserId });
      return response(true, "CONFIRMED");
    }, [], []);

    const status = await getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies);

    assert.equal(status, "active");
    assert.deepEqual(calls, [{ requestedPoolId: userPoolId, requestedUserId: userId }]);
  });
});

test("disabled and non-confirmed Cognito owners are definitively inactive", async (): Promise<void> => {
  await withUserPoolId(async () => {
    const disabled = await getCognitoOAuthOwnerStatusWithDependencies(
      userId,
      createDependencies(async () => response(false, "CONFIRMED"), [], []),
    );
    const nonConfirmed = await getCognitoOAuthOwnerStatusWithDependencies(
      userId,
      createDependencies(async () => response(true, "UNCONFIRMED"), [], []),
    );

    assert.equal(disabled, "inactive");
    assert.equal(nonConfirmed, "inactive");
  });
});

test("AdminGetUser Enabled and UserStatus fields are parsed strictly", async (): Promise<void> => {
  await withUserPoolId(async () => {
    for (const responseCase of invalidResponseCases) {
      const events: Array<CognitoOAuthOwnerRetryEvent> = [];
      const delays: Array<number> = [];
      let attempts = 0;

      await assert.rejects(
        getCognitoOAuthOwnerStatusWithDependencies(
          userId,
          createDependencies(async () => {
            attempts += 1;
            return responseCase.response;
          }, events, delays),
        ),
        responseCase.expectedError,
        responseCase.label,
      );
      assert.equal(attempts, 1, responseCase.label);
      assert.deepEqual(delays, [], responseCase.label);
      assert.deepEqual(events, [], responseCase.label);
    }
  });
});

test("missing Cognito owners are definitively inactive without retries", async (): Promise<void> => {
  await withUserPoolId(async () => {
    const events: Array<CognitoOAuthOwnerRetryEvent> = [];
    let attempts = 0;
    const missing = new UserNotFoundException({
      $metadata: { httpStatusCode: 400 },
      message: "User does not exist",
    });
    const dependencies = createDependencies(async () => {
      attempts += 1;
      throw missing;
    }, events, []);

    const status = await getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies);

    assert.equal(status, "inactive");
    assert.equal(attempts, 1);
    assert.deepEqual(events, []);
  });
});

test("permanent Cognito client faults are raised without retries", async (): Promise<void> => {
  await withUserPoolId(async () => {
    const events: Array<CognitoOAuthOwnerRetryEvent> = [];
    const delays: Array<number> = [];
    let attempts = 0;
    const permanentFailure = new CognitoIdentityProviderServiceException({
      name: "PermanentClientFaultForTest",
      $fault: "client",
      $metadata: { httpStatusCode: 400 },
      message: `Permanent client fault for ${userId}`,
    });
    const dependencies = createDependencies(async () => {
      attempts += 1;
      throw permanentFailure;
    }, events, delays);

    await assert.rejects(
      getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies),
      (error: unknown) => error === permanentFailure,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(events, []);
  });
});

test("transient Cognito failures are retried with identifier-free warning events", async (): Promise<void> => {
  await withUserPoolId(async () => {
    const events: Array<CognitoOAuthOwnerRetryEvent> = [];
    const delays: Array<number> = [];
    let attempts = 0;
    const throttled = new TooManyRequestsException({
      $metadata: { httpStatusCode: 429 },
      message: `Throttled owner ${userId}`,
    });
    const dependencies = createDependencies(async () => {
      attempts += 1;
      if (attempts === 1) throw throttled;
      return response(true, "CONFIRMED");
    }, events, delays);

    const status = await getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies);

    assert.equal(status, "active");
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [100]);
    assert.deepEqual(events, [{
      domain: "auth",
      action: "cognito_oauth_owner_retry",
      level: "warn",
      attempt: 1,
      retryInMs: 100,
      cognitoType: "TooManyRequestsException",
      status: 429,
      errorType: "error",
    }]);
    assert.equal(JSON.stringify(events).includes(userId), false);
  });
});

test("the final transient Cognito failure is raised after bounded retries", async (): Promise<void> => {
  await withUserPoolId(async () => {
    const events: Array<CognitoOAuthOwnerRetryEvent> = [];
    const delays: Array<number> = [];
    let attempts = 0;
    const failures = [1, 2, 3].map((attempt) => new TooManyRequestsException({
      $metadata: { httpStatusCode: 429 },
      message: `Transient failure ${attempt}`,
    }));
    const dependencies = createDependencies(async () => {
      const failure = failures[attempts];
      attempts += 1;
      if (failure === undefined) throw new Error("Missing test failure");
      throw failure;
    }, events, delays);

    await assert.rejects(
      getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies),
      (error: unknown) => error === failures[2],
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);
    assert.deepEqual(events.map((event) => event.attempt), [1, 2]);
  });
});

test("transient classifier cases succeed after one outer retry", async (): Promise<void> => {
  await withUserPoolId(async () => {
    for (const errorCase of transientErrorCases) {
      const events: Array<CognitoOAuthOwnerRetryEvent> = [];
      const delays: Array<number> = [];
      let attempts = 0;
      const transientError = errorCase.createError(1);
      const dependencies = createDependencies(async () => {
        attempts += 1;
        if (attempts === 1) throw transientError;
        return response(true, "CONFIRMED");
      }, events, delays);

      const status = await getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies);

      assert.equal(status, "active", errorCase.label);
      assert.equal(attempts, 2, errorCase.label);
      assert.deepEqual(delays, [100], errorCase.label);
      assert.deepEqual(events.map((event) => ({
        attempt: event.attempt,
        retryInMs: event.retryInMs,
        cognitoType: event.cognitoType,
        status: event.status,
        errorType: event.errorType,
      })), [{
        attempt: 1,
        retryInMs: 100,
        cognitoType: errorCase.expectedCognitoType,
        status: errorCase.expectedStatus,
        errorType: errorCase.expectedErrorType,
      }], errorCase.label);
      assert.equal(JSON.stringify(events).includes(userId), false, errorCase.label);
      assert.equal(JSON.stringify(events).includes(userPoolId), false, errorCase.label);
    }
  });
});

test("transient classifier cases raise the final error after three attempts", async (): Promise<void> => {
  await withUserPoolId(async () => {
    for (const errorCase of transientErrorCases) {
      const events: Array<CognitoOAuthOwnerRetryEvent> = [];
      const delays: Array<number> = [];
      const failures = [1, 2, 3].map((attempt) => errorCase.createError(attempt));
      let attempts = 0;
      const dependencies = createDependencies(async () => {
        const failure = failures[attempts];
        attempts += 1;
        if (failure === undefined) throw new Error(`Missing ${errorCase.label} test failure`);
        throw failure;
      }, events, delays);

      await assert.rejects(
        getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies),
        (error: unknown) => error === failures[2],
        errorCase.label,
      );
      assert.equal(attempts, 3, errorCase.label);
      assert.deepEqual(delays, [100, 200], errorCase.label);
      assert.deepEqual(events.map((event) => ({
        attempt: event.attempt,
        retryInMs: event.retryInMs,
        cognitoType: event.cognitoType,
        status: event.status,
        errorType: event.errorType,
      })), [
        {
          attempt: 1,
          retryInMs: 100,
          cognitoType: errorCase.expectedCognitoType,
          status: errorCase.expectedStatus,
          errorType: errorCase.expectedErrorType,
        },
        {
          attempt: 2,
          retryInMs: 200,
          cognitoType: errorCase.expectedCognitoType,
          status: errorCase.expectedStatus,
          errorType: errorCase.expectedErrorType,
        },
      ], errorCase.label);
      assert.equal(JSON.stringify(events).includes(userId), false, errorCase.label);
      assert.equal(JSON.stringify(events).includes(userPoolId), false, errorCase.label);
    }
  });
});
