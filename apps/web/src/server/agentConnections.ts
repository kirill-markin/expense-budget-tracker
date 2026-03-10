/**
 * Agent connection management for human settings and agent key metadata.
 */
import { queryAs } from "@/server/db";

export type AgentConnectionRow = Readonly<{
  connectionId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}>;

export const listAgentConnections = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<AgentConnectionRow>> => {
  const result = await queryAs(
    userId,
    workspaceId,
    `SELECT connection_id, label, created_at, last_used_at, revoked_at
     FROM auth.agent_api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );

  return result.rows.map((row) => {
    const typedRow = row as {
      connection_id: string;
      label: string;
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    };
    return {
      connectionId: typedRow.connection_id,
      label: typedRow.label,
      createdAt: typedRow.created_at,
      lastUsedAt: typedRow.last_used_at,
      revokedAt: typedRow.revoked_at,
    };
  });
};

export const revokeAgentConnection = async (
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
