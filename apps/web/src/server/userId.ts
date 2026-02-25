/**
 * Extract resolved user and workspace IDs from internal headers set by middleware.ts.
 * Throws if a header is missing — indicates a proxy misconfiguration.
 */

const USER_ID_HEADER = "x-user-id";
const WORKSPACE_ID_HEADER = "x-workspace-id";

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
