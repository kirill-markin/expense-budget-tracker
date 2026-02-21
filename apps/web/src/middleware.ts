import { NextRequest, NextResponse } from "next/server";

type AuthMode = "none" | "proxy";

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

export const middleware = (request: NextRequest): NextResponse => {
  const { pathname } = request.nextUrl;

  if (!checkCsrf(request)) {
    const response = new NextResponse("CSRF origin mismatch", { status: 403 });
    addSecurityHeaders(response);
    return response;
  }

  const authMode = getAuthMode();

  if (authMode === "proxy" && pathname !== "/api/health") {
    const headerName = process.env.AUTH_PROXY_HEADER ?? "";
    if (headerName === "") {
      const response = new NextResponse("Server misconfigured: AUTH_PROXY_HEADER not set", { status: 500 });
      addSecurityHeaders(response);
      return response;
    }

    const headerValue = request.headers.get(headerName);
    if (headerValue === null || headerValue === "") {
      const response = new NextResponse("Unauthorized", { status: 401 });
      addSecurityHeaders(response);
      return response;
    }
  }

  const response = NextResponse.next();
  addSecurityHeaders(response);
  return response;
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
