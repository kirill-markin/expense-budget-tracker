import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

let client: CognitoIdentityProviderClient | undefined;

/** IAM-signed client for the Cognito admin actions the auth task role grants. */
export const getCognitoAdminClient = (): CognitoIdentityProviderClient => {
  if (client !== undefined) return client;
  const region = process.env.COGNITO_REGION ?? "";
  if (region === "") {
    throw new Error("Cognito admin API calls require COGNITO_REGION");
  }
  client = new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
  return client;
};
