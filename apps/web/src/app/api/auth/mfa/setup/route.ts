/**
 * MFA setup: associate a TOTP software token with the current user.
 *
 * POST /api/auth/mfa/setup — returns { secretCode, totpUri }
 *
 * The user enters the secretCode into their authenticator app (Google Authenticator,
 * 1Password, etc.), then verifies with POST /api/auth/mfa/verify.
 */

import { cognitoRequest, getAccessToken } from "@/server/cognito";

export const POST = async (request: Request): Promise<Response> => {
  const accessToken = getAccessToken(request);
  if (accessToken === null) {
    return new Response("MFA not available", { status: 400 });
  }

  try {
    const result = await cognitoRequest("AssociateSoftwareToken", accessToken, {});
    const secretCode = result.SecretCode as string;

    const issuer = "Expense Tracker";
    const totpUri = `otpauth://totp/${encodeURIComponent(issuer)}?secret=${secretCode}&issuer=${encodeURIComponent(issuer)}`;

    return Response.json({ secretCode, totpUri });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("mfa setup POST: %s", message);
    return new Response("Failed to start MFA setup", { status: 500 });
  }
};
