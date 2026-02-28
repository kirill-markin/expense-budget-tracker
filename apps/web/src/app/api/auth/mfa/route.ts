/**
 * MFA status and disable endpoints.
 *
 * GET  /api/auth/mfa — returns { enabled: boolean }
 * DELETE /api/auth/mfa — disables MFA for the current user
 */

import { cognitoRequest, getAccessToken } from "@/server/cognito";

export const GET = async (request: Request): Promise<Response> => {
  const accessToken = getAccessToken(request);
  if (accessToken === null) {
    return Response.json({ enabled: false, available: false });
  }

  try {
    const user = await cognitoRequest("GetUser", accessToken, {});
    const mfaSettings = user.UserMFASettingList as ReadonlyArray<string> | undefined;
    const enabled = mfaSettings?.includes("SOFTWARE_TOKEN_MFA") ?? false;
    return Response.json({ enabled, available: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("mfa GET: %s", message);
    return new Response("Failed to check MFA status", { status: 500 });
  }
};

export const DELETE = async (request: Request): Promise<Response> => {
  const accessToken = getAccessToken(request);
  if (accessToken === null) {
    return new Response("MFA not available", { status: 400 });
  }

  try {
    await cognitoRequest("SetUserMFAPreference", accessToken, {
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    });
    return Response.json({ enabled: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("mfa DELETE: %s", message);
    return new Response("Failed to disable MFA", { status: 500 });
  }
};
