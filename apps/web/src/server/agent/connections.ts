/**
 * Agent connection management for human settings and agent key metadata.
 */
import { z } from "zod";
import type { QueryResult } from "pg";
import {
  AGENT_API_KEY_ID_LENGTH,
  AGENT_API_KEY_PREFIX,
  AGENT_API_KEY_SECRET_LENGTH,
  createCrockfordToken,
  hashOpaqueToken,
} from "@expense-budget-tracker/agent-shared/crockford";

import { queryAs, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";

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

/** The plaintext key is in this result once, at issuance, and nowhere else. */
export type CreatedApiKeyConnection = Readonly<{
  connectionId: string;
  label: string;
  createdAt: string;
  apiKey: string;
}>;

export type CreateApiKeyConnectionResult =
  | Readonly<{ kind: "created"; connection: CreatedApiKeyConnection }>
  | Readonly<{ kind: "refused_active_limit"; activeCount: number; limit: number }>;

export const AGENT_CONNECTION_LABEL_MAX_LENGTH = 200;

/**
 * How many un-revoked API keys one user may hold at once.
 *
 * In AUTH_MODE=proxy_jwt a key is minted on the browser session alone: the
 * edge has already authenticated the person, and there is no second factor
 * left to ask for. The OTP issuer is throttled upstream by
 * auth.agent_otp_send_events; this path has no equivalent, so whoever holds a
 * session could otherwise mint unbounded credentials that outlive it. The cap
 * is what bounds that blast radius, and every key it admits is listed and
 * revocable on the same settings page.
 *
 * 25 is far above what a real self-hoster needs — one key per agent client,
 * machine or script, for a deployment that is usually one person — while
 * keeping an abused session to a fixed, small, visible number of keys. Revoked
 * keys do not count, so rotation is never blocked by the cap.
 */
export const MAX_ACTIVE_API_KEY_CONNECTIONS = 25;

type QueryAsFn = (
  userId: string,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
) => Promise<QueryResult>;

export type AgentConnectionDependencies = Readonly<{
  queryAs: QueryAsFn;
}>;

/**
 * Creation needs several statements on one connection, not one statement, so
 * the advisory lock, the count and the insert share a transaction.
 */
export type AgentConnectionCreationDependencies = Readonly<{
  withUserContext: <T>(
    userId: string,
    workspaceId: string,
    callback: (queryFn: QueryFn) => Promise<T>,
  ) => Promise<T>;
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

const createdApiKeyConnectionSchema = z.object({
  connection_id: z.string().min(1),
  created_at: timestampSchema,
});

const activeApiKeyCountSchema = z.object({
  active_count: z.string().regex(/^(?:0|[1-9]\d*)$/u).transform(Number),
});

/**
 * Same key derivation as the other per-user serialization points
 * (`upsertUserIdentity` in @/server/users, the chat turn rate counter, the
 * workspace bootstrap helpers in db/migrations/0039_workspace_bootstrap_helpers.sql),
 * so one user's writes queue behind each other instead of racing.
 */
const LOCK_USER_AGENT_API_KEYS_SQL = `
  SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64))::bigint)
`;

const COUNT_ACTIVE_API_KEY_CONNECTIONS_SQL = `
  SELECT COUNT(*)::text AS active_count
  FROM auth.agent_api_keys
  WHERE user_id = $1
    AND revoked_at IS NULL
`;

const INSERT_API_KEY_CONNECTION_SQL = `
  INSERT INTO auth.agent_api_keys (user_id, label, key_id, key_hash, selected_workspace_id)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING connection_id, created_at
`;

const DEFAULT_DEPENDENCIES: AgentConnectionDependencies = { queryAs };

const DEFAULT_CREATION_DEPENDENCIES: AgentConnectionCreationDependencies = { withUserContext };

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

/**
 * Mints an agent API key for the caller's own user, in the key format the
 * machine API and MCP authorizer parse. Only the sha256 hash of the secret is
 * stored, so the returned `apiKey` is the single copy that will ever exist.
 * The active workspace is selected for the new key, so `/v1` SQL works without
 * a separate select call.
 *
 * The lock, the count and the insert run in one transaction on one connection.
 * Without the lock a burst of concurrent creations would all count before any
 * of them committed its insert, and the cap would overshoot by the caller's
 * concurrency instead of holding. The lock is transaction-scoped, so it always
 * releases on COMMIT or ROLLBACK.
 *
 * The secret is generated only once the cap has admitted the request, so a
 * refusal never produces a credential.
 */
export const createApiKeyConnectionWithDependencies = async (
  userId: string,
  workspaceId: string,
  label: string,
  dependencies: AgentConnectionCreationDependencies,
): Promise<CreateApiKeyConnectionResult> => {
  const trimmedLabel = label.trim();
  if (trimmedLabel === "" || trimmedLabel.length > AGENT_CONNECTION_LABEL_MAX_LENGTH) {
    throw new Error(
      `Agent connection label must be 1-${AGENT_CONNECTION_LABEL_MAX_LENGTH} characters, received ${trimmedLabel.length}`,
    );
  }

  return dependencies.withUserContext(userId, workspaceId, async (queryFn): Promise<CreateApiKeyConnectionResult> => {
    await queryFn(LOCK_USER_AGENT_API_KEYS_SQL, [userId]);

    const countResult = await queryFn(COUNT_ACTIVE_API_KEY_CONNECTIONS_SQL, [userId]);
    if (countResult.rows.length !== 1) {
      throw new Error(`createApiKeyConnection: expected 1 count row, got ${countResult.rows.length}`);
    }
    const activeCount = activeApiKeyCountSchema.parse(countResult.rows[0]).active_count;
    if (activeCount >= MAX_ACTIVE_API_KEY_CONNECTIONS) {
      return {
        kind: "refused_active_limit",
        activeCount,
        limit: MAX_ACTIVE_API_KEY_CONNECTIONS,
      };
    }

    const keyId = createCrockfordToken(AGENT_API_KEY_ID_LENGTH);
    const secret = createCrockfordToken(AGENT_API_KEY_SECRET_LENGTH);
    const result = await queryFn(
      INSERT_API_KEY_CONNECTION_SQL,
      [userId, trimmedLabel, keyId, hashOpaqueToken(secret), workspaceId],
    );

    if (result.rows.length !== 1) {
      throw new Error(`createApiKeyConnection: expected 1 row, got ${result.rows.length}`);
    }
    const parsed = createdApiKeyConnectionSchema.parse(result.rows[0]);

    return {
      kind: "created",
      connection: {
        connectionId: parsed.connection_id,
        label: trimmedLabel,
        createdAt: parsed.created_at,
        apiKey: `${AGENT_API_KEY_PREFIX}_${keyId}_${secret}`,
      },
    };
  });
};

export const createApiKeyConnection = async (
  userId: string,
  workspaceId: string,
  label: string,
): Promise<CreateApiKeyConnectionResult> =>
  createApiKeyConnectionWithDependencies(userId, workspaceId, label, DEFAULT_CREATION_DEPENDENCIES);

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
