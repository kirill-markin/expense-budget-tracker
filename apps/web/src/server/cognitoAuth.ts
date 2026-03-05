/**
 * Cognito JWT verification and token management for the web app.
 *
 * OTP initiation and verification have moved to the auth service (apps/auth/).
 * This module keeps only what the web app needs:
 * - JWT verification (proxy.ts, session validation)
 * - Token refresh (refresh endpoint)
 * - Token revocation (logout endpoint)
 */
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { log } from "@/server/logger";

type CognitoErrorResponse = Readonly<{
  __type?: string;
  message?: string;
}>;

type RefreshResult = Readonly<{
  idToken: string;
  accessToken: string;
  expiresIn: number;
  refreshToken: string | undefined;
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

// --- JWT verification ---

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

export const getJwtVerifier = (): ReturnType<typeof CognitoJwtVerifier.create> => {
  if (verifier !== undefined) return verifier;
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  const clientId = getClientId();
  if (userPoolId === "") {
    throw new Error("JWT verification misconfigured: COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required");
  }
  verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId });
  return verifier;
};

/**
 * Revoke a refresh token server-side so it can no longer be exchanged for new
 * access/id tokens. Best-effort: logs and swallows errors so logout is never
 * blocked by a Cognito outage.
 */
export const revokeRefreshToken = async (token: string): Promise<void> => {
  try {
    await cognitoFetch("RevokeToken", {
      Token: token,
      ClientId: getClientId(),
    });
  } catch (err) {
    log({ domain: "auth", action: "error", error: `RevokeToken failed: ${err instanceof Error ? err.message : String(err)}` });
  }
};

export const refreshTokens = async (refreshToken: string): Promise<RefreshResult> => {
  const result = await cognitoFetch("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: getClientId(),
    AuthParameters: {
      REFRESH_TOKEN: refreshToken,
    },
  });

  const authResult = result.AuthenticationResult as Record<string, unknown> | undefined;
  if (authResult === undefined) {
    throw new Error("Cognito REFRESH_TOKEN_AUTH did not return AuthenticationResult");
  }

  const newRefreshToken = authResult.RefreshToken as string | undefined;

  return {
    idToken: authResult.IdToken as string,
    accessToken: authResult.AccessToken as string,
    expiresIn: authResult.ExpiresIn as number,
    refreshToken: newRefreshToken !== undefined && newRefreshToken !== "" ? newRefreshToken : undefined,
  };
};
