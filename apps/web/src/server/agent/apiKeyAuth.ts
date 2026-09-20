/**
 * ApiKey transport authentication for agent-facing setup endpoints.
 *
 * Validation uses narrow SECURITY DEFINER helpers so app routes do not need
 * direct unrestricted access to key rows.
 */
import crypto from "node:crypto";
import { ACCOUNT_DISABLED_MESSAGE } from "@expense-budget-tracker/agent-shared";
import { normalizeCrockfordToken } from "@expense-budget-tracker/agent-shared/crockford";
import { type UserIdentity } from "@/server/users";
import { query, withUserOnlyContext } from "@/server/db";
import { log } from "@/server/logger";
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

/** Account state an ApiKey caller never proves and must not be allowed to assert. */
export type StoredAccountState = Readonly<{
  cognitoStatus: string;
  cognitoEnabled: boolean;
}>;

export type AgentApiKeyAuthDependencies = Readonly<{
  query: typeof query;
  loadStoredAccountState: (userId: string) => Promise<StoredAccountState | null>;
  log: typeof log;
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

/**
 * Read the stored account state for a user under that user's RLS context.
 *
 * `users` is strictly user-scoped, so app.user_id alone selects the row.
 */
export const loadStoredAccountState = async (userId: string): Promise<StoredAccountState | null> =>
  withUserOnlyContext(userId, async (queryFn) => {
    const result = await queryFn(
      "SELECT cognito_status, cognito_enabled FROM users WHERE user_id = $1",
      [userId],
    );
    if (result.rows.length > 1) {
      throw new Error(
        `loadStoredAccountState: expected at most 1 users row for ${userId}, got ${String(result.rows.length)}`,
      );
    }
    const row = result.rows[0] as Readonly<Record<string, unknown>> | undefined;
    if (row === undefined) {
      return null;
    }
    const cognitoStatus = row["cognito_status"];
    const cognitoEnabled = row["cognito_enabled"];
    if (typeof cognitoStatus !== "string" || typeof cognitoEnabled !== "boolean") {
      throw new Error(`loadStoredAccountState: user ${userId} has invalid stored account state`);
    }
    return { cognitoStatus, cognitoEnabled };
  });

const DEFAULT_AGENT_API_KEY_AUTH_DEPENDENCIES: AgentApiKeyAuthDependencies = {
  query,
  loadStoredAccountState,
  log,
};

/**
 * Authenticate an ApiKey request.
 *
 * A valid key proves only that the key exists and is unrevoked. Account state
 * comes from the stored `users` row: a disabled account is refused, and the
 * identity carries the stored `cognito_status`/`cognito_enabled` so the
 * provisioning upsert downstream writes them back unchanged instead of
 * silently re-enabling the account.
 */
export const authenticateAgentRequestWithDependencies = async (
  request: Request,
  dependencies: AgentApiKeyAuthDependencies,
): Promise<AgentAuthenticatedRequest> => {
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

  const result = await dependencies.query("SELECT * FROM auth.validate_agent_api_key($1)", [keyId]);
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

  let storedAccount: StoredAccountState | null;
  try {
    storedAccount = await dependencies.loadStoredAccountState(row.user_id);
  } catch (error) {
    // The routes answer this as an unavailable envelope, which on its own is
    // indistinguishable from a revocation wave, so the outage is logged here
    // at the one place the account-state read happens.
    dependencies.log({
      domain: "auth",
      action: "agent_auth_unavailable",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  // An empty stored status is not an active account: `users.cognito_status` is
  // NOT NULL but not non-empty, so refuse rather than treat it as usable state.
  if (storedAccount === null || !storedAccount.cognitoEnabled || storedAccount.cognitoStatus === "") {
    // Disabling the stored row is the one per-request revocation lever, so the
    // refusal is logged for the operator who pulled it.
    dependencies.log({ domain: "auth", action: "agent_account_disabled", userId: row.user_id });
    fail("account_disabled", 403, ACCOUNT_DISABLED_MESSAGE);
  }
  const trustedAccount = storedAccount as StoredAccountState;

  dependencies.query("SELECT auth.touch_agent_api_key_usage($1)", [row.connection_id]).catch(() => {});

  return {
    transport: "api_key",
    identity: {
      userId: row.user_id,
      email: trustedEmail,
      emailVerified: true,
      cognitoStatus: trustedAccount.cognitoStatus,
      cognitoEnabled: trustedAccount.cognitoEnabled,
    },
    connectionId: row.connection_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
};

export const authenticateAgentRequest = async (request: Request): Promise<AgentAuthenticatedRequest> =>
  authenticateAgentRequestWithDependencies(request, DEFAULT_AGENT_API_KEY_AUTH_DEPENDENCIES);
