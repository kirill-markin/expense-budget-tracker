/**
 * MFA verify: confirm the TOTP code and enable MFA.
 *
 * POST /api/auth/mfa/verify { code: "123456" }
 *
 * After successful verification, TOTP MFA is set as the preferred method.
 */

import { cognitoRequest, getAccessToken } from "@/server/cognito";

type VerifyBody = Readonly<{ code: string }>;

export const POST = async (request: Request): Promise<Response> => {
  const accessToken = getAccessToken(request);
  if (accessToken === null) {
    return new Response("MFA not available", { status: 400 });
  }

  let code: string;
  try {
    const body = await request.json() as VerifyBody;
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      return new Response("code must be a 6-digit string", { status: 400 });
    }
    code = body.code;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  try {
    await cognitoRequest("VerifySoftwareToken", accessToken, {
      UserCode: code,
    });

    await cognitoRequest("SetUserMFAPreference", accessToken, {
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });

    return Response.json({ enabled: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("mfa verify POST: %s", message);

    if (message.includes("EnableSoftwareTokenMFAException") || message.includes("Code mismatch")) {
      return new Response("Invalid verification code", { status: 400 });
    }

    return new Response("Failed to verify MFA code", { status: 500 });
  }
};
