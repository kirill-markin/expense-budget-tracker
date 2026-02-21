/**
 * Extract the resolved user ID from the internal header set by proxy.ts.
 * Throws if the header is missing — indicates a proxy misconfiguration.
 */

const USER_ID_HEADER = "x-user-id";

export const extractUserId = (request: Request): string => {
  const userId = request.headers.get(USER_ID_HEADER);
  if (userId === null || userId === "") {
    throw new Error(`Missing ${USER_ID_HEADER} header — proxy misconfiguration`);
  }
  return userId;
};
