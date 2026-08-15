/**
 * Postgres connection pool and query helper.
 *
 * Pool is created lazily on first query. In Lambda, the connection string
 * is resolved from Secrets Manager (async), so eager creation is not possible.
 */

import type pg from "pg";
import {
  getRemainingSqlExecutionMs,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  type ReadOnlyTransactionStart,
  systemDeadlineRuntime,
  withDeadlineTransactionUsingPool,
  withReadOnlyDeadlineTransactionUsingPool,
} from "./dbDeadline.js";
import {
  databasePoolProvider,
  getPool,
  waitForPoolBeforeDeadline,
} from "./dbPool.js";

export type UserIdentity = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
  cognitoStatus: string;
  cognitoEnabled: boolean;
}>;

export const query = async (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  (await getPool()).query(text, params as Array<unknown>);

export type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;
export type RestrictedQueryFn = (
  text: string,
  params: ReadonlyArray<unknown>,
  statementTimeoutMs: number,
  onDispatch: () => void,
) => Promise<pg.QueryResult>;
type RestrictedDatabaseQueryFn = (
  text: string,
  params: ReadonlyArray<unknown>,
  statementTimeoutMs: number,
  onDispatch: () => void,
) => Promise<pg.QueryResult>;
type RestrictedRole = "api_sql_executor" | "api_sql_reader";

const createRestrictedQueryFn = (
  queryFn: QueryFn,
  restrictedQueryFn: RestrictedDatabaseQueryFn,
  role: RestrictedRole,
): RestrictedQueryFn => async (text, params, requestedStatementTimeoutMs, onDispatch) => {
  if (!Number.isSafeInteger(requestedStatementTimeoutMs) || requestedStatementTimeoutMs <= 0) {
    throw new TypeError("Restricted SQL statement timeout must be a positive safe integer number of milliseconds");
  }
  await queryFn("RESET ROLE", []);
  await queryFn(`SET LOCAL ROLE ${role}`, []);
  return restrictedQueryFn(text, params, requestedStatementTimeoutMs, onDispatch);
};

const withDeadlineTransaction = async <T>(
  deadline: SqlExecutionDeadline,
  beginSql: string,
  callback: (queryFn: QueryFn, restrictedQueryFn: RestrictedDatabaseQueryFn) => Promise<T>,
): Promise<T> => {
  getRemainingSqlExecutionMs(deadline);
  const deadlinePool = await waitForPoolBeforeDeadline(
    databasePoolProvider,
    deadline,
    systemDeadlineRuntime,
  );
  getRemainingSqlExecutionMs(deadline);
  return withDeadlineTransactionUsingPool(
    deadlinePool,
    deadline,
    beginSql,
    async (transaction): Promise<T> => callback(
      (text, params) => transaction.query(text, params, deadline.timeoutMs),
      (text, params, statementTimeoutMs, onDispatch) => transaction.queryWithDispatchMarker(
        text,
        params,
        statementTimeoutMs,
        onDispatch,
      ),
    ),
    systemDeadlineRuntime,
  );
};

const withReadOnlyDeadlineTransaction = async <T>(
  deadline: SqlExecutionDeadline,
  beginSql: ReadOnlyTransactionStart,
  callback: (queryFn: QueryFn, restrictedQueryFn: RestrictedDatabaseQueryFn) => Promise<T>,
): Promise<T> => {
  getRemainingSqlExecutionMs(deadline);
  const deadlinePool = await waitForPoolBeforeDeadline(
    databasePoolProvider,
    deadline,
    systemDeadlineRuntime,
  );
  getRemainingSqlExecutionMs(deadline);
  return withReadOnlyDeadlineTransactionUsingPool(
    deadlinePool,
    deadline,
    beginSql,
    async (transaction): Promise<T> => callback(
      (text, params) => transaction.query(text, params, deadline.timeoutMs),
      (text, params, statementTimeoutMs, onDispatch) => transaction.queryWithDispatchMarker(
        text,
        params,
        statementTimeoutMs,
        onDispatch,
      ),
    ),
    systemDeadlineRuntime,
  );
};
type ResolvedWorkspaceRow = Readonly<{
  workspace_id: string;
  name: string;
  created: boolean;
}>;
type ResolvedWorkspace = Readonly<{
  workspaceId: string;
  created: boolean;
}>;
const DEFAULT_USER_LOCALE = "en";
const DEFAULT_FIRST_WORKSPACE_NAME = "My Workspace";
const DEFAULT_WORKSPACE_TIMEZONE = "UTC";

/**
 * Execute user-provided SQL in a transaction with RLS context and a restricted role.
 *
 * Sets app.user_id, app.workspace_id, and statement_timeout as the app role,
 * then switches to api_sql_executor (which cannot call set_config) before
 * running the callback. SET LOCAL ROLE scopes the switch to this transaction.
 */
export const withTransaction = async <T>(
  userId: string,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await (await getPool()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    // Switch to restricted role that cannot call set_config.
    // SET LOCAL scopes the role change to this transaction (auto-resets on COMMIT/ROLLBACK).
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

const upsertUserIdentity = async (
  queryFn: QueryFn,
  identity: UserIdentity,
): Promise<void> => {
  await queryFn(
    `INSERT INTO users (
       user_id,
       email,
       email_verified,
       cognito_status,
       cognito_enabled
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET email = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           cognito_status = EXCLUDED.cognito_status,
           cognito_enabled = EXCLUDED.cognito_enabled,
           last_seen_at = now(),
           updated_at = now()`,
    [
      identity.userId,
      identity.email,
      identity.emailVerified,
      identity.cognitoStatus,
      identity.cognitoEnabled,
    ],
  );
};

export const resolveOrCreateWorkspaceForTrustedIdentity = async (
  identity: UserIdentity,
): Promise<ResolvedWorkspace> => {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await upsertUserIdentity((text, params) => client.query(text, params as Array<unknown>), identity);

    const workspaceResult = await client.query(
      "SELECT workspace_id, name, created FROM ensure_current_user_has_workspace($1, $2)",
      [DEFAULT_FIRST_WORKSPACE_NAME, DEFAULT_WORKSPACE_TIMEZONE],
    );

    if (workspaceResult.rows.length !== 1) {
      throw new Error(`ensure_current_user_has_workspace returned ${workspaceResult.rows.length} rows`);
    }

    await client.query(
      "INSERT INTO user_settings (user_id, locale) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [identity.userId, DEFAULT_USER_LOCALE],
    );

    await client.query("COMMIT");
    const row = workspaceResult.rows[0] as ResolvedWorkspaceRow;
    return {
      workspaceId: row.workspace_id,
      created: row.created,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const ensureTrustedIdentityProvisioned = async (
  identity: UserIdentity,
  workspaceId: string,
): Promise<void> => {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await upsertUserIdentity((text, params) => client.query(text, params as Array<unknown>), identity);

    const membershipResult = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, identity.userId],
    );

    if (membershipResult.rows.length === 0) {
      throw new Error(`User ${identity.userId} is not a member of workspace ${workspaceId}`);
    }

    await client.query(
      "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD') ON CONFLICT (workspace_id) DO NOTHING",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO user_settings (user_id, locale) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [identity.userId, DEFAULT_USER_LOCALE],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline = async (
  identity: UserIdentity,
  deadline: SqlExecutionDeadline,
): Promise<ResolvedWorkspace> => withDeadlineTransaction(
  deadline,
  "BEGIN",
  async (queryFn): Promise<ResolvedWorkspace> => {
    await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await upsertUserIdentity(queryFn, identity);
    const workspaceResult = await queryFn(
      "SELECT workspace_id, name, created FROM ensure_current_user_has_workspace($1, $2)",
      [DEFAULT_FIRST_WORKSPACE_NAME, DEFAULT_WORKSPACE_TIMEZONE],
    );
    if (workspaceResult.rows.length !== 1) {
      throw new Error(`ensure_current_user_has_workspace returned ${workspaceResult.rows.length} rows`);
    }
    await queryFn(
      "INSERT INTO user_settings (user_id, locale) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [identity.userId, DEFAULT_USER_LOCALE],
    );
    const row = workspaceResult.rows[0] as ResolvedWorkspaceRow;
    return {
      workspaceId: row.workspace_id,
      created: row.created,
    };
  },
);

export const ensureTrustedIdentityProvisionedBeforeDeadline = async (
  identity: UserIdentity,
  workspaceId: string,
  deadline: SqlExecutionDeadline,
): Promise<void> => withDeadlineTransaction(
  deadline,
  "BEGIN",
  async (queryFn): Promise<void> => {
    await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await queryFn("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await upsertUserIdentity(queryFn, identity);
    const membershipResult = await queryFn(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, identity.userId],
    );
    if (membershipResult.rows.length === 0) {
      throw new Error(`User ${identity.userId} is not a member of workspace ${workspaceId}`);
    }
    await queryFn(
      "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD') ON CONFLICT (workspace_id) DO NOTHING",
      [workspaceId],
    );
    await queryFn(
      "INSERT INTO user_settings (user_id, locale) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [identity.userId, DEFAULT_USER_LOCALE],
    );
  },
);

export const queryAsTrustedIdentityBeforeDeadline = async (
  identity: UserIdentity,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
  deadline: SqlExecutionDeadline,
): Promise<pg.QueryResult> => {
  await ensureTrustedIdentityProvisionedBeforeDeadline(identity, workspaceId, deadline);
  return withDeadlineTransaction(
    deadline,
    "BEGIN",
    async (queryFn): Promise<pg.QueryResult> => {
      await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
      await queryFn("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      return queryFn(text, params);
    },
  );
};

export const queryAsExistingTrustedIdentityBeforeDeadline = async (
  identity: UserIdentity,
  text: string,
  params: ReadonlyArray<unknown>,
  deadline: SqlExecutionDeadline,
): Promise<pg.QueryResult> => withReadOnlyDeadlineTransaction(
  deadline,
  "BEGIN READ ONLY",
  async (queryFn): Promise<pg.QueryResult> => {
    await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    return queryFn(text, params);
  },
);

export const queryBeforeDeadline = async (
  text: string,
  params: ReadonlyArray<unknown>,
  deadline: SqlExecutionDeadline,
): Promise<pg.QueryResult> => withReadOnlyDeadlineTransaction(
  deadline,
  "BEGIN READ ONLY",
  (queryFn): Promise<pg.QueryResult> => queryFn(text, params),
);

export const queryAsExistingTrustedWorkspaceBeforeDeadline = async (
  identity: UserIdentity,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
  deadline: SqlExecutionDeadline,
): Promise<pg.QueryResult> => withReadOnlyDeadlineTransaction(
  deadline,
  "BEGIN READ ONLY",
  async (queryFn): Promise<pg.QueryResult> => {
    await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await queryFn("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    return queryFn(text, params);
  },
);

export const queryAsTrustedIdentity = async (
  identity: UserIdentity,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<pg.QueryResult> => {
  await ensureTrustedIdentityProvisioned(identity, workspaceId);
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query(text, params as Array<unknown>);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Query existing user-scoped data without provisioning or updating state.
 */
export const queryAsExistingTrustedIdentity = async (
  identity: UserIdentity,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<pg.QueryResult> => {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    const result = await client.query(text, params as Array<unknown>);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Query existing workspace-scoped data without provisioning or updating state.
 */
export const queryAsExistingTrustedWorkspace = async (
  identity: UserIdentity,
  workspaceId: string,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<pg.QueryResult> => {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query(text, params as Array<unknown>);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const readTrustedUserIdentity = (row: unknown): UserIdentity => {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("loadTrustedUserIdentity: database returned an invalid user row");
  }

  const record = row as Readonly<Record<string, unknown>>;
  const userId = record["user_id"];
  const email = record["email"];
  const emailVerified = record["email_verified"];
  const cognitoStatus = record["cognito_status"];
  const cognitoEnabled = record["cognito_enabled"];
  if (
    typeof userId !== "string"
    || userId === ""
    || typeof email !== "string"
    || email === ""
    || typeof emailVerified !== "boolean"
    || typeof cognitoStatus !== "string"
    || cognitoStatus === ""
    || typeof cognitoEnabled !== "boolean"
  ) {
    throw new Error("loadTrustedUserIdentity: database returned invalid user identity fields");
  }

  return {
    userId,
    email,
    emailVerified,
    cognitoStatus,
    cognitoEnabled,
  };
};

/**
 * Load an existing user under that user's RLS context without provisioning or
 * updating identity state.
 */
export const loadTrustedUserIdentity = async (
  userId: string,
): Promise<UserIdentity | null> => {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await client.query(
      `SELECT user_id, email, email_verified, cognito_status, cognito_enabled
       FROM users
       WHERE user_id = $1`,
      [userId],
    );
    if (result.rows.length > 1) {
      throw new Error(`loadTrustedUserIdentity: expected at most 1 row, got ${result.rows.length}`);
    }
    const row = result.rows[0];
    const identity = row === undefined ? null : readTrustedUserIdentity(row);
    await client.query("COMMIT");
    return identity;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const loadTrustedUserIdentityBeforeDeadline = async (
  userId: string,
  deadline: SqlExecutionDeadline,
): Promise<UserIdentity | null> => withReadOnlyDeadlineTransaction(
  deadline,
  "BEGIN READ ONLY",
  async (queryFn): Promise<UserIdentity | null> => {
    await queryFn("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await queryFn(
      `SELECT user_id, email, email_verified, cognito_status, cognito_enabled
       FROM users
       WHERE user_id = $1`,
      [userId],
    );
    if (result.rows.length > 1) {
      throw new Error(`loadTrustedUserIdentity: expected at most 1 row, got ${result.rows.length}`);
    }
    const row = result.rows[0];
    return row === undefined ? null : readTrustedUserIdentity(row);
  },
);

export const withRestrictedTrustedIdentityContext = async <T>(
  identity: UserIdentity,
  workspaceId: string,
  deadline: SqlExecutionDeadline,
  callback: (queryFn: RestrictedQueryFn) => Promise<T>,
): Promise<T> => {
  await ensureTrustedIdentityProvisionedBeforeDeadline(identity, workspaceId, deadline);
  return withDeadlineTransaction(
    deadline,
    "BEGIN",
    async (queryFn, restrictedQueryFn): Promise<T> => {
      await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
      await queryFn("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      return callback(createRestrictedQueryFn(queryFn, restrictedQueryFn, "api_sql_executor"));
    },
  );
};

/**
 * Execute read-only user SQL in one stable-snapshot transaction under the
 * least-privilege reader role.
 */
export const withReadOnlyRestrictedTrustedIdentityContext = async <T>(
  identity: UserIdentity,
  workspaceId: string,
  deadline: SqlExecutionDeadline,
  callback: (queryFn: RestrictedQueryFn) => Promise<T>,
): Promise<T> => {
  await ensureTrustedIdentityProvisionedBeforeDeadline(identity, workspaceId, deadline);
  return withReadOnlyDeadlineTransaction(
    deadline,
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    async (queryFn, restrictedQueryFn): Promise<T> => {
      await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
      await queryFn("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      return callback(createRestrictedQueryFn(queryFn, restrictedQueryFn, "api_sql_reader"));
    },
  );
};

/**
 * Execute read-only user SQL for an existing workspace without provisioning or
 * updating identity, membership, workspace, or settings state.
 */
export const withNonProvisioningReadOnlyRestrictedTrustedIdentityContext = async <T>(
  identity: UserIdentity,
  workspaceId: string,
  deadline: SqlExecutionDeadline,
  callback: (queryFn: RestrictedQueryFn) => Promise<T>,
): Promise<T> => {
  return withReadOnlyDeadlineTransaction(
    deadline,
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    async (queryFn, restrictedQueryFn): Promise<T> => {
      await queryFn("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
      await queryFn("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      return callback(createRestrictedQueryFn(queryFn, restrictedQueryFn, "api_sql_reader"));
    },
  );
};
