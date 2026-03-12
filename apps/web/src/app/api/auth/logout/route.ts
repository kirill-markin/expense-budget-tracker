/**
 * Logout endpoint. Revokes the refresh token server-side, clears all auth and
 * legacy ALB cookies, returns JSON.
 *
 * Uses POST to prevent CSRF-based forced logout via image tags or navigation.
 */
import { cookies } from "next/headers";
import { revokeRefreshToken } from "@/server/cognitoAuth";
import { clearAuthCookies } from "@/server/cookies";
import { getConfiguredAuthMode } from "@/server/authMode";

export const POST = async (): Promise<Response> => {
  const authMode = getConfiguredAuthMode(process.env);
  if (authMode !== "cognito") {
    return Response.json({ error: "Logout not available: AUTH_MODE is not cognito" }, { status: 400 });
  }

  // Revoke refresh token server-side (best-effort, never blocks logout)
  const jar = await cookies();
  const refreshToken = jar.get("refresh")?.value ?? "";
  if (refreshToken !== "") {
    await revokeRefreshToken(refreshToken);
  }

  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  clearAuthCookies(headers);

  // Clear legacy ALB session cookies
  for (let i = 0; i <= 2; i++) {
    headers.append(
      "Set-Cookie",
      `AWSELBAuthSessionCookie-${i}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly`,
    );
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
