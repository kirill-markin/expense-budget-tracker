/**
 * API key management: generate, list, and revoke API keys for the SQL API.
 *
 * Key format: ebt_ + 40 alphanumeric chars (~238 bits entropy).
 * Storage: SHA-256 hash only — plaintext never stored.
 * Validation is handled by the Lambda Authorizer (apps/sql-api).
 */
import crypto from "node:crypto";

import { queryAs } from "@/server/db";

// -- Key generation --------------------------------------------------------

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const KEY_PREFIX = "ebt_";
const KEY_BODY_LENGTH = 40;
const REJECTION_LIMIT = 248; // largest multiple of 62 that fits in a byte

/** Generate an API key: ebt_ + 40 random alphanumeric chars. */
export const generateApiKey = (): string => {
  const chars: Array<string> = [];
  while (chars.length < KEY_BODY_LENGTH) {
    const bytes = crypto.randomBytes(KEY_BODY_LENGTH);
    for (const b of bytes) {
      if (b < REJECTION_LIMIT && chars.length < KEY_BODY_LENGTH) {
        chars.push(ALPHABET[b % ALPHABET.length]);
      }
    }
  }
  return KEY_PREFIX + chars.join("");
};

/** SHA-256 hex digest of the full key. */
export const hashKey = (key: string): string =>
  crypto.createHash("sha256").update(key).digest("hex");

// -- Types -----------------------------------------------------------------

export type ApiKeyRow = Readonly<{
  id: string;
  keyPrefix: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}>;

// -- CRUD ------------------------------------------------------------------

/** List all API keys for the current user in a workspace (no secrets). */
export const listApiKeys = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<ApiKeyRow>> => {
  const result = await queryAs(
    userId,
    workspaceId,
    `SELECT id, key_prefix, label, created_at, last_used_at
     FROM api_keys
     WHERE workspace_id = $1 AND user_id = $2
     ORDER BY created_at DESC`,
    [workspaceId, userId],
  );

  return result.rows.map((row) => {
    const r = row as { id: string; key_prefix: string; label: string; created_at: string; last_used_at: string | null };
    return {
      id: r.id,
      keyPrefix: r.key_prefix,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  });
};

/** Create a new API key. Returns the full key (show-once) and metadata. */
export const createApiKey = async (
  userId: string,
  workspaceId: string,
  label: string,
): Promise<Readonly<{ id: string; key: string; keyPrefix: string }>> => {
  const key = generateApiKey();
  const keyHash = hashKey(key);
  const keyPrefix = key.slice(0, 8);

  const result = await queryAs(
    userId,
    workspaceId,
    `INSERT INTO api_keys (workspace_id, user_id, key_hash, key_prefix, label)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [workspaceId, userId, keyHash, keyPrefix, label],
  );

  const id = (result.rows[0] as { id: string }).id;
  return { id, key, keyPrefix };
};

/** Revoke (delete) an API key by ID. */
export const revokeApiKey = async (
  userId: string,
  workspaceId: string,
  keyId: string,
): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    "DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2 AND user_id = $3",
    [keyId, workspaceId, userId],
  );
};

