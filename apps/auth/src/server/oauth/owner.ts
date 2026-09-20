/**
 * Who may hold OAuth credentials, decided by the identity provider of the
 * running mode.
 *
 * In `cognito` the user pool is the authority, so the owner check is the
 * Cognito AdminGetUser lookup and consent keeps writing the Cognito account
 * state into the mirror. In `proxy_jwt` there is no user pool to ask: the
 * `public.users` mirror is the authority, read through the same
 * `cognito_enabled` lever and the same active-status allowlist the MCP
 * access-token gate applies, so one switch governs both surfaces. Consent then
 * records the identity without raising that state, which is what makes the
 * check worth making.
 */
import {
  PROXY_AUTHENTICATED_STATUS,
  isActiveUserStatus,
} from "@expense-budget-tracker/agent-shared/account-status";
import { getAuthServiceMode, type AuthServiceMode } from "../authMode.js";
import { getCognitoOAuthOwnerStatus } from "../cognitoUserStatus.js";
import type { QueryFn } from "../db.js";

export type OAuthOwnerStatus = "active" | "inactive";

export type OAuthOwnerPolicy = Readonly<{
  /** Whether the account behind `userId` may receive or keep OAuth credentials. */
  readOwnerStatus: (userId: string, queryFn: QueryFn) => Promise<OAuthOwnerStatus>;
  /** Record the authenticated identity inside the consent transaction. */
  syncAuthenticatedUser: (queryFn: QueryFn, userId: string, email: string) => Promise<void>;
}>;

const readProxyOwnerStatus = async (
  userId: string,
  queryFn: QueryFn,
): Promise<OAuthOwnerStatus> => {
  const result = await queryFn(
    "SELECT account_status, account_enabled FROM auth.get_oauth_owner_account_state($1)",
    [userId],
  );
  // No mirror row means this edge-authenticated subject has never been seen,
  // not that it was disabled: the consent transaction below creates the row.
  // Revocation is an existing row saying so, and the MCP gate refuses a token
  // whose user has no mirror row at all.
  if (result.rows.length === 0) return "active";
  if (result.rows.length !== 1) {
    throw new Error(`readOwnerStatus: expected at most 1 account-state row, got ${result.rows.length}`);
  }
  const row = result.rows[0] as Readonly<Record<string, unknown>>;
  const status = row["account_status"];
  const enabled = row["account_enabled"];
  if (typeof status !== "string" || status === "") {
    throw new Error("readOwnerStatus: account_status must be a non-empty string");
  }
  if (typeof enabled !== "boolean") {
    throw new Error("readOwnerStatus: account_enabled must be a boolean");
  }
  return enabled && isActiveUserStatus(status) ? "active" : "inactive";
};

const cognitoOAuthOwnerPolicy: OAuthOwnerPolicy = {
  readOwnerStatus: (userId: string): Promise<OAuthOwnerStatus> => getCognitoOAuthOwnerStatus(userId),
  syncAuthenticatedUser: async (queryFn: QueryFn, userId: string, email: string): Promise<void> => {
    await queryFn("SELECT auth.sync_authenticated_user($1, $2)", [userId, email]);
  },
};

const proxyOAuthOwnerPolicy: OAuthOwnerPolicy = {
  readOwnerStatus: readProxyOwnerStatus,
  syncAuthenticatedUser: async (queryFn: QueryFn, userId: string, email: string): Promise<void> => {
    await queryFn(
      "SELECT auth.mirror_authenticated_user($1, $2, $3)",
      [userId, email, PROXY_AUTHENTICATED_STATUS],
    );
  },
};

export const getOAuthOwnerPolicy = (mode: AuthServiceMode): OAuthOwnerPolicy => {
  switch (mode) {
    case "cognito":
      return cognitoOAuthOwnerPolicy;
    case "proxy_jwt":
      return proxyOAuthOwnerPolicy;
    default: {
      // A new AuthServiceMode must choose its owner policy deliberately: this
      // gate decides who may hold OAuth credentials, so defaulting is wrong.
      const unreachable: never = mode;
      throw new Error(`Unsupported auth service mode: ${String(unreachable)}`);
    }
  }
};

/**
 * The policy of the mode this process runs in, resolved per call so the store
 * module can be imported before the environment is validated.
 */
export const runtimeOAuthOwnerPolicy: OAuthOwnerPolicy = {
  readOwnerStatus: (userId: string, queryFn: QueryFn): Promise<OAuthOwnerStatus> =>
    getOAuthOwnerPolicy(getAuthServiceMode(process.env)).readOwnerStatus(userId, queryFn),
  syncAuthenticatedUser: (queryFn: QueryFn, userId: string, email: string): Promise<void> =>
    getOAuthOwnerPolicy(getAuthServiceMode(process.env)).syncAuthenticatedUser(queryFn, userId, email),
};
