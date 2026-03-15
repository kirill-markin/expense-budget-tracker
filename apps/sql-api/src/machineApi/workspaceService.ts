import type { UserIdentity } from "../db.js";
import type { AuthenticatedContext, MachineApiDependencies, WorkspaceSummary } from "./types.js";

const WORKSPACES_SQL = `SELECT w.workspace_id, w.name
  FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
  WHERE wm.user_id = $1
  ORDER BY w.name`;
const AGENT_CONNECTION_SELECT_SQL = `SELECT selected_workspace_id
  FROM auth.agent_api_keys
  WHERE connection_id = $1
    AND user_id = $2
    AND revoked_at IS NULL`;
const AGENT_CONNECTION_UPDATE_SQL = `UPDATE auth.agent_api_keys
  SET selected_workspace_id = $1
  WHERE connection_id = $2
    AND user_id = $3
    AND revoked_at IS NULL
  RETURNING connection_id`;

const mapWorkspaceRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<WorkspaceSummary> =>
  rows.map((row) => {
    const typedRow = row as { workspace_id: string; name: string };
    return {
      workspaceId: typedRow.workspace_id,
      name: typedRow.name,
    };
  });

export const listWorkspaces = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const result = await dependencies.queryAsTrustedIdentity(identity, identity.userId, WORKSPACES_SQL, [identity.userId]);
  return mapWorkspaceRows(result.rows);
};

export const createWorkspace = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
  name: string,
): Promise<WorkspaceSummary> => {
  const result = await dependencies.queryAsTrustedIdentity(
    identity,
    identity.userId,
    "SELECT workspace_id, name FROM create_workspace_for_current_user($1)",
    [name],
  );

  if (result.rows.length !== 1) {
    throw new Error(`create_workspace_for_current_user returned ${result.rows.length} rows`);
  }

  const row = result.rows[0] as { workspace_id: string; name: string };
  return {
    workspaceId: row.workspace_id,
    name: row.name,
  };
};

export const getWorkspace = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
  workspaceId: string,
): Promise<WorkspaceSummary | null> => {
  const result = await dependencies.queryAsTrustedIdentity(
    identity,
    identity.userId,
    `SELECT w.workspace_id, w.name
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
     WHERE w.workspace_id = $1
       AND wm.user_id = $2`,
    [workspaceId, identity.userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { workspace_id: string; name: string };
  return {
    workspaceId: row.workspace_id,
    name: row.name,
  };
};

export const persistSelectedWorkspace = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
  workspaceId: string,
): Promise<void> => {
  const result = await dependencies.queryAsTrustedIdentity(
    authenticated.identity,
    authenticated.identity.userId,
    AGENT_CONNECTION_UPDATE_SQL,
    [workspaceId, authenticated.connectionId, authenticated.identity.userId],
  );

  if (result.rows.length !== 1) {
    throw new Error(`Failed to persist selected workspace for connection ${authenticated.connectionId}`);
  }
};

const getSelectedWorkspace = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
): Promise<string | null> => {
  const result = await dependencies.queryAsTrustedIdentity(
    authenticated.identity,
    authenticated.identity.userId,
    AGENT_CONNECTION_SELECT_SQL,
    [authenticated.connectionId, authenticated.identity.userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { selected_workspace_id: string | null };
  return row.selected_workspace_id;
};

export const resolveSqlWorkspaceId = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
  headerWorkspaceId: string,
): Promise<string | null> => {
  if (headerWorkspaceId !== "") {
    return headerWorkspaceId;
  }

  const savedWorkspaceId = await getSelectedWorkspace(dependencies, authenticated);
  if (savedWorkspaceId !== null && savedWorkspaceId !== "") {
    return savedWorkspaceId;
  }

  const workspaces = await listWorkspaces(dependencies, authenticated.identity);
  if (workspaces.length !== 1) {
    return null;
  }

  const onlyWorkspace = workspaces[0];
  if (onlyWorkspace === undefined) {
    throw new Error("Expected exactly one workspace, but none were found");
  }

  await persistSelectedWorkspace(dependencies, authenticated, onlyWorkspace.workspaceId);
  return onlyWorkspace.workspaceId;
};
