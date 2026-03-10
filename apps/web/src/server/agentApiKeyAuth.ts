/**
 * ApiKey transport authentication for agent-facing setup endpoints.
 *
 * Validation uses narrow SECURITY DEFINER helpers so app routes do not need
 * direct unrestricted access to key rows.
 */
import crypto from "node:crypto";
import { COGNITO_AUTHENTICATED_STATUS, type UserIdentity } from "@/server/users";
import { normalizeCrockfordToken } from "@/server/crockford";
import { query } from "@/server/db";
import { parseAuthorizationHeader, type ParsedAuthorization } from "@/server/authHeader";

const KEY_PREFIX = "ebta";
const KEY_ID_LENGTH = 8;
const SECRET_LENGTH = 26;

type KeyLookupRow = Readonly<{
  connection_id: string;
  user_id: string;
  email: string | null;
  key_hash: string;
  revoked_at: string | null;
  last_used_at: string | null;
  label: string;
  created_at: string;
}>;

export type AgentAuthError = Error & {
  code: string;
  status: number;
};

export type AgentAuthenticatedRequest = Readonly<{
  transport: "api_key";
  identity: UserIdentity;
  connectionId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}>;

const fail = (code: string, status: number, message: string): never => {
  const error = new Error(message) as AgentAuthError;
  error.code = code;
  error.status = status;
  throw error;
};

const hashSecret = (secret: string): string =>
  crypto.createHash("sha256").update(secret).digest("hex");

const compareHashes = (expectedHex: string, actualHex: string): boolean => {
  if (expectedHex.length !== actualHex.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expectedHex), Buffer.from(actualHex));
};

export const getAgentAuthError = (error: unknown): AgentAuthError | null => {
  const candidate = error as Partial<AgentAuthError>;
  if (typeof candidate.code === "string" && typeof candidate.status === "number") {
    return candidate as AgentAuthError;
  }
  return null;
};

export const authenticateAgentRequest = async (request: Request): Promise<AgentAuthenticatedRequest> => {
  const parsedAuthorization = parseAuthorizationHeader(request.headers.get("authorization"));
  if (parsedAuthorization === null) {
    fail("missing_api_key", 401, "Missing ApiKey authorization");
  }

  const parsedCandidate = parsedAuthorization as ParsedAuthorization;
  if (parsedCandidate.transport !== "api_key") {
    fail("missing_api_key", 401, "Missing ApiKey authorization");
  }

  const parsed = parsedCandidate;
  let keyId = "";
  let secret = "";
  try {
    const normalizedCredentials = parsed.credentials.replace(/[\s-]/g, "").toUpperCase();
    const parts = normalizedCredentials.split("_");
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX.toUpperCase()) {
      fail("invalid_api_key", 401, "Invalid ApiKey format");
    }

    keyId = normalizeCrockfordToken(parts[1] ?? "", "agent ApiKey keyId");
    secret = normalizeCrockfordToken(parts[2] ?? "", "agent ApiKey secret");
    if (keyId.length !== KEY_ID_LENGTH || secret.length !== SECRET_LENGTH) {
      fail("invalid_api_key", 401, "Invalid ApiKey format");
    }
  } catch {
    fail("invalid_api_key", 401, "Invalid ApiKey format");
  }

  const result = await query("SELECT * FROM auth.validate_agent_api_key($1)", [keyId]);
  if (result.rows.length !== 1) {
    fail("invalid_api_key", 401, "Invalid ApiKey");
  }

  const row = result.rows[0] as KeyLookupRow;
  if (row.revoked_at !== null) {
    fail("api_key_revoked", 401, "This agent API key has been revoked");
  }

  if (!compareHashes(row.key_hash, hashSecret(secret))) {
    fail("invalid_api_key", 401, "Invalid ApiKey");
  }

  const email = row.email;
  if (email === null || email === "") {
    fail("missing_user_profile", 500, "Agent key user profile is not provisioned");
  }
  const trustedEmail = email as string;

  query("SELECT auth.touch_agent_api_key_usage($1)", [row.connection_id]).catch(() => {});

  return {
    transport: "api_key",
    identity: {
      userId: row.user_id,
      email: trustedEmail,
      emailVerified: true,
      cognitoStatus: COGNITO_AUTHENTICATED_STATUS,
      cognitoEnabled: true,
    },
    connectionId: row.connection_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
};
