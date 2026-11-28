import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidParameterException,
  UsernameExistsException,
  type AdminCreateUserCommandInput,
  type AdminSetUserPasswordCommandInput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  initiateBrowserEmailOtp,
  initiateEmailOtpWithDependencies,
  isDefinitiveCognitoRefreshRejection,
  refreshCognitoSessionWithDependencies,
  type InitiateEmailOtpDependencies,
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
  new Error(`Cognito GetTokensFromRefreshToken failed with ${cognitoType} (HTTP ${status})`),
  { cognitoType, cognitoStatus: status, cognitoTarget: "GetTokensFromRefreshToken" },
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
    const calls: Array<Readonly<{ target: string; body: Record<string, unknown> }>> = [];
    const delays: Array<number> = [];
    const events: Array<CognitoRefreshRetryEvent> = [];
    const dependencies: RefreshCognitoSessionDependencies = {
      request: async (target, body) => {
        requests += 1;
        calls.push({ target, body });
        if (requests === 1) throw new TypeError("fetch failed");
        return refreshedAuthenticationResult;
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
      logRetry: (event) => { events.push(event); },
    };

    const result = await refreshCognitoSessionWithDependencies("sensitive-refresh-token", dependencies);

    assert.deepEqual(result, { idToken: "fresh-id-token", refreshToken: "rotated-refresh-token" });
    assert.deepEqual(calls, [
      { target: "GetTokensFromRefreshToken", body: { RefreshToken: "sensitive-refresh-token", ClientId: "test-client-id" } },
      { target: "GetTokensFromRefreshToken", body: { RefreshToken: "sensitive-refresh-token", ClientId: "test-client-id" } },
    ]);
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

test("Cognito refresh treats a rotated-out refresh token as definitive", async (): Promise<void> => {
  await withCognitoClientId(async () => {
    let requests = 0;
    const delays: Array<number> = [];
    const events: Array<CognitoRefreshRetryEvent> = [];
    const reuse = cognitoError("RefreshTokenReuseException", 400);
    const dependencies: RefreshCognitoSessionDependencies = {
      request: async () => {
        requests += 1;
        throw reuse;
      },
      delay: async (milliseconds) => { delays.push(milliseconds); },
      logRetry: (event) => { events.push(event); },
    };

    await assert.rejects(
      refreshCognitoSessionWithDependencies("rotated-out-refresh-token", dependencies),
      (error: unknown) => error === reuse,
    );
    assert.equal(isDefinitiveCognitoRefreshRejection(reuse), true);
    assert.equal(requests, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(events, []);
  });
});

test("Cognito refresh keeps the submitted token when the response omits a rotated one", async (): Promise<void> => {
  await withCognitoClientId(async () => {
    const dependencies: RefreshCognitoSessionDependencies = {
      request: async () => ({ AuthenticationResult: { IdToken: "fresh-id-token" } }),
      delay: async () => { throw new Error("unexpected retry delay"); },
      logRetry: () => { throw new Error("unexpected retry log"); },
    };

    const result = await refreshCognitoSessionWithDependencies("non-rotating-refresh-token", dependencies);

    assert.deepEqual(result, { idToken: "fresh-id-token", refreshToken: undefined });
  });
});

const withCognitoUserPool = async (operation: () => Promise<void>): Promise<void> => {
  const previous = process.env.COGNITO_USER_POOL_ID;
  process.env.COGNITO_USER_POOL_ID = "eu-west-1_pool";
  try {
    await withCognitoClientId(operation);
  } finally {
    if (previous === undefined) delete process.env.COGNITO_USER_POOL_ID;
    else process.env.COGNITO_USER_POOL_ID = previous;
  }
};

type InitiateEmailOtpCalls = Readonly<{
  targets: Array<string>;
  creates: Array<AdminCreateUserCommandInput>;
  passwords: Array<AdminSetUserPasswordCommandInput>;
}>;

/** InitiateAuth reports the user missing once, then returns a session. */
const createInitiateEmailOtpDependencies = (
  calls: InitiateEmailOtpCalls,
  createError: Error | null,
  setPasswordError: Error | null,
): InitiateEmailOtpDependencies => ({
  request: async (target) => {
    calls.targets.push(target);
    if (calls.targets.length === 1) throw cognitoError("UserNotFoundException", 400);
    return { Session: "otp-session" };
  },
  adminCreateUser: async (input) => {
    calls.creates.push(input);
    if (createError !== null) throw createError;
    return { $metadata: {} };
  },
  adminSetUserPassword: async (input) => {
    calls.passwords.push(input);
    if (setPasswordError !== null) throw setPasswordError;
    return { $metadata: {} };
  },
});

test("email OTP creates a missing user as confirmed and verified, then initiates sign-in", async (): Promise<void> => {
  await withCognitoUserPool(async () => {
    const calls: InitiateEmailOtpCalls = { targets: [], creates: [], passwords: [] };

    const result = await initiateEmailOtpWithDependencies(
      "new@example.com",
      null,
      createInitiateEmailOtpDependencies(calls, null, null),
    );

    assert.deepEqual(result, { session: "otp-session" });
    assert.deepEqual(calls.targets, ["InitiateAuth", "InitiateAuth"]);
    assert.deepEqual(calls.creates, [{
      UserPoolId: "eu-west-1_pool",
      Username: "new@example.com",
      UserAttributes: [
        { Name: "email", Value: "new@example.com" },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
    }]);
    assert.equal(calls.passwords.length, 1);
    const [password] = calls.passwords;
    assert.equal(password?.UserPoolId, "eu-west-1_pool");
    assert.equal(password?.Username, "new@example.com");
    assert.equal(password?.Permanent, true);
    assert.equal(password?.Password?.length, 64);
  });
});

test("email OTP proceeds when a concurrent request already created the user", async (): Promise<void> => {
  await withCognitoUserPool(async () => {
    const calls: InitiateEmailOtpCalls = { targets: [], creates: [], passwords: [] };
    const exists = new UsernameExistsException({
      $metadata: { httpStatusCode: 400 },
      message: "An account with the given email already exists.",
    });

    const result = await initiateEmailOtpWithDependencies(
      "race@example.com",
      null,
      createInitiateEmailOtpDependencies(calls, exists, null),
    );

    assert.deepEqual(result, { session: "otp-session" });
    assert.deepEqual(calls.targets, ["InitiateAuth", "InitiateAuth"]);
    assert.equal(calls.creates.length, 1);
    assert.deepEqual(calls.passwords, []);
  });
});

test("email OTP raises any other user creation failure without initiating sign-in", async (): Promise<void> => {
  await withCognitoUserPool(async () => {
    const calls: InitiateEmailOtpCalls = { targets: [], creates: [], passwords: [] };
    const invalid = new InvalidParameterException({
      $metadata: { httpStatusCode: 400 },
      message: "Invalid email address format.",
    });

    await assert.rejects(
      initiateEmailOtpWithDependencies("bad@example.com", null, createInitiateEmailOtpDependencies(calls, invalid, null)),
      (error: unknown) => error instanceof Error
        && error.cause === invalid
        && error.message === "Cognito AdminCreateUser failed for b***@example.com: InvalidParameterException: Invalid email address format.",
    );
    assert.deepEqual(calls.targets, ["InitiateAuth"]);
    assert.deepEqual(calls.passwords, []);
  });
});

test("email OTP raises when the created user cannot get a permanent password", async (): Promise<void> => {
  await withCognitoUserPool(async () => {
    const calls: InitiateEmailOtpCalls = { targets: [], creates: [], passwords: [] };
    const failure = new InvalidParameterException({
      $metadata: { httpStatusCode: 400 },
      message: "Password does not conform to policy.",
    });

    await assert.rejects(
      initiateEmailOtpWithDependencies("new@example.com", null, createInitiateEmailOtpDependencies(calls, null, failure)),
      (error: unknown) => error instanceof Error
        && error.cause === failure
        && error.message.startsWith("Cognito AdminSetUserPassword failed for n***@example.com after AdminCreateUser"),
    );
    assert.deepEqual(calls.targets, ["InitiateAuth"]);
    assert.equal(calls.creates.length, 1);
  });
});

test("localized OTP retries for a missing user and returns the session from EMAIL_OTP selection", async (): Promise<void> => {
  await withCognitoUserPool(async () => {
    const calls: InitiateEmailOtpCalls = { targets: [], creates: [], passwords: [] };
    const requests: Array<Readonly<{ target: string; body: Record<string, unknown> }>> = [];
    const dependencies = createInitiateEmailOtpDependencies(calls, null, null);
    const result = await initiateEmailOtpWithDependencies("new@example.com", "es", {
      ...dependencies,
      request: async (target, body) => {
        requests.push({ target, body });
        if (requests.length === 1) throw cognitoError("UserNotFoundException", 400);
        if (target === "InitiateAuth") {
          return { Session: "choice-session", AvailableChallenges: ["PASSWORD", "EMAIL_OTP"] };
        }
        return { ChallengeName: "EMAIL_OTP", Session: "otp-session" };
      },
    });

    const initiateRequest = {
      target: "InitiateAuth",
      body: {
        AuthFlow: "USER_AUTH",
        ClientId: "test-client-id",
        AuthParameters: { USERNAME: "new@example.com" },
      },
    };

    assert.deepEqual(requests, [
      initiateRequest,
      initiateRequest,
      {
        target: "RespondToAuthChallenge",
        body: {
          ClientId: "test-client-id",
          ChallengeName: "SELECT_CHALLENGE",
          Session: "choice-session",
          ChallengeResponses: { USERNAME: "new@example.com", ANSWER: "EMAIL_OTP" },
          ClientMetadata: { locale: "es" },
        },
      },
    ]);
    assert.deepEqual(result, { session: "otp-session" });
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.passwords.length, 1);
  });
});

test("localized OTP rejects a response that has a session for a different challenge", async (): Promise<void> => {
  await withCognitoClientId(async () => {
    const calls: InitiateEmailOtpCalls = { targets: [], creates: [], passwords: [] };
    await assert.rejects(
      initiateEmailOtpWithDependencies("existing@example.com", "es", {
        ...createInitiateEmailOtpDependencies(calls, null, null),
        request: async (target) => target === "InitiateAuth"
          ? { Session: "choice-session", AvailableChallenges: ["PASSWORD", "EMAIL_OTP"] }
          : { ChallengeName: "PASSWORD", Session: "password-session" },
      }),
      /Cognito RespondToAuthChallenge did not return the EMAIL_OTP challenge/u,
    );
    assert.deepEqual(calls.creates, []);
  });
});

test("browser OTP with English copy uses the direct challenge without metadata", async (t): Promise<void> => {
  const previousRegion = process.env.COGNITO_REGION;
  process.env.COGNITO_REGION = "eu-west-1";
  t.after(() => {
    if (previousRegion === undefined) delete process.env.COGNITO_REGION;
    else process.env.COGNITO_REGION = previousRegion;
  });

  const requests = t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.equal(new Headers(options?.headers).get("X-Amz-Target"), "AWSCognitoIdentityProviderService.InitiateAuth");
    const body = options?.body;
    assert(typeof body === "string");
    assert.deepEqual(JSON.parse(body), {
      AuthFlow: "USER_AUTH",
      ClientId: "test-client-id",
      AuthParameters: { USERNAME: "existing@example.com", PREFERRED_CHALLENGE: "EMAIL_OTP" },
    });
    return Response.json({ ChallengeName: "EMAIL_OTP", Session: "otp-session" });
  });

  await withCognitoClientId(async () => {
    assert.deepEqual(await initiateBrowserEmailOtp("existing@example.com", "en"), { session: "otp-session" });
  });
  assert.equal(requests.mock.callCount(), 1);
});
