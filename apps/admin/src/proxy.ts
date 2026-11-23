/**
 * Admin auth gate. Every route is read-only, so only GET and HEAD pass.
 *
 * ADMIN_AUTH_MODE=none    — local development only: requests pass as a fixed
 *                           local admin. The 127.0.0.1 bind of the dev and start
 *                           scripts is the network boundary; the loopback Host
 *                           check only stops DNS rebinding. The image binds
 *                           0.0.0.0, so none mode there is safe only without a
 *                           published port.
 * ADMIN_AUTH_MODE=cognito — verifies the `session` ID token cookie shared with
 *                           the main app, refreshes it inline only when it has
 *                           expired, and admits only verified ADMIN_EMAILS.
 *
 * The verified email is forwarded in ADMIN_EMAIL_HEADER; any incoming copy of
 * that header is dropped first, so a caller cannot inject one.
 */
import { NextRequest, NextResponse } from "next/server";
import { JwtExpiredError } from "aws-jwt-verify/error";
import type { JsonObject } from "aws-jwt-verify/safe-json-parse";
import { decideAdminAccess } from "@/server/access";
import {
  buildClearedSessionCookieHeaders,
  buildSessionCookieHeaders,
  getJwtVerifier,
  refreshTokens,
  type RefreshResult,
} from "@/server/cognitoAuth";
import { getAdminConfig, type AdminConfig, type CognitoAuthConfig } from "@/server/config";
import { ADMIN_EMAIL_HEADER } from "@/server/identity";
import { log } from "@/server/logger";

const LOCAL_ADMIN_EMAIL = "local-admin@localhost";
const FORBIDDEN_PATH = "/forbidden";
const LOOPBACK_HOSTNAMES: ReadonlyArray<string> = ["localhost", "127.0.0.1", "[::1]"];

const buildCsp = (nonce: string, adminOrigin: string): string => {
  const isDev = process.env.NODE_ENV === "development";
  const directives: Array<string> = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];
  if (adminOrigin.startsWith("https://")) {
    directives.push("upgrade-insecure-requests");
  }
  return directives.join("; ");
};

const withSecurityHeaders = (response: NextResponse, csp: string): NextResponse => {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
};

/** Request headers for the rendered page: Next reads the nonce from the CSP to stamp its own scripts. */
const buildForwardedHeaders = (request: NextRequest, email: string | null, nonce: string, csp: string): Headers => {
  const headers = new Headers(request.headers);
  headers.delete(ADMIN_EMAIL_HEADER);
  if (email !== null) {
    headers.set(ADMIN_EMAIL_HEADER, email);
  }
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  return headers;
};

const forwardAsAdmin = (request: NextRequest, email: string, nonce: string, csp: string): NextResponse =>
  withSecurityHeaders(
    NextResponse.next({ request: { headers: buildForwardedHeaders(request, email, nonce, csp) } }),
    csp,
  );

const rewriteToForbidden = (request: NextRequest, nonce: string, csp: string): NextResponse =>
  withSecurityHeaders(
    NextResponse.rewrite(new URL(FORBIDDEN_PATH, request.url), {
      status: 403,
      request: { headers: buildForwardedHeaders(request, null, nonce, csp) },
    }),
    csp,
  );

const plainResponse = (body: string, status: number, csp: string): NextResponse =>
  withSecurityHeaders(new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } }), csp);

const requestPath = (request: NextRequest): string => request.nextUrl.pathname + request.nextUrl.search;

const buildLoginUrl = (auth: CognitoAuthConfig, adminOrigin: string, request: NextRequest): URL => {
  const loginUrl = new URL(`https://${auth.authDomain}/login`);
  loginUrl.searchParams.set("redirect_uri", `${adminOrigin}${requestPath(request)}`);
  return loginUrl;
};

const redirectToLogin = (
  auth: CognitoAuthConfig,
  adminOrigin: string,
  request: NextRequest,
  clearCookies: boolean,
  csp: string,
): NextResponse => {
  const response = NextResponse.redirect(buildLoginUrl(auth, adminOrigin, request));
  if (clearCookies) {
    for (const cookie of buildClearedSessionCookieHeaders(auth)) {
      response.headers.append("Set-Cookie", cookie);
    }
  }
  return withSecurityHeaders(response, csp);
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const isLoopbackHost = (hostHeader: string | null): boolean => {
  if (hostHeader === null) return false;
  try {
    return LOOPBACK_HOSTNAMES.includes(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
};

type VerifiedSession = Readonly<{
  claims: JsonObject;
  refreshed: RefreshResult | null;
}>;

/** Without verified claims the request goes to login; `clearCookies` tells whether the stored session is unusable. */
const verifySession = async (
  auth: CognitoAuthConfig,
  request: NextRequest,
): Promise<VerifiedSession | Readonly<{ clearCookies: boolean }>> => {
  const sessionCookie = request.cookies.get("session")?.value ?? "";
  if (sessionCookie === "") return { clearCookies: false };

  const verifier = getJwtVerifier(auth);
  try {
    return { claims: await verifier.verify(sessionCookie), refreshed: null };
  } catch (error) {
    if (!(error instanceof JwtExpiredError)) {
      log({ domain: "admin_auth", action: "session_invalid", error: errorMessage(error) });
      return { clearCookies: true };
    }
  }

  const refreshCookie = request.cookies.get("refresh")?.value ?? "";
  if (refreshCookie === "") return { clearCookies: true };
  try {
    const refreshed = await refreshTokens(auth, refreshCookie);
    const claims = await verifier.verify(refreshed.idToken);
    log({ domain: "admin_auth", action: "refresh" });
    return { claims, refreshed };
  } catch (error) {
    log({ domain: "admin_auth", action: "refresh_failed", error: errorMessage(error) });
    return { clearCookies: true };
  }
};

const handleCognitoRequest = async (
  config: AdminConfig,
  auth: CognitoAuthConfig,
  request: NextRequest,
  nonce: string,
  csp: string,
): Promise<NextResponse> => {
  const session = await verifySession(auth, request);
  if (!("claims" in session)) {
    return redirectToLogin(auth, config.adminOrigin, request, session.clearCookies, csp);
  }

  const decision = decideAdminAccess(session.claims, config);
  if (decision === "redirect_to_login") {
    return redirectToLogin(auth, config.adminOrigin, request, true, csp);
  }

  const email = typeof session.claims.email === "string" ? session.claims.email : null;
  const response = decision === "allowed" && email !== null
    ? forwardAsAdmin(request, email, nonce, csp)
    : rewriteToForbidden(request, nonce, csp);
  if (decision === "forbidden") {
    const userId = typeof session.claims.sub === "string" ? session.claims.sub : null;
    log({ domain: "admin_auth", action: "forbidden", userId, path: requestPath(request) });
  }
  if (session.refreshed !== null) {
    for (const cookie of buildSessionCookieHeaders(auth, session.refreshed)) {
      response.headers.append("Set-Cookie", cookie);
    }
  }
  return response;
};

export const proxy = async (request: NextRequest): Promise<NextResponse> => {
  const config = getAdminConfig();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, config.adminOrigin);

  if (request.method !== "GET" && request.method !== "HEAD") {
    log({ domain: "admin_auth", action: "method_not_allowed", method: request.method, path: requestPath(request) });
    const response = plainResponse("Method not allowed", 405, csp);
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }

  if (config.auth.mode === "none") {
    const host = request.headers.get("host");
    if (!isLoopbackHost(host)) {
      log({ domain: "admin_auth", action: "non_loopback_host", host, path: requestPath(request) });
      return plainResponse("ADMIN_AUTH_MODE=none accepts only a loopback Host header", 403, csp);
    }
    return forwardAsAdmin(request, LOCAL_ADMIN_EMAIL, nonce, csp);
  }

  return handleCognitoRequest(config, config.auth, request, nonce, csp);
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|health$).*)"],
};
