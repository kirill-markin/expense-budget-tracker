/**
 * Agent API key issuance for terminal-first onboarding.
 *
 * Keys are user-owned long-lived connection credentials. They are not SQL API
 * keys and are stored separately from workspace-scoped machine tokens.
 */
import crypto from "node:crypto";
import { createCrockfordToken } from "../crockford.js";
import { withTransaction } from "../db.js";

const KEY_ID_LENGTH = 8;
const SECRET_LENGTH = 26;
const KEY_PREFIX = "ebta";

const hashSecret = (secret: string): string =>
  crypto.createHash("sha256").update(secret).digest("hex");

export type AgentConnectionResult = Readonly<{
  connectionId: string;
  createdAt: string;
  label: string;
  apiKey: string;
}>;

type QueryResultRow = Readonly<Record<string, unknown>>;
type QueryResultLike = Readonly<{
  rows: ReadonlyArray<QueryResultRow>;
}>;
type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResultLike>;
type TransactionRunner = <T>(callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;

const DEFAULT_FIRST_WORKSPACE_NAME = "My Workspace";
const DEFAULT_WORKSPACE_TIMEZONE = "UTC";

const readSelectedWorkspaceId = (rows: ReadonlyArray<QueryResultRow>): string | null => {
  if (rows.length !== 1) {
    throw new Error(`resolve_login_workspace_id: expected 1 row, got ${rows.length}`);
  }

  const workspaceId = rows[0]?.["workspace_id"];
  if (workspaceId === null) {
    return null;
  }
  if (typeof workspaceId !== "string") {
    throw new Error("resolve_login_workspace_id: workspace_id must be string or null");
  }
  return workspaceId;
};

export const createAgentConnectionWithTransaction = async (
  userId: string,
  email: string,
  label: string,
  runInTransaction: TransactionRunner,
): Promise<AgentConnectionResult> => {
  const trimmedLabel = label.trim();
  if (trimmedLabel === "" || trimmedLabel.length > 200) {
    throw new Error("Agent connection label must be 1-200 characters");
  }

  const keyId = createCrockfordToken(KEY_ID_LENGTH);
  const secret = createCrockfordToken(SECRET_LENGTH);
  const keyHash = hashSecret(secret);
  const apiKey = `${KEY_PREFIX}_${keyId}_${secret}`;

  return runInTransaction(async (queryFn) => {
    await queryFn("SELECT auth.sync_authenticated_user($1, $2)", [userId, email]);
    const workspaceResult = await queryFn(
      "SELECT auth.resolve_login_workspace_id($1, $2, $3) AS workspace_id",
      [userId, DEFAULT_FIRST_WORKSPACE_NAME, DEFAULT_WORKSPACE_TIMEZONE],
    );
    const selectedWorkspaceId = readSelectedWorkspaceId(workspaceResult.rows);

    const result = await queryFn(
      `INSERT INTO auth.agent_api_keys (user_id, label, key_id, key_hash, selected_workspace_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING connection_id, created_at`,
      [userId, trimmedLabel, keyId, keyHash, selectedWorkspaceId],
    );

    if (result.rows.length !== 1) {
      throw new Error(`createAgentConnection: expected 1 row, got ${result.rows.length}`);
    }

    const connectionId = result.rows[0]?.["connection_id"];
    const createdAt = result.rows[0]?.["created_at"];
    if (typeof connectionId !== "string" || typeof createdAt !== "string") {
      throw new Error("createAgentConnection: expected string connection_id and created_at");
    }

    return {
      connectionId,
      createdAt,
      label: trimmedLabel,
      apiKey,
    };
  });
};

export const createAgentConnection = async (
  userId: string,
  email: string,
  label: string,
): Promise<AgentConnectionResult> =>
  createAgentConnectionWithTransaction(userId, email, label, withTransaction);
