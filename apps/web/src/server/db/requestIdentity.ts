import { headers } from "next/headers";

import { COGNITO_AUTHENTICATED_STATUS, LOCAL_USER_STATUS, type UserIdentity } from "@/server/users";
import { extractUserEmailFromHeaders, extractUserEmailVerifiedFromHeaders, extractUserIdFromHeaders } from "@/server/userId";

export const buildRequestIdentity = (headersList: Headers): UserIdentity => {
  const userId = extractUserIdFromHeaders(headersList);
  const email = extractUserEmailFromHeaders(headersList);
  const emailVerified = extractUserEmailVerifiedFromHeaders(headersList);

  return {
    userId,
    email,
    emailVerified,
    cognitoStatus: userId === "local" ? LOCAL_USER_STATUS : COGNITO_AUTHENTICATED_STATUS,
    cognitoEnabled: true,
  };
};

/**
 * Read the current authenticated identity from trusted proxy headers.
 *
 * The headers are written only after proxy.ts verifies the Cognito ID token, so
 * downstream server code can treat these values as already authenticated.
 */
export const getCurrentRequestIdentity = async (): Promise<UserIdentity> => {
  const headersList = await headers();
  return buildRequestIdentity(headersList);
};
