import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  JwtExpiredError,
  JwtInvalidClaimError,
  JwtInvalidSignatureError,
  JwtInvalidSignatureAlgorithmError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
} from "aws-jwt-verify/error";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  isDefinitiveCognitoRefreshRejection,
  refreshCognitoSession,
  type SessionRefreshResult,
} from "../cognitoAuth.js";

export type BrowserIdentity = Readonly<{ userId: string; email: string }>;

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

const getVerifier = (): ReturnType<typeof CognitoJwtVerifier.create> => {
  if (verifier !== undefined) return verifier;
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  const clientId = process.env.COGNITO_CLIENT_ID ?? "";
  if (userPoolId === "" || clientId === "") {
    throw new Error("Browser session verification requires COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID");
  }
  verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId });
  return verifier;
};

type InvalidSessionClaimsError = Error & Readonly<{ invalidSessionClaims: true }>;

export const readBrowserIdentityClaims = (payload: unknown): BrowserIdentity => {
  const claims = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : {};
  const userId = claims["sub"];
  const email = claims["email"];
  if (
    typeof userId !== "string"
    || userId === ""
    || typeof email !== "string"
    || email === ""
    || claims["email_verified"] !== true
  ) {
    throw Object.assign(new Error("Cognito session is missing verified identity claims"), {
      invalidSessionClaims: true,
    }) as InvalidSessionClaimsError;
  }
  return { userId, email };
};

export const verifyBrowserSession = async (token: string): Promise<BrowserIdentity> =>
  readBrowserIdentityClaims(await getVerifier().verify(token));

export const isExpiredBrowserSessionError = (error: unknown): boolean => error instanceof JwtExpiredError;

export const isInvalidBrowserSessionError = (error: unknown): boolean => {
  if (isExpiredBrowserSessionError(error)) return false;
  return error instanceof JwtParseError
  || error instanceof JwtInvalidSignatureError
  || error instanceof JwtInvalidSignatureAlgorithmError
  || error instanceof JwtInvalidClaimError
  || error instanceof JwtWithoutValidKidError
  || error instanceof KidNotFoundInJwksError
  || (error instanceof Error && (error as Partial<InvalidSessionClaimsError>).invalidSessionClaims === true);
};

export const clearBrowserSessionCookies = (c: Context): void => {
  const configuredDomain = process.env.COOKIE_DOMAIN ?? "";
  const domain = configuredDomain === "" ? undefined : configuredDomain;
  for (const name of ["session", "refresh", "logged_in"] as const) {
    deleteCookie(c, name, { path: "/", secure: true, domain });
  }
};

export type BrowserSessionDependencies = Readonly<{
  verifyBrowserSession: typeof verifyBrowserSession;
  refreshCognitoSession: typeof refreshCognitoSession;
  isDefinitiveCognitoRefreshRejection: typeof isDefinitiveCognitoRefreshRejection;
  isExpiredBrowserSessionError: typeof isExpiredBrowserSessionError;
  isInvalidBrowserSessionError: typeof isInvalidBrowserSessionError;
  clearBrowserSessionCookies: typeof clearBrowserSessionCookies;
}>;

const setRefreshedBrowserSessionCookies = (
  c: Context,
  tokens: SessionRefreshResult,
): void => {
  const configuredDomain = process.env.COOKIE_DOMAIN ?? "";
  const domain = configuredDomain === "" ? undefined : configuredDomain;
  const protectedCookie = {
    path: "/",
    maxAge: 3024000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    domain,
  };
  setCookie(c, "session", tokens.idToken, protectedCookie);
  if (tokens.refreshToken !== undefined) setCookie(c, "refresh", tokens.refreshToken, protectedCookie);
  setCookie(c, "logged_in", "1", { ...protectedCookie, httpOnly: false });
};

export const resolveBrowserSessionWithDependencies = async (
  c: Context,
  dependencies: BrowserSessionDependencies,
): Promise<BrowserIdentity | null> => {
  const sessionToken = getCookie(c, "session") ?? "";
  if (sessionToken === "") return null;
  try {
    return await dependencies.verifyBrowserSession(sessionToken);
  } catch (error) {
    if (!dependencies.isExpiredBrowserSessionError(error)) {
      if (!dependencies.isInvalidBrowserSessionError(error)) throw error;
      dependencies.clearBrowserSessionCookies(c);
      return null;
    }
  }

  const refreshToken = getCookie(c, "refresh") ?? "";
  if (refreshToken === "") {
    dependencies.clearBrowserSessionCookies(c);
    return null;
  }
  let refreshedTokens: SessionRefreshResult;
  try {
    refreshedTokens = await dependencies.refreshCognitoSession(refreshToken);
  } catch (error) {
    if (!dependencies.isDefinitiveCognitoRefreshRejection(error)) throw error;
    dependencies.clearBrowserSessionCookies(c);
    return null;
  }
  try {
    const identity = await dependencies.verifyBrowserSession(refreshedTokens.idToken);
    setRefreshedBrowserSessionCookies(c, refreshedTokens);
    return identity;
  } catch (error) {
    if (
      !dependencies.isExpiredBrowserSessionError(error)
      && !dependencies.isInvalidBrowserSessionError(error)
    ) {
      throw error;
    }
    dependencies.clearBrowserSessionCookies(c);
    return null;
  }
};

const defaultDependencies: BrowserSessionDependencies = {
  verifyBrowserSession,
  refreshCognitoSession,
  isDefinitiveCognitoRefreshRejection,
  isExpiredBrowserSessionError,
  isInvalidBrowserSessionError,
  clearBrowserSessionCookies,
};

export const resolveBrowserSession = (c: Context): Promise<BrowserIdentity | null> =>
  resolveBrowserSessionWithDependencies(c, defaultDependencies);
