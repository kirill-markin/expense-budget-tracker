/**
 * Postgres connection pool and query helpers.
 *
 * query()           — bare pool.query, no RLS context. Used only for global
 *                     tables (exchange_rates) and readiness checks.
 * queryAs()         — single statement in a transaction with app.user_id and
 *                     app.workspace_id set.
 * withUserContext() — multiple statements in one transaction with app.user_id
 *                     and app.workspace_id. The callback receives a bound
 *                     queryFn sharing one client.
 * withRestrictedUserContext() — same as withUserContext(), but user SQL runs
 *                     as api_sql_executor after the RLS context is set.
 */
import pg from "pg";
import { headers } from "next/headers";

import { getLocaleCookie } from "@/lib/localeCookie";
import { COGNITO_AUTHENTICATED_STATUS, ensureUserSettingsRow, LOCAL_USER_STATUS, type UserIdentity, upsertUserIdentity } from "@/server/users";
import { extractUserEmailFromHeaders, extractUserEmailVerifiedFromHeaders, extractUserIdFromHeaders } from "@/server/userId";

// AUTH_MODE=cognito means production behind ALB → always RDS → always SSL.
// In cognito mode, construct the URL from individual env vars (ECS injects DB_PASSWORD from Secrets Manager).
if (process.env.AUTH_MODE === "cognito") {
  const required = ["DB_USER", "DB_PASSWORD", "DB_HOST", "DB_NAME"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars for cognito mode: ${missing.join(", ")}`);
  }
}

const connectionString = process.env.AUTH_MODE === "cognito"
  ? `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD!)}@${process.env.DB_HOST}:5432/${process.env.DB_NAME}`
  : process.env.DATABASE_URL;

// ssl:true enables full certificate verification. RDS certs are signed by
// Amazon's CA (not in Node.js defaults), so NODE_EXTRA_CA_CERTS must point
// to the RDS CA bundle (set in CDK, bundle downloaded in Dockerfile).
const ssl = process.env.AUTH_MODE === "cognito" ? true : false;

const pool = new pg.Pool({ connectionString, ssl });

/** User/workspace pairs already verified to exist in this process. */
const provisionedMemberships = new Set<string>();

/** Users whose settings row is already verified to exist in this process. */
const provisionedUsers = new Set<string>();

/** Stable cache key for membership provisioning checks. */
const getMembershipCacheKey = (userId: string, workspaceId: string): string =>
  `${userId}:${workspaceId}`;

// Only these unique violations are expected during concurrent first-request
// provisioning. Anything else (for example users.email uniqueness) must fail
// loudly instead of being treated as a harmless race.
const EXPECTED_PROVISIONING_CONSTRAINTS: ReadonlySet<string> = new Set([
  "workspaces_pkey",
  "workspace_members_pkey",
  "workspace_settings_pkey",
]);

type PgError = Error & Readonly<{
  code?: string;
  constraint?: string;
}>;

/** Narrow PostgreSQL unique-violation handling to known concurrent inserts. */
const isExpectedProvisioningConflict = (error: unknown): boolean => {
  const pgError = error as PgError;
  return pgError.code === "23505"
    && typeof pgError.constraint === "string"
    && EXPECTED_PROVISIONING_CONSTRAINTS.has(pgError.constraint);
};

/**
 * Re-read the required rows after an expected race conflict.
 *
 * This avoids marking in-memory caches as provisioned until the committed DB
 * state is known to contain every row the rest of the app relies on.
 */
const verifyProvisionedState = async (userId: string, workspaceId: string): Promise<void> => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

    const missing: Array<string> = [];

    const userCheck = await client.query(
      "SELECT 1 FROM users WHERE user_id = $1",
      [userId],
    );
    if (userCheck.rows.length === 0) {
      missing.push("users");
    }

    const membershipCheck = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    if (membershipCheck.rows.length === 0) {
      missing.push("workspace_members");
    }

    const workspaceSettingsCheck = await client.query(
      "SELECT 1 FROM workspace_settings WHERE workspace_id = $1",
      [workspaceId],
    );
    if (workspaceSettingsCheck.rows.length === 0) {
      missing.push("workspace_settings");
    }

    const userSettingsCheck = await client.query(
      "SELECT 1 FROM user_settings WHERE user_id = $1",
      [userId],
    );
    if (userSettingsCheck.rows.length === 0) {
      missing.push("user_settings");
    }

    await client.query("COMMIT");
    committed = true;

    if (missing.length > 0) {
      throw new Error(
        `Provisioning verification failed for user ${userId} in workspace ${workspaceId}: missing ${missing.join(", ")}`,
      );
    }
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Read the current authenticated identity from trusted proxy headers.
 *
 * The headers are written only after proxy.ts verifies the Cognito ID token, so
 * downstream server code can treat these values as already authenticated.
 */
const getCurrentIdentity = async (): Promise<UserIdentity> => {
  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const email = extractUserEmailFromHeaders(headersList);
  const emailVerified = extractUserEmailVerifiedFromHeaders(headersList);

  return {
    userId,
    email,
    emailVerified,
    cognitoStatus: userId === "local" ? LOCAL_USER_STATUS : COGNITO_AUTHENTICATED_STATUS,
    cognitoEnabled: true,
  };
};

/**
 * Ensure the current user identity mirror and required personal rows exist.
 *
 * Uses in-memory caches for stable rows (workspace membership and user settings)
 * but always upserts the users row so active identities stay synchronized.
 *
 * Personal workspaces keep the existing invariant `workspace_id = user_id`.
 * Non-personal workspaces are never auto-created here; they must already have a
 * membership row or the request fails explicitly.
 */
export const ensureUserProvisioned = async (userId: string, workspaceId: string): Promise<void> => {
  const identity = await getCurrentIdentity();
  if (identity.userId !== userId) {
    throw new Error(`Identity header mismatch: expected user ${userId}, got ${identity.userId}`);
  }
  const initialLocale = await getLocaleCookie();
  const membershipKey = getMembershipCacheKey(userId, workspaceId);
  const shouldCacheMembership = !provisionedMemberships.has(membershipKey);
  const shouldCacheUser = !provisionedUsers.has(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await upsertUserIdentity(client, identity);

    if (shouldCacheMembership) {
      const check = await client.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );

      if (check.rows.length === 0) {
        if (workspaceId !== userId) {
          throw new Error(
            `User ${userId} is not a member of workspace ${workspaceId}`,
          );
        }
        await client.query(
          "SELECT provision_personal_workspace_for_current_user()",
          [],
        );
      }
      const settingsCheck = await client.query(
        "SELECT 1 FROM workspace_settings WHERE workspace_id = $1",
        [workspaceId],
      );
      if (settingsCheck.rows.length === 0) {
        await client.query(
          "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD')",
          [workspaceId],
        );
      }
    }

    if (shouldCacheUser) {
      await ensureUserSettingsRow(client, userId, initialLocale);
    }

    await client.query("COMMIT");
    if (shouldCacheMembership) {
      provisionedMemberships.add(membershipKey);
    }
    if (shouldCacheUser) {
      provisionedUsers.add(userId);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    if (isExpectedProvisioningConflict(err)) {
      await verifyProvisionedState(userId, workspaceId);
      provisionedMemberships.add(membershipKey);
      provisionedUsers.add(userId);
      return;
    }
    throw err;
  } finally {
    client.release();
  }
};

/** Execute a query without RLS context (global tables only). */
export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  pool.query(text, params as Array<unknown>);

export const getPool = (): pg.Pool => pool;

/** Execute a single SQL statement inside a transaction with app.user_id and app.workspace_id set. */
export const queryAs = async (
  userId: string,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<pg.QueryResult> => {
  await ensureUserProvisioned(userId, workspaceId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query(text, params as Array<unknown>);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;

/**
 * Execute multiple statements in one transaction with app.user_id and
 * app.workspace_id set.
 */
export const withUserContext = async <T>(
  userId: string,
  workspaceId: string,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  await ensureUserProvisioned(userId, workspaceId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const boundQuery: QueryFn = (text, params) =>
      client.query(text, params as Array<unknown>);
    const result = await callback(boundQuery);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Execute multiple statements in one transaction with app.user_id and
 * app.workspace_id set, then switch to the restricted SQL role.
 */
export const withRestrictedUserContext = async <T>(
  userId: string,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  await ensureUserProvisioned(userId, workspaceId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    await client.query("SET LOCAL ROLE api_sql_executor");
    const boundQuery: QueryFn = (text, params) =>
      client.query(text, params as Array<unknown>);
    const result = await callback(boundQuery);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};
