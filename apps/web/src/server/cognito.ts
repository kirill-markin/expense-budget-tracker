/**
 * Cognito Identity Provider API client using the user's access token.
 *
 * Calls the Cognito IDP endpoint directly via fetch — no AWS SDK needed.
 * The access token comes from the ALB x-amzn-oidc-accesstoken header
 * (requires aws.cognito.signin.user.admin scope on the Cognito client).
 */

type CognitoOperation =
  | "GetUser"
  | "AssociateSoftwareToken"
  | "VerifySoftwareToken"
  | "SetUserMFAPreference";

export const cognitoRequest = async (
  operation: CognitoOperation,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const region = process.env.COGNITO_REGION ?? "";
  if (region === "") {
    throw new Error("COGNITO_REGION is not configured");
  }

  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify({ AccessToken: accessToken, ...body }),
  });

  if (!response.ok) {
    const error = await response.json() as { __type?: string; message?: string };
    throw new Error(error.message ?? `Cognito ${operation} failed: ${response.status}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
};

/** Extract the Cognito access token from ALB headers. Returns null if not available. */
export const getAccessToken = (request: Request): string | null =>
  request.headers.get("x-amzn-oidc-accesstoken");
