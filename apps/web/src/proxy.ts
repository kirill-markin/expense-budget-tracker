/**
 * Next.js proxy: auth gate, user identity extraction, CSRF check, security headers.
 * (Renamed from middleware.ts — the "middleware" convention was deprecated in Next.js 16.)
 *
 * AUTH_MODE=none    — all requests pass; userId is hardcoded to 'local'.
 * AUTH_MODE=cognito — reads IdToken from `session` cookie, verifies via CognitoJwtVerifier,
 *                     extracts the `sub` claim as userId. Unauthenticated users are
 *                     redirected to the auth service (auth.*) for login.
 *                     Expired tokens are refreshed inline (no GET redirect).
 *
 * The resolved userId is forwarded as x-user-id and x-workspace-id headers to all
 * downstream route handlers. /api/live and /api/health are always exempt from auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { JwtExpiredError } from "aws-jwt-verify/error";
import { getJwtVerifier, refreshTokens } from "@/server/cognitoAuth";
import { hasApiKeyAuthorization } from "@/server/authHeader";
import { log } from "@/server/logger";
import { clearAuthCookies } from "@/server/cookies";
import { LOCAL_USER_EMAIL } from "@/server/users";

type AuthMode = "none" | "cognito";

const LOCAL_USER_ID = "local";
const LOCAL_WORKSPACE_ID = "local";
const USER_ID_HEADER = "x-user-id";
const WORKSPACE_ID_HEADER = "x-workspace-id";
const USER_EMAIL_HEADER = "x-user-email";
const USER_EMAIL_VERIFIED_HEADER = "x-user-email-verified";
const CSRF_COOKIE_NAME = "__Host-csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CSRF_TOKEN_RE = /^[0-9a-f]{64}$/;

const PUBLIC_PATHS: ReadonlyArray<string> = [
  "/api/auth/logout",
  "/api/live",
  "/api/health",
];

const getAuthDomain = (): string => {
  const domain = process.env.AUTH_DOMAIN ?? "";
  if (domain === "") throw new Error("AUTH_DOMAIN is not configured");
  return domain;
};

const buildAuthRedirectUrl = (request: NextRequest): URL => {
  const authDomain = getAuthDomain();
  const corsOrigin = process.env.CORS_ORIGIN ?? request.nextUrl.origin;
  const protocol = corsOrigin.startsWith("https://") ? "https" : "http";
  const loginUrl = new URL(`${protocol}://${authDomain}/login`);
  const returnPath = request.nextUrl.pathname + request.nextUrl.search;
  const redirectUri = returnPath !== "/" ? `${corsOrigin}${returnPath}` : corsOrigin;
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  return loginUrl;
};

const getAuthMode = (): AuthMode => {
  const raw = process.env.AUTH_MODE ?? "none";
  if (raw === "none") return raw;
  if (raw === "cognito") {
    if ((process.env.CORS_ORIGIN ?? "") === "") {
      throw new Error("CORS_ORIGIN must be set when AUTH_MODE=cognito");
    }
    return raw;
  }
  throw new Error(`Invalid AUTH_MODE: ${raw}. Expected "none" or "cognito"`);
};

const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-DNS-Prefetch-Control", "off"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
];

const buildCsp = (nonce: string): string => {
  const isDev = process.env.NODE_ENV === "development";
  const origin = process.env.CORS_ORIGIN ?? "";
  const directives: Array<string> = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];
  if (origin.startsWith("https://")) {
    directives.push("upgrade-insecure-requests");
  }
  return directives.join("; ");
};

const addSecurityHeaders = (response: NextResponse, nonce: string, csp?: string): void => {
  for (const [key, value] of SECURITY_HEADERS) {
    response.headers.set(key, value);
  }
  const origin = process.env.CORS_ORIGIN ?? "";
  if (origin.startsWith("https://")) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  response.headers.set("Content-Security-Policy", csp ?? buildCsp(nonce));
};

/**
 * CSRF check for mutating requests (POST/PUT/DELETE/PATCH).
 *
 * Defence layers (checked in order, per OWASP CSRF Prevention Cheat Sheet):
 *   1. Sec-Fetch-Site — "cross-site" is always blocked.
 *   2. Origin header  — must match the exact app origin.
 *   3. Referer header — exact-origin fallback when Origin is missing.
 *   4. Double-submit token — X-CSRF-Token must match the app-scoped cookie.
 *
 * The check runs at the top of proxy() — before the public-path bypass — so all
 * mutating paths (including /api/auth/*) are CSRF-protected.
 *
 * Rate limiting is handled at the infrastructure level (Cloudflare + AWS WAF
 * managed rule sets) and is not duplicated here.
 */
const checkCsrf = (request: NextRequest): boolean => {
  const method = request.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (request.nextUrl.pathname.startsWith("/api/agent/") && hasApiKeyAuthorization(request.headers.get("authorization"))) {
    return true;
  }

  const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value ?? "";
  const csrfHeader = request.headers.get(CSRF_HEADER_NAME) ?? "";
  if (
    !CSRF_TOKEN_RE.test(csrfCookie)
    || !CSRF_TOKEN_RE.test(csrfHeader)
    || csrfCookie !== csrfHeader
  ) {
    return false;
  }

  const allowedOrigin = process.env.CORS_ORIGIN ?? "";
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return false;
  }

  if (allowedOrigin === "") {
    return true;
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    return origin === allowedOrigin;
  }

  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      const refererOrigin = new URL(referer).origin;
      return refererOrigin === allowedOrigin;
    } catch {
      return false;
    }
  }
  return false;
};

type VerifiedIdentity = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
}>;

const verifyAndExtractIdentity = async (jwt: string): Promise<VerifiedIdentity> => {
  const payload = await getJwtVerifier().verify(jwt);
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("JWT payload missing sub claim");
  }
  const email = "email" in payload ? payload.email : undefined;
  if (typeof email !== "string" || email.length === 0) {
    throw new Error("JWT payload missing email claim");
  }
  const emailVerifiedClaim = "email_verified" in payload ? payload.email_verified : undefined;
  if (typeof emailVerifiedClaim !== "boolean") {
    throw new Error("JWT payload missing boolean email_verified claim");
  }
  return { userId: sub, email, emailVerified: emailVerifiedClaim };
};

const forwardWithIdentity = (
  request: NextRequest,
  identity: VerifiedIdentity,
  workspaceId: string,
  nonce: string,
): NextResponse => {
  const csp = buildCsp(nonce);
  const headers = new Headers(request.headers);
  headers.set(USER_ID_HEADER, identity.userId);
  headers.set(WORKSPACE_ID_HEADER, workspaceId);
  headers.set(USER_EMAIL_HEADER, identity.email);
  headers.set(USER_EMAIL_VERIFIED_HEADER, identity.emailVerified ? "true" : "false");
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  addSecurityHeaders(response, nonce, csp);
  maybeAttachCsrfCookie(request, response);
  return response;
};

const isPublicPath = (pathname: string): boolean =>
  PUBLIC_PATHS.includes(pathname);

const resolveWorkspaceId = (request: NextRequest, userId: string): string => {
  const workspaceCookie = request.cookies.get("workspace")?.value;
  return (workspaceCookie !== undefined && workspaceCookie !== "" && WORKSPACE_ID_RE.test(workspaceCookie))
    ? workspaceCookie
    : userId;
};

const buildCookieHeader = (name: string, value: string, maxAge: number): string => {
  const cookieDomain = process.env.COOKIE_DOMAIN ?? "";
  const domainAttr = cookieDomain !== "" ? `; Domain=${cookieDomain}` : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax${domainAttr}`;
};

const generateCsrfToken = (): string =>
  `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

const buildCsrfCookieHeader = (token: string, maxAge: number): string =>
  `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`;

const maybeAttachCsrfCookie = (request: NextRequest, response: NextResponse): void => {
  const existingToken = request.cookies.get(CSRF_COOKIE_NAME)?.value ?? "";
  if (CSRF_TOKEN_RE.test(existingToken)) {
    return;
  }
  response.headers.append("Set-Cookie", buildCsrfCookieHeader(generateCsrfToken(), 3024000));
};

const redirectToAuth = (request: NextRequest, nonce: string): NextResponse => {
  const redirectUrl = buildAuthRedirectUrl(request);
  const response = NextResponse.redirect(redirectUrl);
  clearAuthCookies(response.headers);
  addSecurityHeaders(response, nonce);
  return response;
};

export const proxy = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  if (!checkCsrf(request)) {
    const response = new NextResponse("CSRF validation failed", { status: 403 });
    addSecurityHeaders(response, nonce);
    return response;
  }

  const authMode = getAuthMode();

  if (authMode === "none") {
    return forwardWithIdentity(
      request,
      { userId: LOCAL_USER_ID, email: LOCAL_USER_EMAIL, emailVerified: true },
      LOCAL_WORKSPACE_ID,
      nonce,
    );
  }

  // AUTH_MODE=cognito — public paths are exempt from auth (CSRF already checked above)
  if (isPublicPath(pathname)) {
    const csp = buildCsp(nonce);
    const headers = new Headers(request.headers);
    headers.delete(USER_ID_HEADER);
    headers.delete(WORKSPACE_ID_HEADER);
    headers.delete(USER_EMAIL_HEADER);
    headers.delete(USER_EMAIL_VERIFIED_HEADER);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    const response = NextResponse.next({ request: { headers } });
    addSecurityHeaders(response, nonce, csp);
    return response;
  }

  if (pathname.startsWith("/api/agent/") && hasApiKeyAuthorization(request.headers.get("authorization"))) {
    const csp = buildCsp(nonce);
    const headers = new Headers(request.headers);
    headers.delete(USER_ID_HEADER);
    headers.delete(WORKSPACE_ID_HEADER);
    headers.delete(USER_EMAIL_HEADER);
    headers.delete(USER_EMAIL_VERIFIED_HEADER);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    const response = NextResponse.next({ request: { headers } });
    addSecurityHeaders(response, nonce, csp);
    return response;
  }

  const sessionCookie = request.cookies.get("session")?.value ?? "";

  if (sessionCookie === "") {
    const redirectUrl = buildAuthRedirectUrl(request);
    const response = NextResponse.redirect(redirectUrl);
    addSecurityHeaders(response, nonce);
    return response;
  }

  let identity: VerifiedIdentity;
  try {
    identity = await verifyAndExtractIdentity(sessionCookie);
  } catch (err) {
    // Token expired — refresh inline instead of GET redirect
    if (err instanceof JwtExpiredError) {
      const refreshCookie = request.cookies.get("refresh")?.value ?? "";
      if (refreshCookie === "") {
        return redirectToAuth(request, nonce);
      }

      let tokens: Awaited<ReturnType<typeof refreshTokens>>;
      try {
        tokens = await refreshTokens(refreshCookie);
      } catch {
        return redirectToAuth(request, nonce);
      }

      let refreshedIdentity: VerifiedIdentity;
      try {
        refreshedIdentity = await verifyAndExtractIdentity(tokens.idToken);
      } catch {
        return redirectToAuth(request, nonce);
      }

      const workspaceId = resolveWorkspaceId(request, refreshedIdentity.userId);
      const response = forwardWithIdentity(request, refreshedIdentity, workspaceId, nonce);
      response.headers.append("Set-Cookie", buildCookieHeader("session", tokens.idToken, 3024000));
      if (tokens.refreshToken !== undefined) {
        response.headers.append("Set-Cookie", buildCookieHeader("refresh", tokens.refreshToken, 3024000));
      }
      // Refresh the UI indicator cookie (no HttpOnly)
      const cookieDomain = process.env.COOKIE_DOMAIN ?? "";
      const domainAttr = cookieDomain !== "" ? `; Domain=${cookieDomain}` : "";
      response.headers.append("Set-Cookie", `logged_in=1; Path=/; Max-Age=3024000; Secure; SameSite=Lax${domainAttr}`);
      return response;
    }

    // Token invalid — clear cookies and redirect to auth service
    const message = err instanceof Error ? err.message : String(err);
    log({ domain: "auth", action: "proxy_auth_error", error: message });
    return redirectToAuth(request, nonce);
  }

  // Workspace cookie is set client-side. RLS enforces workspace membership
  // at the database level — setting this to a foreign workspace gives no access.
  const workspaceId = resolveWorkspaceId(request, identity.userId);
  return forwardWithIdentity(request, identity, workspaceId, nonce);
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
