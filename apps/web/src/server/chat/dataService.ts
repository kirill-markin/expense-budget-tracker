/**
 * Discovery data for the web chat's agent tools, run against the browser
 * session's identity.
 *
 * Both reads go through queryAsExistingWorkspace: a read-only transaction under
 * the session user's RLS context that provisions nothing. A discovery tool call
 * therefore writes no row at all — no users upsert, no workspace_settings
 * insert, no user_settings row — and creates or joins no workspace the way
 * resolveWorkspaceForIdentity does. It can only read a workspace the session
 * user is already a member of: the workspace list is filtered by membership,
 * resolveChatWorkspace accepts only a workspaceId from that list, and RLS
 * confines every returned row independently of both.
 */
import { AgentToolError } from "@expense-budget-tracker/agent-shared/agent-results";
import {
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { getAllowedSchemaRelationsWithQuery, type SchemaRelation } from "@/server/agent/schema";
import { queryAsExistingWorkspace } from "@/server/db";
import { type QueryFn } from "@/server/db/contextRunner";
import { listWorkspacesWithQuery, type WorkspaceSummary } from "@/server/workspaces";

/** The session user and the workspace the browser chat is currently attached to. */
export type ChatWorkspaceContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type ChatSchemaLimits = Readonly<{
  maxRows: number;
  maxResultChars: number;
  statementTimeoutMs: number;
}>;

export const CHAT_SCHEMA_LIMITS: ChatSchemaLimits = {
  maxRows: MAX_SQL_ROWS,
  maxResultChars: MAX_SQL_RESULT_CHARS,
  statementTimeoutMs: MCP_SQL_STATEMENT_TIMEOUT_MS,
};

/** Read-only, non-provisioning query bound to one workspace the caller may already read. */
const buildChatDiscoveryQuery = (
  userId: string,
  workspaceId: string,
): QueryFn =>
  (text, params) => queryAsExistingWorkspace(userId, workspaceId, text, params);

export const listChatWorkspaces = (
  context: ChatWorkspaceContext,
): Promise<ReadonlyArray<WorkspaceSummary>> =>
  listWorkspacesWithQuery(
    buildChatDiscoveryQuery(context.userId, context.workspaceId),
    context.userId,
  );

export const loadAllowedSchemaForChatWorkspace = (
  context: ChatWorkspaceContext,
  workspaceId: string,
): Promise<ReadonlyArray<SchemaRelation>> =>
  getAllowedSchemaRelationsWithQuery(
    buildChatDiscoveryQuery(context.userId, workspaceId),
  );

/**
 * Mirrors selectWorkspace in apps/sql-api/src/mcp/server.ts, except for the
 * omitted case: a browser session always has an active workspace, so the chat
 * falls back to it instead of requiring exactly one accessible workspace.
 */
export const resolveChatWorkspace = (
  workspaces: ReadonlyArray<WorkspaceSummary>,
  requestedWorkspaceId: string | undefined,
  sessionWorkspaceId: string,
): WorkspaceSummary => {
  if (requestedWorkspaceId !== undefined) {
    const requestedWorkspace = workspaces.find(
      (workspace) => workspace.workspaceId === requestedWorkspaceId,
    );
    if (requestedWorkspace === undefined) {
      throw new AgentToolError(
        "workspace_not_found",
        `Workspace ${requestedWorkspaceId} is not accessible to this user`,
        "Call list_workspaces and retry with one of the returned workspaceId values.",
        { workspaceId: requestedWorkspaceId },
      );
    }
    return requestedWorkspace;
  }

  const sessionWorkspace = workspaces.find(
    (workspace) => workspace.workspaceId === sessionWorkspaceId,
  );
  if (sessionWorkspace === undefined) {
    throw new Error(
      `The active chat workspace ${sessionWorkspaceId} is missing from the workspaces accessible to this session`,
    );
  }
  return sessionWorkspace;
};
