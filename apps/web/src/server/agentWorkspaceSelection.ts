/**
 * Persist and resolve per-connection workspace selection for agent API keys.
 */
import { queryAsTrustedIdentity } from "@/server/db";
import { type AgentAuthenticatedRequest } from "@/server/agentApiKeyAuth";
import { listWorkspacesForTrustedIdentity } from "@/server/workspaces";

const SELECT_SAVED_WORKSPACE_SQL = `SELECT selected_workspace_id
  FROM auth.agent_api_keys
  WHERE connection_id = $1
    AND user_id = $2
    AND revoked_at IS NULL`;

const UPDATE_SAVED_WORKSPACE_SQL = `UPDATE auth.agent_api_keys
  SET selected_workspace_id = $1
  WHERE connection_id = $2
    AND user_id = $3
    AND revoked_at IS NULL
  RETURNING connection_id`;

export const loadSavedWorkspaceId = async (
  authenticated: AgentAuthenticatedRequest,
): Promise<string | null> => {
  const result = await queryAsTrustedIdentity(
    authenticated.identity,
    authenticated.identity.userId,
    SELECT_SAVED_WORKSPACE_SQL,
    [authenticated.connectionId, authenticated.identity.userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { selected_workspace_id: string | null };
  return row.selected_workspace_id;
};

export const saveWorkspaceId = async (
  authenticated: AgentAuthenticatedRequest,
  workspaceId: string,
): Promise<void> => {
  const result = await queryAsTrustedIdentity(
    authenticated.identity,
    authenticated.identity.userId,
    UPDATE_SAVED_WORKSPACE_SQL,
    [workspaceId, authenticated.connectionId, authenticated.identity.userId],
  );

  if (result.rows.length !== 1) {
    throw new Error(`Failed to persist selected workspace for connection ${authenticated.connectionId}`);
  }
};

export const resolveWorkspaceIdForSql = async (
  authenticated: AgentAuthenticatedRequest,
  headerWorkspaceId: string,
): Promise<string | null> => {
  if (headerWorkspaceId !== "") {
    return headerWorkspaceId;
  }

  const savedWorkspaceId = await loadSavedWorkspaceId(authenticated);
  if (savedWorkspaceId !== null && savedWorkspaceId !== "") {
    return savedWorkspaceId;
  }

  const workspaces = await listWorkspacesForTrustedIdentity(authenticated.identity);
  if (workspaces.length !== 1) {
    return null;
  }

  const onlyWorkspace = workspaces[0];
  if (onlyWorkspace === undefined) {
    throw new Error("Expected exactly one workspace, but none were found");
  }

  await saveWorkspaceId(authenticated, onlyWorkspace.workspaceId);
  return onlyWorkspace.workspaceId;
};
