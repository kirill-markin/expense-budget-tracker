/**
 * Token refresh endpoint. Uses the refresh cookie to obtain new Cognito
 * tokens and sets updated session cookies.
 *
 * POST-only to avoid side effects on GET (previously GET, which allowed
 * triggering via img tags, link prefetch, etc.).
 *
 * The primary refresh flow is handled inline by proxy.ts (transparent to
 * the user). This endpoint exists as an explicit refresh mechanism for
 * client-side code that detects a 401.
 *
 * Rate limiting is handled at the infrastructure level (Cloudflare + WAF +
 * Cognito built-in throttling) and is not duplicated here.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshTokens } from "@/server/cognitoAuth";
import { clearAuthCookies } from "@/server/cookies";

const getCookieDomainAttr = (): string => {
  const domain = process.env.COOKIE_DOMAIN ?? "";
  return domain !== "" ? `; Domain=${domain}` : "";
};

export const POST = async (request: NextRequest): Promise<Response> => {
  const refreshToken = request.cookies.get("refresh")?.value ?? "";

  if (refreshToken === "") {
    return Response.json({ error: "No refresh token" }, { status: 401 });
  }

  let tokens: Awaited<ReturnType<typeof refreshTokens>>;
  try {
    tokens = await refreshTokens(refreshToken);
  } catch {
    const headers = new Headers();
    headers.set("Cache-Control", "no-store");
    headers.set("Pragma", "no-cache");
    clearAuthCookies(headers);
    return Response.json({ error: "Refresh failed" }, { status: 401, headers });
  }

  const domainAttr = getCookieDomainAttr();
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");

  headers.append(
    "Set-Cookie",
    `session=${encodeURIComponent(tokens.idToken)}; Path=/; Max-Age=3024000; HttpOnly; Secure; SameSite=Lax${domainAttr}`,
  );

  if (tokens.refreshToken !== undefined) {
    headers.append(
      "Set-Cookie",
      `refresh=${encodeURIComponent(tokens.refreshToken)}; Path=/; Max-Age=3024000; HttpOnly; Secure; SameSite=Lax${domainAttr}`,
    );
  }

  return Response.json({ ok: true }, { status: 200, headers });
};
