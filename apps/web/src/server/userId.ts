/**
 * Extract resolved user and workspace IDs from internal headers set by proxy.ts.
 * Throws if a header is missing — indicates a proxy misconfiguration.
 *
 * Two overloads:
 *   extractUserId(request)             — for API route handlers (Request object)
 *   extractUserIdFromHeaders(headers)  — for page components (Headers from await headers())
 */

const USER_ID_HEADER = "x-user-id";
const WORKSPACE_ID_HEADER = "x-workspace-id";
const USER_EMAIL_HEADER = "x-user-email";
const USER_EMAIL_VERIFIED_HEADER = "x-user-email-verified";

export const extractUserId = (request: Request): string => {
  const userId = request.headers.get(USER_ID_HEADER);
  if (userId === null || userId === "") {
    throw new Error(`Missing ${USER_ID_HEADER} header — proxy misconfiguration`);
  }
  return userId;
};

export const extractWorkspaceId = (request: Request): string => {
  const workspaceId = request.headers.get(WORKSPACE_ID_HEADER);
  if (workspaceId === null || workspaceId === "") {
    throw new Error(`Missing ${WORKSPACE_ID_HEADER} header — proxy misconfiguration`);
  }
  return workspaceId;
};

/** Read the authenticated user ID from trusted internal headers. */
export const extractUserIdFromHeaders = (headersList: Headers): string => {
  const userId = headersList.get(USER_ID_HEADER);
  if (userId === null || userId === "") {
    throw new Error(`Missing ${USER_ID_HEADER} header — proxy misconfiguration`);
  }
  return userId;
};

/** Read the active workspace ID from trusted internal headers. */
export const extractWorkspaceIdFromHeaders = (headersList: Headers): string => {
  const workspaceId = headersList.get(WORKSPACE_ID_HEADER);
  if (workspaceId === null || workspaceId === "") {
    throw new Error(`Missing ${WORKSPACE_ID_HEADER} header — proxy misconfiguration`);
  }
  return workspaceId;
};

/** Read the authenticated email mirrored from the verified Cognito ID token. */
export const extractUserEmailFromHeaders = (headersList: Headers): string => {
  const email = headersList.get(USER_EMAIL_HEADER);
  if (email === null || email === "") {
    throw new Error(`Missing ${USER_EMAIL_HEADER} header — proxy misconfiguration`);
  }
  return email;
};

/** Parse the email_verified claim mirrored from the verified Cognito ID token. */
export const extractUserEmailVerifiedFromHeaders = (headersList: Headers): boolean => {
  const raw = headersList.get(USER_EMAIL_VERIFIED_HEADER);
  if (raw === null || raw === "") {
    throw new Error(`Missing ${USER_EMAIL_VERIFIED_HEADER} header — proxy misconfiguration`);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid ${USER_EMAIL_VERIFIED_HEADER} header value: ${raw}`);
};
