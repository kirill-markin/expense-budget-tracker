/**
 * Shared workspace operations for human and agent transports.
 */
import { queryAs, queryAsTrustedIdentity } from "@/server/db";
import { type UserIdentity } from "@/server/users";

export type WorkspaceSummary = Readonly<{
  workspaceId: string;
  name: string;
}>;

const WORKSPACES_SQL = `SELECT w.workspace_id, w.name
  FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
  WHERE wm.user_id = $1
  ORDER BY w.name`;

const mapWorkspaceRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<WorkspaceSummary> =>
  rows.map((row) => {
    const typedRow = row as { workspace_id: string; name: string };
    return { workspaceId: typedRow.workspace_id, name: typedRow.name };
  });

export const listWorkspaces = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const result = await queryAs(userId, workspaceId, WORKSPACES_SQL, [userId]);
  return mapWorkspaceRows(result.rows);
};

export const listWorkspacesForTrustedIdentity = async (
  identity: UserIdentity,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const result = await queryAsTrustedIdentity(identity, identity.userId, WORKSPACES_SQL, [identity.userId]);
  return mapWorkspaceRows(result.rows);
};

export const createWorkspaceForCurrentUser = async (
  userId: string,
  workspaceId: string,
  name: string,
): Promise<WorkspaceSummary> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT workspace_id, name FROM create_workspace_for_current_user($1)",
    [name],
  );

  if (result.rows.length !== 1) {
    throw new Error(`create_workspace_for_current_user returned ${result.rows.length} rows`);
  }

  const row = result.rows[0] as { workspace_id: string; name: string };
  return { workspaceId: row.workspace_id, name: row.name };
};

export const createWorkspaceForTrustedIdentity = async (
  identity: UserIdentity,
  name: string,
): Promise<WorkspaceSummary> => {
  const result = await queryAsTrustedIdentity(
    identity,
    identity.userId,
    "SELECT workspace_id, name FROM create_workspace_for_current_user($1)",
    [name],
  );

  if (result.rows.length !== 1) {
    throw new Error(`create_workspace_for_current_user returned ${result.rows.length} rows`);
  }

  const row = result.rows[0] as { workspace_id: string; name: string };
  return { workspaceId: row.workspace_id, name: row.name };
};

export const getWorkspaceForTrustedIdentity = async (
  identity: UserIdentity,
  workspaceId: string,
): Promise<WorkspaceSummary | null> => {
  const result = await queryAsTrustedIdentity(
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
  return { workspaceId: row.workspace_id, name: row.name };
};
