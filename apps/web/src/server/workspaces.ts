/**
 * Shared workspace operations for human and agent transports.
 */
import { queryAs, queryAsTrustedIdentity } from "@/server/db";
import { type QueryFn } from "@/server/db/contextRunner";
import { type UserIdentity } from "@/server/users";
import { resolveWorkspaceForIdentity } from "@/server/workspaceBootstrap";

export type WorkspaceSummary = Readonly<{
  workspaceId: string;
  name: string;
}>;

type WorkspaceRow = Readonly<{
  workspace_id: string;
  name: string;
}>;

// Raised by every SECURITY DEFINER function that guards the deletion, both the
// deletion itself and the chat session lister the object cleanup reads first.
const DELETE_WORKSPACE_REQUIRES_SINGLE_MEMBER_DB_MESSAGE_PATTERN =
  /^(?:delete_workspace_for_current_user|list_workspace_chat_session_ids_for_current_user): workspace deletion is only allowed when the workspace has exactly one member; found (\d+)/u;

const buildWorkspaceDeletionRequiresSingleMemberMessage = (memberCount: number): string =>
  `Workspace deletion is only allowed when the workspace has exactly one member; found ${memberCount}.`;

export class WorkspaceDeletionRequiresSingleMemberError extends Error {
  public readonly memberCount: number;

  public constructor(memberCount: number) {
    super(buildWorkspaceDeletionRequiresSingleMemberMessage(memberCount));
    this.name = "WorkspaceDeletionRequiresSingleMemberError";
    this.memberCount = memberCount;
  }
}

export const parseWorkspaceDeletionRequiresSingleMemberError = (error: unknown): WorkspaceDeletionRequiresSingleMemberError | null => {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = DELETE_WORKSPACE_REQUIRES_SINGLE_MEMBER_DB_MESSAGE_PATTERN.exec(error.message);
  if (match === null) {
    return null;
  }

  const memberCount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(memberCount)) {
    return null;
  }

  return new WorkspaceDeletionRequiresSingleMemberError(memberCount);
};

const WORKSPACES_SQL = `SELECT w.workspace_id, w.name
  FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
  WHERE wm.user_id = $1
  ORDER BY w.name`;

const mapWorkspaceRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<WorkspaceSummary> =>
  rows.map((row) => {
    const typedRow = row as WorkspaceRow;
    return { workspaceId: typedRow.workspace_id, name: typedRow.name };
  });

const mapSingleWorkspaceRow = (rows: ReadonlyArray<unknown>, queryName: string): WorkspaceSummary => {
  if (rows.length !== 1) {
    throw new Error(`${queryName} returned ${rows.length} rows`);
  }

  const row = rows[0] as WorkspaceRow;
  return { workspaceId: row.workspace_id, name: row.name };
};

const executeDeleteWorkspaceQuery = async (
  executeQuery: () => Promise<Readonly<{ rows: ReadonlyArray<unknown> }>>,
): Promise<WorkspaceSummary> => {
  try {
    const result = await executeQuery();
    return mapSingleWorkspaceRow(result.rows, "delete_workspace_for_current_user");
  } catch (error) {
    const typedError = parseWorkspaceDeletionRequiresSingleMemberError(error);
    if (typedError !== null) {
      throw typedError;
    }
    throw error;
  }
};

/**
 * List workspaces through a caller-supplied query, which carries the context the
 * caller already established. Callers that must not provision, such as a chat
 * tool call, depend on this variant.
 */
export const listWorkspacesWithQuery = async (
  queryFn: QueryFn,
  userId: string,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const result = await queryFn(WORKSPACES_SQL, [userId]);
  return mapWorkspaceRows(result.rows);
};

export const listWorkspaces = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<WorkspaceSummary>> =>
  listWorkspacesWithQuery(
    (text, params) => queryAs(userId, workspaceId, text, params),
    userId,
  );

export const listWorkspacesForTrustedIdentity = async (
  identity: UserIdentity,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const contextWorkspace = await resolveWorkspaceForIdentity(identity, "", "en", null);
  const result = await queryAsTrustedIdentity(identity, contextWorkspace.workspaceId, WORKSPACES_SQL, [identity.userId]);
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

  return mapSingleWorkspaceRow(result.rows, "create_workspace_for_current_user");
};

export const createWorkspaceForCurrentUserWithTimezone = async (
  userId: string,
  workspaceId: string,
  name: string,
  timezone: string,
): Promise<WorkspaceSummary> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT workspace_id, name FROM create_workspace_for_current_user($1, $2)",
    [name, timezone],
  );

  return mapSingleWorkspaceRow(result.rows, "create_workspace_for_current_user");
};

export const createWorkspaceForTrustedIdentity = async (
  identity: UserIdentity,
  name: string,
): Promise<WorkspaceSummary> => {
  const contextWorkspace = await resolveWorkspaceForIdentity(identity, "", "en", null);
  const result = await queryAsTrustedIdentity(
    identity,
    contextWorkspace.workspaceId,
    "SELECT workspace_id, name FROM create_workspace_for_current_user($1)",
    [name],
  );

  return mapSingleWorkspaceRow(result.rows, "create_workspace_for_current_user");
};

export const deleteWorkspace = async (
  userId: string,
  workspaceId: string,
  targetWorkspaceId: string,
): Promise<WorkspaceSummary> => {
  return executeDeleteWorkspaceQuery(() =>
    queryAs(
      userId,
      workspaceId,
      "SELECT workspace_id, name FROM delete_workspace_for_current_user($1)",
      [targetWorkspaceId],
    ),
  );
};

export const deleteWorkspaceForTrustedIdentity = async (
  identity: UserIdentity,
  targetWorkspaceId: string,
): Promise<WorkspaceSummary> => {
  const contextWorkspace = await resolveWorkspaceForIdentity(identity, "", "en", null);
  return executeDeleteWorkspaceQuery(() =>
    queryAsTrustedIdentity(
      identity,
      contextWorkspace.workspaceId,
      "SELECT workspace_id, name FROM delete_workspace_for_current_user($1)",
      [targetWorkspaceId],
    ),
  );
};

export const getWorkspaceForTrustedIdentity = async (
  identity: UserIdentity,
  workspaceId: string,
): Promise<WorkspaceSummary | null> => {
  const contextWorkspace = await resolveWorkspaceForIdentity(identity, "", "en", null);
  const result = await queryAsTrustedIdentity(
    identity,
    contextWorkspace.workspaceId,
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

  const row = result.rows[0] as WorkspaceRow;
  return { workspaceId: row.workspace_id, name: row.name };
};
