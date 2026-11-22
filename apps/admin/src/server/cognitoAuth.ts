/**
 * Cognito session handling for the admin app: ID token verification, inline
 * refresh, and cookie headers. The `session` and `refresh` cookies are shared
 * with the main web app through COOKIE_DOMAIN, so every attribute here must
 * match apps/web (proxy.ts and cookies.ts); a refresh on this host then keeps
 * the main app signed in too.
 */
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { CognitoAuthConfig } from "@/server/config";

const SESSION_COOKIE_MAX_AGE_SECONDS = 3024000;
const SESSION_COOKIE_NAMES: ReadonlyArray<string> = ["session", "refresh"];

type CognitoErrorResponse = Readonly<{
  __type?: string;
  message?: string;
}>;

export type RefreshResult = Readonly<{
  idToken: string;
  refreshToken: string | undefined;
}>;

const cognitoFetch = async (
  config: CognitoAuthConfig,
  target: string,
  body: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`https://cognito-idp.${config.cognitoRegion}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json() as CognitoErrorResponse;
    throw new Error(
      `Cognito ${target} failed: status=${response.status} type=${error.__type ?? ""} message=${error.message ?? ""}`,
    );
  }

  return response.json() as Promise<Record<string, unknown>>;
};

const createIdTokenVerifier = (config: CognitoAuthConfig) => CognitoJwtVerifier.create({
  userPoolId: config.cognitoUserPoolId,
  tokenUse: "id",
  clientId: config.cognitoClientId,
});

type IdTokenVerifier = ReturnType<typeof createIdTokenVerifier>;

let verifier: IdTokenVerifier | undefined;

export const getJwtVerifier = (config: CognitoAuthConfig): IdTokenVerifier => {
  if (verifier === undefined) {
    verifier = createIdTokenVerifier(config);
  }
  return verifier;
};

export const refreshTokens = async (config: CognitoAuthConfig, refreshToken: string): Promise<RefreshResult> => {
  const result = await cognitoFetch(config, "GetTokensFromRefreshToken", {
    RefreshToken: refreshToken,
    ClientId: config.cognitoClientId,
  });

  const authResult = result.AuthenticationResult;
  if (typeof authResult !== "object" || authResult === null) {
    throw new Error("Cognito GetTokensFromRefreshToken did not return AuthenticationResult");
  }
  const { IdToken: idToken, RefreshToken: newRefreshToken } = authResult as Record<string, unknown>;
  if (typeof idToken !== "string" || idToken === "") {
    throw new Error("Cognito GetTokensFromRefreshToken returned no IdToken");
  }
  return {
    idToken,
    refreshToken: typeof newRefreshToken === "string" && newRefreshToken !== "" ? newRefreshToken : undefined,
  };
};

export const buildSessionCookieHeaders = (config: CognitoAuthConfig, tokens: RefreshResult): ReadonlyArray<string> => {
  const domainAttr = `; Domain=${config.cookieDomain}`;
  const buildHttpOnly = (name: string, value: string): string =>
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax${domainAttr}`;
  return [
    buildHttpOnly("session", tokens.idToken),
    ...(tokens.refreshToken === undefined ? [] : [buildHttpOnly("refresh", tokens.refreshToken)]),
    // UI indicator the main app reads from script, so it is not HttpOnly.
    `logged_in=1; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; Secure; SameSite=Lax${domainAttr}`,
  ];
};

export const buildClearedSessionCookieHeaders = (config: CognitoAuthConfig): ReadonlyArray<string> => {
  const domainAttr = `; Domain=${config.cookieDomain}`;
  return [
    ...SESSION_COOKIE_NAMES.map((name: string): string =>
      `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax${domainAttr}`),
    `logged_in=; Path=/; Max-Age=0; Secure; SameSite=Lax${domainAttr}`,
  ];
};
