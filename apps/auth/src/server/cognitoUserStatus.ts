import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  CognitoIdentityProviderServiceException,
  UserNotFoundException,
  UserStatusType,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  getSafeErrorType,
  log,
  type CognitoOAuthOwnerRetryEvent,
} from "./logger.js";

const RETRY_DELAYS_MS = [100, 200] as const;
const TRANSIENT_COGNITO_ERROR_NAMES = new Set([
  "LimitExceededException",
  "RequestLimitExceeded",
  "ServiceUnavailableException",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);
const TRANSIENT_ERROR_NAMES = new Set([
  "ConnectionError",
  "RequestTimeout",
  "RequestTimeoutException",
  "TimeoutError",
]);
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
const USER_STATUSES = new Set<string>(Object.values(UserStatusType));

export type CognitoOAuthOwnerStatus = "active" | "inactive";

export type CognitoUserStatusDependencies = Readonly<{
  adminGetUser: (userPoolId: string, userId: string) => Promise<AdminGetUserCommandOutput>;
  wait: (delayMs: number) => Promise<void>;
  logRetry: (event: CognitoOAuthOwnerRetryEvent) => void;
}>;

type ErrorWithCode = Error & Readonly<{ code: string }>;

const hasErrorCode = (error: Error): error is ErrorWithCode =>
  typeof (error as Partial<ErrorWithCode>).code === "string";

const isTransientCognitoError = (error: unknown): boolean => {
  if (error instanceof CognitoIdentityProviderServiceException) {
    const status = error.$metadata.httpStatusCode;
    return error.$fault === "server"
      || TRANSIENT_COGNITO_ERROR_NAMES.has(error.name)
      || TRANSIENT_ERROR_NAMES.has(error.name)
      || status === 429
      || (status !== undefined && status >= 500);
  }
  return error instanceof TypeError
    || (
      error instanceof Error
      && (
        TRANSIENT_ERROR_NAMES.has(error.name)
        || (hasErrorCode(error) && TRANSIENT_NETWORK_ERROR_CODES.has(error.code))
      )
    );
};

const createRetryEvent = (
  error: unknown,
  attempt: number,
  retryInMs: number,
): CognitoOAuthOwnerRetryEvent => ({
  domain: "auth",
  action: "cognito_oauth_owner_retry",
  level: "warn",
  attempt,
  retryInMs,
  cognitoType: error instanceof CognitoIdentityProviderServiceException ? error.name : null,
  status: error instanceof CognitoIdentityProviderServiceException
    ? error.$metadata.httpStatusCode ?? null
    : null,
  errorType: getSafeErrorType(error),
});

const parseCognitoOAuthOwnerStatus = (
  response: AdminGetUserCommandOutput,
): CognitoOAuthOwnerStatus => {
  if (typeof response.Enabled !== "boolean") {
    throw new Error("Cognito AdminGetUser response is missing a boolean Enabled value");
  }
  if (typeof response.UserStatus !== "string" || !USER_STATUSES.has(response.UserStatus)) {
    throw new Error("Cognito AdminGetUser response has an invalid UserStatus value");
  }
  return response.Enabled && response.UserStatus === UserStatusType.CONFIRMED
    ? "active"
    : "inactive";
};

export const getCognitoOAuthOwnerStatusWithDependencies = async (
  userId: string,
  dependencies: CognitoUserStatusDependencies,
): Promise<CognitoOAuthOwnerStatus> => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  if (userPoolId === "") {
    throw new Error("Cognito OAuth owner validation requires COGNITO_USER_POOL_ID");
  }

  const maximumAttempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await dependencies.adminGetUser(userPoolId, userId);
      return parseCognitoOAuthOwnerStatus(response);
    } catch (error) {
      if (error instanceof UserNotFoundException) return "inactive";
      const retryInMs = RETRY_DELAYS_MS[attempt - 1];
      if (!isTransientCognitoError(error) || retryInMs === undefined) throw error;
      dependencies.logRetry(createRetryEvent(error, attempt, retryInMs));
      await dependencies.wait(retryInMs);
    }
  }
  throw new Error("Cognito OAuth owner validation retry loop ended without a result");
};

let client: CognitoIdentityProviderClient | undefined;

const getClient = (): CognitoIdentityProviderClient => {
  if (client !== undefined) return client;
  const region = process.env.COGNITO_REGION ?? "";
  if (region === "") {
    throw new Error("Cognito OAuth owner validation requires COGNITO_REGION");
  }
  client = new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
  return client;
};

const adminGetUser = (
  userPoolId: string,
  userId: string,
): Promise<AdminGetUserCommandOutput> => getClient().send(new AdminGetUserCommand({
  UserPoolId: userPoolId,
  Username: userId,
}));

const dependencies: CognitoUserStatusDependencies = {
  adminGetUser,
  wait: (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  logRetry: log,
};

export const getCognitoOAuthOwnerStatus = (
  userId: string,
): Promise<CognitoOAuthOwnerStatus> =>
  getCognitoOAuthOwnerStatusWithDependencies(userId, dependencies);
