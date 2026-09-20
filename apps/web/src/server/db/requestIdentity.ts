import { headers } from "next/headers";

import {
  COGNITO_AUTHENTICATED_STATUS,
  LOCAL_USER_STATUS,
  PROXY_AUTHENTICATED_STATUS,
  type UserIdentity,
} from "@/server/users";
import { extractUserEmailFromHeaders, extractUserEmailVerifiedFromHeaders, extractUserIdFromHeaders } from "@/server/userId";

const resolveMirroredStatus = (userId: string): string => {
  if (process.env.AUTH_MODE === "proxy_jwt") {
    return PROXY_AUTHENTICATED_STATUS;
  }
  return userId === "local" ? LOCAL_USER_STATUS : COGNITO_AUTHENTICATED_STATUS;
};

export const buildRequestIdentity = (headersList: Headers): UserIdentity => {
  const userId = extractUserIdFromHeaders(headersList);
  const email = extractUserEmailFromHeaders(headersList);
  const emailVerified = extractUserEmailVerifiedFromHeaders(headersList);

  return {
    userId,
    email,
    emailVerified,
    cognitoStatus: resolveMirroredStatus(userId),
    cognitoEnabled: true,
  };
};

/**
 * Read the current authenticated identity from trusted proxy headers.
 *
 * The headers are written only after proxy.ts verified the identity token —
 * the Cognito ID token, or the token forwarded by the upstream authentication
 * proxy — so downstream server code can treat these values as authenticated.
 */
export const getCurrentRequestIdentity = async (): Promise<UserIdentity> => {
  const headersList = await headers();
  return buildRequestIdentity(headersList);
};
