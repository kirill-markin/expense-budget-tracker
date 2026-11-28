/**
 * Cognito Identity Provider API client for passwordless Email OTP.
 *
 * Public app-client calls go to the Cognito IDP endpoint directly via fetch;
 * account creation uses IAM-signed admin calls through the AWS SDK.
 * Uses USER_AUTH flow with EMAIL_OTP challenge (Essentials tier).
 *
 * Auth-service scope: OTP sign-in plus browser-session refresh.
 * JWT verification stays in the OAuth session module.
 */
import { randomBytes } from "node:crypto";
import { getLocalizedSignInEmailCopy } from "@expense-budget-tracker/agent-shared/auth-email-copy";
import type { SupportedLocale } from "@expense-budget-tracker/agent-shared/locales";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  UsernameExistsException,
  type AdminCreateUserCommandInput,
  type AdminCreateUserCommandOutput,
  type AdminSetUserPasswordCommandInput,
  type AdminSetUserPasswordCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { getCognitoAdminClient } from "./cognitoAdminClient.js";
import { log, maskEmail, type CognitoRefreshRetryEvent } from "./logger.js";

type CognitoErrorResponse = Readonly<{
  type: string;
  message: string;
}>;

type CognitoRequestError = Error & Readonly<{
  cognitoType: string;
  cognitoStatus: number;
  cognitoTarget: string;
}>;

type InitiateAuthResult = Readonly<{
  session: string;
}>;

export type TokenResult = Readonly<{
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}>;

export type SessionRefreshResult = Readonly<{
  idToken: string;
  refreshToken: string | undefined;
}>;

type AgentIdentity = Readonly<{
  userId: string;
  email: string;
}>;

const getRegion = (): string => {
  const region = process.env.COGNITO_REGION ?? "";
  if (region === "") throw new Error("COGNITO_REGION is not configured");
  return region;
};

const getClientId = (): string => {
  const clientId = process.env.COGNITO_CLIENT_ID ?? "";
  if (clientId === "") throw new Error("COGNITO_CLIENT_ID is not configured");
  return clientId;
};

const parseCognitoErrorResponse = (payload: unknown): CognitoErrorResponse => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { type: "", message: "No Cognito error message" };
  }
  const record = payload as Readonly<Record<string, unknown>>;
  return {
    type: typeof record["__type"] === "string" ? record["__type"] : "",
    message: typeof record["message"] === "string" ? record["message"] : "No Cognito error message",
  };
};

const cognitoFetch = async (
  target: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const endpoint = `https://cognito-idp.${getRegion()}.amazonaws.com/`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw Object.assign(
        new Error(`Cognito ${target} failed with HTTP ${response.status} and an invalid JSON error response`, { cause }),
        { cognitoType: "", cognitoStatus: response.status, cognitoTarget: target },
      ) as CognitoRequestError;
    }
    const error = parseCognitoErrorResponse(payload);
    throw Object.assign(
      new Error(`Cognito ${target} failed with ${error.type || "an unknown error"} (HTTP ${response.status}): ${error.message}`),
      { cognitoType: error.type, cognitoStatus: response.status, cognitoTarget: target },
    ) as CognitoRequestError;
  }

  return response.json() as Promise<Record<string, unknown>>;
};

export type InitiateEmailOtpDependencies = Readonly<{
  request: (target: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  adminCreateUser: (input: AdminCreateUserCommandInput) => Promise<AdminCreateUserCommandOutput>;
  adminSetUserPassword: (input: AdminSetUserPasswordCommandInput) => Promise<AdminSetUserPasswordCommandOutput>;
}>;

const getUserPoolId = (): string => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  if (userPoolId === "") throw new Error("COGNITO_USER_POOL_ID is not configured");
  return userPoolId;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Self sign-up is off, so this is the only way an account comes into being.
 * The email counts as verified because the caller's next step proves inbox
 * ownership with an email code. The permanent random password, which nobody
 * learns, makes the user CONFIRMED instead of FORCE_CHANGE_PASSWORD.
 */
const createUser = async (email: string, dependencies: InitiateEmailOtpDependencies): Promise<void> => {
  const userPoolId = getUserPoolId();
  try {
    await dependencies.adminCreateUser({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      MessageAction: "SUPPRESS",
    });
  } catch (error) {
    // Concurrent request already created the user — safe to proceed
    if (error instanceof UsernameExistsException) return;
    throw new Error(
      `Cognito AdminCreateUser failed for ${maskEmail(email)}: ${describeError(error)}`,
      { cause: error },
    );
  }

  try {
    await dependencies.adminSetUserPassword({
      UserPoolId: userPoolId,
      Username: email,
      Password: randomBytes(48).toString("base64"),
      Permanent: true,
    });
  } catch (error) {
    throw new Error(
      `Cognito AdminSetUserPassword failed for ${maskEmail(email)} after AdminCreateUser created it, so the user stays FORCE_CHANGE_PASSWORD: ${describeError(error)}`,
      { cause: error },
    );
  }
};

const requireCognitoSession = (result: Record<string, unknown>, operation: string): string => {
  const session = result.Session;
  if (typeof session !== "string" || session === "") {
    throw new Error(`Cognito ${operation} did not return a session`);
  }
  return session;
};

export const initiateEmailOtpWithDependencies = async (
  email: string,
  localizedEmailLocale: SupportedLocale | null,
  dependencies: InitiateEmailOtpDependencies,
): Promise<InitiateAuthResult> => {
  const clientId = getClientId();

  const initiateAuth = async (): Promise<InitiateAuthResult> => {
    const result = await dependencies.request("InitiateAuth", {
      AuthFlow: "USER_AUTH",
      ClientId: clientId,
      AuthParameters: localizedEmailLocale === null
        ? { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" }
        : { USERNAME: email },
    });
    const session = requireCognitoSession(result, "InitiateAuth");
    if (localizedEmailLocale === null) return { session };

    if (!Array.isArray(result.AvailableChallenges) || !result.AvailableChallenges.includes("EMAIL_OTP")) {
      throw new Error("Cognito InitiateAuth did not offer the EMAIL_OTP challenge");
    }

    // CustomEmailSender_Authentication receives ClientMetadata from the challenge response.
    const otp = await dependencies.request("RespondToAuthChallenge", {
      ClientId: clientId,
      ChallengeName: "SELECT_CHALLENGE",
      Session: session,
      ChallengeResponses: { USERNAME: email, ANSWER: "EMAIL_OTP" },
      ClientMetadata: { locale: localizedEmailLocale },
    });
    if (otp.ChallengeName !== "EMAIL_OTP") {
      throw new Error("Cognito RespondToAuthChallenge did not return the EMAIL_OTP challenge");
    }
    return { session: requireCognitoSession(otp, "RespondToAuthChallenge") };
  };

  try {
    return await initiateAuth();
  } catch (err) {
    const cognitoType = (err as Error & { cognitoType?: string }).cognitoType;
    if (cognitoType !== "UserNotFoundException") throw err;
    await createUser(email, dependencies);
    return initiateAuth();
  }
};

const initiateEmailOtpDependencies: InitiateEmailOtpDependencies = {
  request: cognitoFetch,
  adminCreateUser: (input) => getCognitoAdminClient().send(new AdminCreateUserCommand(input)),
  adminSetUserPassword: (input) => getCognitoAdminClient().send(new AdminSetUserPasswordCommand(input)),
};

export const initiateEmailOtp = (email: string): Promise<InitiateAuthResult> =>
  initiateEmailOtpWithDependencies(email, null, initiateEmailOtpDependencies);

export const initiateBrowserEmailOtp = (email: string, locale: SupportedLocale | null): Promise<InitiateAuthResult> =>
  initiateEmailOtpWithDependencies(
    email,
    getLocalizedSignInEmailCopy(locale) === undefined ? null : locale,
    initiateEmailOtpDependencies,
  );

export const verifyEmailOtp = async (
  email: string,
  code: string,
  session: string,
): Promise<TokenResult> => {
  const result = await cognitoFetch("RespondToAuthChallenge", {
    ClientId: getClientId(),
    ChallengeName: "EMAIL_OTP",
    Session: session,
    ChallengeResponses: {
      USERNAME: email,
      EMAIL_OTP_CODE: code,
    },
  });

  const authResult = result.AuthenticationResult as Record<string, unknown> | undefined;
  if (authResult === undefined) {
    throw new Error("Cognito RespondToAuthChallenge did not return AuthenticationResult");
  }

  log({ domain: "auth", action: "verify_code", maskedEmail: maskEmail(email) });

  return {
    idToken: authResult.IdToken as string,
    accessToken: authResult.AccessToken as string,
    refreshToken: authResult.RefreshToken as string,
    expiresIn: authResult.ExpiresIn as number,
  };
};

export type RefreshCognitoSessionDependencies = Readonly<{
  request: (target: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  delay: (milliseconds: number) => Promise<void>;
  logRetry: (event: CognitoRefreshRetryEvent) => void;
}>;

const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 100;
const TRANSIENT_COGNITO_TYPES = new Set([
  "InternalErrorException",
  "InternalFailure",
  "LimitExceededException",
  "ServiceUnavailableException",
  "ThrottlingException",
  "TooManyRequestsException",
]);
const DEFINITIVE_REFRESH_REJECTION_TYPES = new Set([
  "InvalidRefreshTokenException",
  "NotAuthorizedException",
  "PasswordResetRequiredException",
  "RefreshTokenExpiredException",
  "RefreshTokenReuseException",
  "UserNotConfirmedException",
  "UserNotFoundException",
]);

const getCognitoErrorContext = (
  error: unknown,
): Readonly<{ cognitoType: string | null; status: number | null }> => {
  if (!(error instanceof Error)) return { cognitoType: null, status: null };
  const context = error as Partial<CognitoRequestError>;
  return {
    cognitoType: typeof context.cognitoType === "string" && context.cognitoType !== ""
      ? context.cognitoType
      : null,
    status: typeof context.cognitoStatus === "number" ? context.cognitoStatus : null,
  };
};

const getUnqualifiedCognitoType = (cognitoType: string): string =>
  cognitoType.split("#").at(-1)?.split(":").at(-1) ?? cognitoType;

export const isDefinitiveCognitoRefreshRejection = (error: unknown): boolean => {
  const { cognitoType } = getCognitoErrorContext(error);
  return cognitoType !== null
    && DEFINITIVE_REFRESH_REJECTION_TYPES.has(getUnqualifiedCognitoType(cognitoType));
};

const isTransientRefreshError = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  const { cognitoType, status } = getCognitoErrorContext(error);
  return status === 429
    || (status !== null && status >= 500 && status <= 599)
    || (cognitoType !== null && TRANSIENT_COGNITO_TYPES.has(getUnqualifiedCognitoType(cognitoType)));
};

const extractSessionRefreshResult = (result: Record<string, unknown>): SessionRefreshResult => {
  const authResult = result.AuthenticationResult;
  if (typeof authResult !== "object" || authResult === null || Array.isArray(authResult)) {
    throw new Error("Cognito GetTokensFromRefreshToken did not return AuthenticationResult");
  }
  const idToken = (authResult as Readonly<Record<string, unknown>>)["IdToken"];
  const rotatedRefreshToken = (authResult as Readonly<Record<string, unknown>>)["RefreshToken"];
  if (typeof idToken !== "string" || idToken === "") {
    throw new Error("Cognito GetTokensFromRefreshToken did not return an ID token");
  }
  if (rotatedRefreshToken !== undefined && typeof rotatedRefreshToken !== "string") {
    throw new Error("Cognito GetTokensFromRefreshToken returned an invalid refresh token");
  }
  return {
    idToken,
    refreshToken: rotatedRefreshToken === "" ? undefined : rotatedRefreshToken,
  };
};

export const refreshCognitoSessionWithDependencies = async (
  refreshToken: string,
  dependencies: RefreshCognitoSessionDependencies,
): Promise<SessionRefreshResult> => {
  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await dependencies.request("GetTokensFromRefreshToken", {
        RefreshToken: refreshToken,
        ClientId: getClientId(),
      });
      return extractSessionRefreshResult(result);
    } catch (error) {
      if (!isTransientRefreshError(error) || attempt === REFRESH_MAX_ATTEMPTS) throw error;
      const retryInMs = REFRESH_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      const context = getCognitoErrorContext(error);
      dependencies.logRetry({
        domain: "auth",
        action: "cognito_refresh_retry",
        level: "warn",
        attempt,
        retryInMs,
        cognitoType: context.cognitoType,
        status: context.status,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.delay(retryInMs);
    }
  }
  throw new Error("Cognito refresh retry loop ended without a result");
};

const refreshDependencies: RefreshCognitoSessionDependencies = {
  request: cognitoFetch,
  delay: async (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
  logRetry: log,
};

export const refreshCognitoSession = (refreshToken: string): Promise<SessionRefreshResult> =>
  refreshCognitoSessionWithDependencies(refreshToken, refreshDependencies);

/**
 * Read user identity from a Cognito IdToken received directly from Cognito.
 *
 * The token is trusted here because it comes from the HTTPS response of
 * RespondToAuthChallenge rather than from an untrusted client.
 */
/**
 * Password-based sign-in via the Cognito USER_AUTH flow with PASSWORD challenge.
 *
 * Used exclusively by the insecure demo email bypass for E2E tests.
 * The Cognito User Pool must have PASSWORD in AllowedFirstAuthFactors.
 */
export const signInWithPassword = async (
  email: string,
  password: string,
): Promise<TokenResult> => {
  const clientId = getClientId();

  const initialResult = await cognitoFetch("InitiateAuth", {
    AuthFlow: "USER_AUTH",
    ClientId: clientId,
    AuthParameters: {
      USERNAME: email,
      PREFERRED_CHALLENGE: "PASSWORD",
      PASSWORD: password,
    },
  });

  const authResult = initialResult.AuthenticationResult as Record<string, unknown> | undefined;
  if (authResult !== undefined) {
    return extractTokenResult(authResult);
  }

  const challengeName = initialResult.ChallengeName as string | undefined;
  const session = initialResult.Session as string | undefined;
  if (session === undefined || session === "") {
    throw new Error("Cognito InitiateAuth did not return a session");
  }

  let passwordSession = session;

  if (challengeName === "SELECT_CHALLENGE") {
    const selectResult = await cognitoFetch("RespondToAuthChallenge", {
      ClientId: clientId,
      ChallengeName: "SELECT_CHALLENGE",
      Session: session,
      ChallengeResponses: {
        USERNAME: email,
        ANSWER: "PASSWORD",
        PASSWORD: password,
      },
    });

    const selectAuth = selectResult.AuthenticationResult as Record<string, unknown> | undefined;
    if (selectAuth !== undefined) {
      return extractTokenResult(selectAuth);
    }

    const nextChallenge = selectResult.ChallengeName as string | undefined;
    const nextSession = selectResult.Session as string | undefined;
    if (nextChallenge !== "PASSWORD") {
      throw new Error(`Unexpected Cognito password challenge: ${nextChallenge}`);
    }
    if (nextSession === undefined || nextSession === "") {
      throw new Error("Cognito RespondToAuthChallenge did not return a session");
    }
    passwordSession = nextSession;
  } else if (challengeName !== "PASSWORD") {
    throw new Error(`Unexpected Cognito password challenge: ${challengeName}`);
  }

  const passwordResult = await cognitoFetch("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "PASSWORD",
    Session: passwordSession,
    ChallengeResponses: {
      USERNAME: email,
      PASSWORD: password,
    },
  });

  const finalAuth = passwordResult.AuthenticationResult as Record<string, unknown> | undefined;
  if (finalAuth === undefined) {
    throw new Error("Cognito RespondToAuthChallenge did not return AuthenticationResult");
  }

  return extractTokenResult(finalAuth);
};

const extractTokenResult = (authResult: Record<string, unknown>): TokenResult => ({
  idToken: authResult.IdToken as string,
  accessToken: authResult.AccessToken as string,
  refreshToken: authResult.RefreshToken as string,
  expiresIn: authResult.ExpiresIn as number,
});

export const extractIdentityFromIdToken = (idToken: string): AgentIdentity => {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid IdToken format");
  }

  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  const userId = payload.sub;
  const email = payload.email;

  if (typeof userId !== "string" || userId === "") {
    throw new Error("IdToken missing sub claim");
  }

  if (typeof email !== "string" || email === "") {
    throw new Error("IdToken missing email claim");
  }

  return { userId, email };
};
