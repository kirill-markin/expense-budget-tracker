/**
 * Next.js request proxy: auth gate, user identity extraction, CSRF check, security headers.
 *
 * AUTH_MODE=none  — all requests pass; userId is hardcoded to 'local'.
 * AUTH_MODE=proxy — requires a JWT header named by AUTH_PROXY_HEADER (e.g. x-amzn-oidc-data);
 *                   decodes it to extract the Cognito `sub` claim as userId.
 *
 * The resolved userId is forwarded as x-user-id and x-workspace-id headers to all
 * downstream route handlers. /api/health is always exempt from auth.
 */
import { NextRequest, NextResponse } from "next/server";

type AuthMode = "none" | "proxy";

const LOCAL_USER_ID = "local";
const LOCAL_WORKSPACE_ID = "local";
const USER_ID_HEADER = "x-user-id";
const WORKSPACE_ID_HEADER = "x-workspace-id";

const getAuthMode = (): AuthMode => {
  const raw = process.env.AUTH_MODE ?? "none";
  if (raw === "none" || raw === "proxy") return raw;
  throw new Error(`Invalid AUTH_MODE: ${raw}. Expected "none" or "proxy"`);
};

const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-DNS-Prefetch-Control", "off"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
];

const addSecurityHeaders = (response: NextResponse): void => {
  for (const [key, value] of SECURITY_HEADERS) {
    response.headers.set(key, value);
  }
  const origin = process.env.CORS_ORIGIN ?? "";
  if (origin.startsWith("https://")) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
};

const checkCsrf = (request: NextRequest): boolean => {
  const method = request.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const origin = request.headers.get("origin");
  if (origin === null) return true;

  const allowedOrigin = process.env.CORS_ORIGIN ?? "";
  if (allowedOrigin === "") return true;

  return origin === allowedOrigin;
};

/**
 * Decode the ALB-injected OIDC JWT payload without signature verification.
 * ALB already verified the token before forwarding — we only need the claims.
 */
const extractSubFromJwt = (jwt: string): string => {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected 3 parts");
  }
  const payload = Buffer.from(parts[1], "base64url").toString("utf8");
  const claims = JSON.parse(payload) as Record<string, unknown>;
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("JWT payload missing sub claim");
  }
  return sub;
};

const forwardWithIdentity = (request: NextRequest, userId: string, workspaceId: string): NextResponse => {
  const headers = new Headers(request.headers);
  headers.set(USER_ID_HEADER, userId);
  headers.set(WORKSPACE_ID_HEADER, workspaceId);
  const response = NextResponse.next({ request: { headers } });
  addSecurityHeaders(response);
  return response;
};

export const proxy = (request: NextRequest): NextResponse => {
  const { pathname } = request.nextUrl;

  if (!checkCsrf(request)) {
    const response = new NextResponse("CSRF origin mismatch", { status: 403 });
    addSecurityHeaders(response);
    return response;
  }

  const authMode = getAuthMode();

  if (authMode === "none") {
    return forwardWithIdentity(request, LOCAL_USER_ID, LOCAL_WORKSPACE_ID);
  }

  // AUTH_MODE=proxy — health check is exempt from auth
  if (pathname === "/api/health") {
    const response = NextResponse.next();
    addSecurityHeaders(response);
    return response;
  }

  const headerName = process.env.AUTH_PROXY_HEADER ?? "";
  if (headerName === "") {
    const response = new NextResponse("Server misconfigured: AUTH_PROXY_HEADER not set", { status: 500 });
    addSecurityHeaders(response);
    return response;
  }

  const jwtValue = request.headers.get(headerName);
  if (jwtValue === null || jwtValue === "") {
    const response = new NextResponse("Unauthorized", { status: 401 });
    addSecurityHeaders(response);
    return response;
  }

  let userId: string;
  try {
    userId = extractSubFromJwt(jwtValue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const response = new NextResponse(`Invalid auth token: ${message}`, { status: 401 });
    addSecurityHeaders(response);
    return response;
  }

  // v1: each user's default workspace = their user_id
  const workspaceId = userId;
  return forwardWithIdentity(request, userId, workspaceId);
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
