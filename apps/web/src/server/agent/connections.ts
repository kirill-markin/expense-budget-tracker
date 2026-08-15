/**
 * Agent connection management for human settings and agent key metadata.
 */
import { z } from "zod";
import type { QueryResult } from "pg";

import { queryAs } from "@/server/db";

export type AgentConnectionType = "api_key" | "oauth";

type AgentConnectionBase = Readonly<{
  connectionId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}>;

export type ApiKeyAgentConnectionRow = AgentConnectionBase & Readonly<{
  type: "api_key";
  lastUsedAt: string | null;
}>;

export type OAuthAgentConnectionRow = AgentConnectionBase & Readonly<{
  type: "oauth";
  lastActivityAt: string | null;
}>;

export type AgentConnectionRow = ApiKeyAgentConnectionRow | OAuthAgentConnectionRow;

type QueryAsFn = (
  userId: string,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
) => Promise<QueryResult>;

export type AgentConnectionDependencies = Readonly<{
  queryAs: QueryAsFn;
}>;

export type AgentConnectionRevocationDependencies = Readonly<{
  revokeApiKeyConnection: (
    userId: string,
    workspaceId: string,
    connectionId: string,
  ) => Promise<boolean>;
  revokeOAuthConnection: (
    userId: string,
    workspaceId: string,
    connectionId: string,
  ) => Promise<boolean>;
}>;

const timestampSchema = z.union([z.string().datetime({ offset: true }), z.date()])
  .transform((value): string => value instanceof Date ? value.toISOString() : value);

const nullableTimestampSchema = z.union([timestampSchema, z.null()]);

const apiKeyConnectionSchema = z.object({
  connection_id: z.string().min(1),
  label: z.string().min(1),
  created_at: timestampSchema,
  last_used_at: nullableTimestampSchema,
  revoked_at: nullableTimestampSchema,
});

const oauthConnectionSchema = z.object({
  connection_id: z.string().min(1),
  client_name: z.string().min(1),
  created_at: timestampSchema,
  last_activity_at: nullableTimestampSchema,
  revoked_at: nullableTimestampSchema,
});

const DEFAULT_DEPENDENCIES: AgentConnectionDependencies = { queryAs };

const mapApiKeyConnection = (row: unknown): ApiKeyAgentConnectionRow => {
  const parsed = apiKeyConnectionSchema.parse(row);
  return {
    type: "api_key",
    connectionId: parsed.connection_id,
    label: parsed.label,
    createdAt: parsed.created_at,
    lastUsedAt: parsed.last_used_at,
    revokedAt: parsed.revoked_at,
  };
};

const mapOAuthConnection = (row: unknown): OAuthAgentConnectionRow => {
  const parsed = oauthConnectionSchema.parse(row);
  return {
    type: "oauth",
    connectionId: parsed.connection_id,
    label: parsed.client_name,
    createdAt: parsed.created_at,
    lastActivityAt: parsed.last_activity_at,
    revokedAt: parsed.revoked_at,
  };
};

const listApiKeyConnections = async (
  userId: string,
  workspaceId: string,
  dependencies: AgentConnectionDependencies,
): Promise<ReadonlyArray<ApiKeyAgentConnectionRow>> => {
  const result = await dependencies.queryAs(
    userId,
    workspaceId,
    `SELECT connection_id, label, created_at, last_used_at, revoked_at
     FROM auth.agent_api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );

  return result.rows.map(mapApiKeyConnection);
};

const listOAuthConnections = async (
  userId: string,
  workspaceId: string,
  dependencies: AgentConnectionDependencies,
): Promise<ReadonlyArray<OAuthAgentConnectionRow>> => {
  const result = await dependencies.queryAs(
    userId,
    workspaceId,
    `SELECT connection_id, client_name, created_at, last_activity_at, revoked_at
     FROM auth.list_current_user_oauth_connections()`,
    [],
  );

  return result.rows.map(mapOAuthConnection);
};

export const listAgentConnectionsWithDependencies = async (
  userId: string,
  workspaceId: string,
  dependencies: AgentConnectionDependencies,
): Promise<ReadonlyArray<AgentConnectionRow>> => {
  const [apiKeyConnections, oauthConnections] = await Promise.all([
    listApiKeyConnections(userId, workspaceId, dependencies),
    listOAuthConnections(userId, workspaceId, dependencies),
  ]);

  return [...apiKeyConnections, ...oauthConnections].toSorted(
    (first, second): number => Date.parse(second.createdAt) - Date.parse(first.createdAt),
  );
};

export const listAgentConnections = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<AgentConnectionRow>> =>
  listAgentConnectionsWithDependencies(userId, workspaceId, DEFAULT_DEPENDENCIES);

export const revokeApiKeyConnection = async (
  userId: string,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> => {
  const result = await queryAs(
    userId,
    workspaceId,
    `UPDATE auth.agent_api_keys
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE connection_id = $1
       AND user_id = $2
     RETURNING connection_id`,
    [connectionId, userId],
  );

  return result.rows.length === 1;
};

export const revokeOAuthConnection = async (
  userId: string,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT auth.revoke_current_user_oauth_connection($1) AS revoked",
    [connectionId],
  );

  if (result.rows.length !== 1) {
    throw new Error(`revokeOAuthConnection: expected 1 row, got ${result.rows.length}`);
  }
  const parsed = z.object({ revoked: z.boolean() }).parse(result.rows[0]);
  return parsed.revoked;
};

export const revokeAgentConnectionByType = (
  type: AgentConnectionType,
  userId: string,
  workspaceId: string,
  connectionId: string,
  dependencies: AgentConnectionRevocationDependencies,
): Promise<boolean> => {
  if (type === "api_key") {
    return dependencies.revokeApiKeyConnection(userId, workspaceId, connectionId);
  }
  if (type === "oauth") {
    return dependencies.revokeOAuthConnection(userId, workspaceId, connectionId);
  }
  throw new Error(`Unsupported agent connection type: ${String(type)}`);
};
