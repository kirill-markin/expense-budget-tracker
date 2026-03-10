/**
 * Cognito Identity Provider API client for passwordless Email OTP.
 *
 * Calls the Cognito IDP endpoint directly via fetch — no AWS SDK needed.
 * Uses USER_AUTH flow with EMAIL_OTP challenge (Essentials tier).
 *
 * Auth-service scope: only initiateEmailOtp and verifyEmailOtp.
 * JWT verification and token refresh stay in the web app.
 */
import { randomBytes } from "node:crypto";
import { log, maskEmail } from "./logger.js";

type CognitoErrorResponse = Readonly<{
  __type?: string;
  message?: string;
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
    const error = await response.json() as CognitoErrorResponse;
    const errorType = error.__type ?? "";
    const errorMessage = error.message ?? `Cognito ${target} failed: ${response.status}`;
    const err = new Error(errorMessage);
    (err as Error & { cognitoType: string }).cognitoType = errorType;
    throw err;
  }

  return response.json() as Promise<Record<string, unknown>>;
};

const signUpUser = async (email: string): Promise<void> => {
  await cognitoFetch("SignUp", {
    ClientId: getClientId(),
    Username: email,
    Password: randomBytes(48).toString("base64"),
    UserAttributes: [{ Name: "email", Value: email }],
  });
};

export const initiateEmailOtp = async (email: string): Promise<InitiateAuthResult> => {
  const clientId = getClientId();

  const initiateAuth = async (): Promise<Record<string, unknown>> =>
    cognitoFetch("InitiateAuth", {
      AuthFlow: "USER_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PREFERRED_CHALLENGE: "EMAIL_OTP",
      },
    });

  let result: Record<string, unknown>;
  try {
    result = await initiateAuth();
  } catch (err) {
    const cognitoType = (err as Error & { cognitoType?: string }).cognitoType;
    if (cognitoType === "UserNotFoundException") {
      try {
        await signUpUser(email);
      } catch (signUpErr) {
        // Concurrent request already created the user — safe to proceed
        const signUpType = (signUpErr as Error & { cognitoType?: string }).cognitoType;
        if (signUpType !== "UsernameExistsException") throw signUpErr;
      }
      result = await initiateAuth();
    } else {
      throw err;
    }
  }

  const session = result.Session as string | undefined;
  if (session === undefined || session === "") {
    throw new Error("Cognito InitiateAuth did not return a session");
  }

  return { session };
};

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

/**
 * Read user identity from a Cognito IdToken received directly from Cognito.
 *
 * The token is trusted here because it comes from the HTTPS response of
 * RespondToAuthChallenge rather than from an untrusted client.
 */
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
