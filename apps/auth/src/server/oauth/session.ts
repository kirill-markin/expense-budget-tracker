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
import {
  createProxyJwtAuthenticatorFromEnv,
  extractProxyJwtToken,
  type ProxyJwtAuthenticator,
} from "@expense-budget-tracker/agent-shared/proxy-jwt";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getAuthServiceMode } from "../authMode.js";
import { log, type ProxyIdentityRejectedEvent } from "../logger.js";
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

let proxyJwtAuthenticator: ProxyJwtAuthenticator | undefined;

/** Built once per process, so the verifier's JWKS is fetched and cached once. */
const getProxyJwtAuthenticator = (): ProxyJwtAuthenticator => {
  if (proxyJwtAuthenticator === undefined) {
    proxyJwtAuthenticator = createProxyJwtAuthenticatorFromEnv(process.env);
  }
  return proxyJwtAuthenticator;
};

export type ProxyJwtSessionDependencies = Readonly<{
  getProxyJwtAuthenticator: () => ProxyJwtAuthenticator;
  log: (event: ProxyIdentityRejectedEvent) => void;
}>;

/**
 * AUTH_MODE=proxy_jwt identity resolution. The edge token is the only identity
 * source: no cookie is read and Cognito is never called. An absent, expired, or
 * otherwise rejected token resolves to null, exactly like an absent session, so
 * the caller decides how an unauthenticated browser is answered.
 *
 * This resolver completes identity resolution only. Whether the resolved owner
 * may then receive OAuth credentials is decided by the mode-selected policy in
 * ./owner.ts, which reads the local identity mirror in this mode.
 */
export const resolveProxyJwtSessionWithDependencies = async (
  c: Context,
  dependencies: ProxyJwtSessionDependencies,
): Promise<BrowserIdentity | null> => {
  const authenticator = dependencies.getProxyJwtAuthenticator();
  try {
    const token = extractProxyJwtToken(c.req.raw.headers, authenticator.headerName);
    const { userId, email } = await authenticator.verify(token);
    return { userId, email };
  } catch (error) {
    dependencies.log({
      domain: "auth",
      action: "proxy_identity_rejected",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const defaultProxyJwtDependencies: ProxyJwtSessionDependencies = {
  getProxyJwtAuthenticator,
  log,
};

export const resolveBrowserSession = (c: Context): Promise<BrowserIdentity | null> =>
  getAuthServiceMode(process.env) === "proxy_jwt"
    ? resolveProxyJwtSessionWithDependencies(c, defaultProxyJwtDependencies)
    : resolveBrowserSessionWithDependencies(c, defaultDependencies);
