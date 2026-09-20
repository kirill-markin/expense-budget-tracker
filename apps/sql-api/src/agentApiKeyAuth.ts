/**
 * Agent ApiKey validation.
 *
 * Validates agent ApiKey tokens against the database using the same
 * SECURITY DEFINER function (auth.validate_agent_api_key) as the web app, and
 * returns the authorizer context fields the machine API reads.
 *
 * Shared by the API Gateway Lambda authorizer (apps/sql-api/src/authorizer.ts)
 * and the container entry point for the machine API, so both surfaces accept
 * exactly the same keys.
 */

import crypto from "node:crypto";
import { normalizeCrockfordToken } from "@expense-budget-tracker/agent-shared/crockford";
import { query } from "./db.js";

export type AgentApiKeyAuthDependencies = Readonly<{
  query: typeof query;
}>;

export type AgentApiKeyContext = Readonly<{
  userId: string;
  email: string;
  connectionId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
}>;

type AgentApiKeyRow = Readonly<{
  connection_id: string;
  user_id: string;
  email: string | null;
  key_hash: string;
  revoked_at: string | null;
  last_used_at: string | null;
  label: string;
  created_at: string;
}>;

const AUTHORIZATION_SCHEME = "ApiKey ";
const KEY_PREFIX = "EBTA";
const KEY_ID_LENGTH = 8;
const SECRET_LENGTH = 26;

const hashSecret = (secret: string): string =>
  crypto.createHash("sha256").update(secret).digest("hex");

/**
 * Returns the authenticated context for a valid `ApiKey <key>` authorization
 * value, or null for every rejection. Key usage is touched fire-and-forget on
 * success, exactly as the Lambda authorizer has always done.
 */
export const validateAgentApiKeyAuthorization = async (
  authorization: string,
  dependencies: AgentApiKeyAuthDependencies,
): Promise<AgentApiKeyContext | null> => {
  if (!authorization.startsWith(AUTHORIZATION_SCHEME)) {
    return null;
  }

  const credentials = authorization.slice(AUTHORIZATION_SCHEME.length).replace(/[\s-]/g, "").toUpperCase();
  const parts = credentials.split("_");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
    return null;
  }

  let keyId = "";
  let secret = "";
  try {
    keyId = normalizeCrockfordToken(parts[1] ?? "", "agent ApiKey keyId");
    secret = normalizeCrockfordToken(parts[2] ?? "", "agent ApiKey secret");
  } catch {
    return null;
  }

  if (keyId.length !== KEY_ID_LENGTH || secret.length !== SECRET_LENGTH) {
    return null;
  }

  const result = await dependencies.query("SELECT * FROM auth.validate_agent_api_key($1)", [keyId]);
  if (result.rows.length !== 1) {
    return null;
  }

  const row = result.rows[0] as AgentApiKeyRow;
  if (row.revoked_at !== null || row.email === null || row.email === "" || row.key_hash !== hashSecret(secret)) {
    return null;
  }

  dependencies.query("SELECT auth.touch_agent_api_key_usage($1)", [row.connection_id]).catch(() => {});

  return {
    userId: row.user_id,
    email: row.email,
    connectionId: row.connection_id,
    label: row.label,
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? "" : String(row.last_used_at),
  };
};
