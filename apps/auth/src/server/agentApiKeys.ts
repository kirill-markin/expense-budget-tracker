/**
 * Agent API key issuance for terminal-first onboarding.
 *
 * Keys are user-owned long-lived connection credentials. They are not SQL API
 * keys and are stored separately from workspace-scoped machine tokens.
 */
import crypto from "node:crypto";
import { createCrockfordToken } from "./crockford.js";
import { withTransaction } from "./db.js";

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

export const createAgentConnection = async (
  userId: string,
  email: string,
  label: string,
): Promise<AgentConnectionResult> => {
  const trimmedLabel = label.trim();
  if (trimmedLabel === "" || trimmedLabel.length > 200) {
    throw new Error("Agent connection label must be 1-200 characters");
  }

  const keyId = createCrockfordToken(KEY_ID_LENGTH);
  const secret = createCrockfordToken(SECRET_LENGTH);
  const keyHash = hashSecret(secret);
  const apiKey = `${KEY_PREFIX}_${keyId}_${secret}`;

  return withTransaction(async (queryFn) => {
    await queryFn("SELECT auth.sync_authenticated_user($1, $2)", [userId, email]);
    const result = await queryFn(
      `INSERT INTO auth.agent_api_keys (user_id, label, key_id, key_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING connection_id, created_at`,
      [userId, trimmedLabel, keyId, keyHash],
    );

    if (result.rows.length !== 1) {
      throw new Error(`createAgentConnection: expected 1 row, got ${result.rows.length}`);
    }

    const row = result.rows[0] as { connection_id: string; created_at: string };
    return {
      connectionId: row.connection_id,
      createdAt: row.created_at,
      label: trimmedLabel,
      apiKey,
    };
  });
};
