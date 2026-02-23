import { NextResponse } from "next/server";

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

export const GET = (request: Request): Response => {
  const authMode = process.env.AUTH_MODE ?? "none";
  if (authMode !== "proxy") {
    return new Response("Logout not available: AUTH_MODE is not proxy", { status: 400 });
  }

  const cognitoDomain = getRequiredEnv("COGNITO_DOMAIN");
  const cognitoClientId = getRequiredEnv("COGNITO_CLIENT_ID");

  // Build the public origin from ALB-forwarded headers (request.url is the internal container address)
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host = request.headers.get("host") ?? "";
  const logoutRedirect = `${proto}://${host}/`;
  const logoutUrl = `https://${cognitoDomain}/logout?client_id=${cognitoClientId}&logout_uri=${encodeURIComponent(logoutRedirect)}`;

  const response = NextResponse.redirect(logoutUrl);

  // Clear ALB session cookies (ALB splits large JWTs across cookies 0-2)
  for (let i = 0; i <= 2; i++) {
    response.headers.append(
      "Set-Cookie",
      `AWSELBAuthSessionCookie-${i}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly`,
    );
  }

  return response;
};
