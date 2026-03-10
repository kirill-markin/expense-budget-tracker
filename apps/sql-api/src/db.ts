/**
 * Postgres connection pool and query helper.
 *
 * Pool is created lazily on first query. In Lambda, the connection string
 * is resolved from Secrets Manager (async), so eager creation is not possible.
 */

import pg from "pg";
import { getDatabaseUrl } from "./config";

export type UserIdentity = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
  cognitoStatus: string;
  cognitoEnabled: boolean;
}>;

let pool: pg.Pool | undefined;

async function getPool(): Promise<pg.Pool> {
  if (!pool) {
    const connectionString = await getDatabaseUrl();
    // ssl:true enables full certificate verification. RDS certs are signed by
    // Amazon's CA (not in Node.js defaults), so NODE_EXTRA_CA_CERTS must point
    // to the RDS CA bundle (set in CDK, bundle downloaded during Lambda bundling).
    const ssl = process.env.DB_SECRET_ARN ? true : false;
    pool = new pg.Pool({ connectionString, ssl });
  }
  return pool;
}

export const query = async (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  (await getPool()).query(text, params as Array<unknown>);

type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;

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

const DEFAULT_USER_LOCALE = "en";

const upsertUserIdentity = async (
  client: pg.PoolClient,
  identity: UserIdentity,
): Promise<void> => {
  await client.query(
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

export const ensureTrustedIdentityProvisioned = async (
  identity: UserIdentity,
  workspaceId: string,
): Promise<void> => {
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await upsertUserIdentity(client, identity);

    const membershipResult = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, identity.userId],
    );

    if (membershipResult.rows.length === 0) {
      if (workspaceId !== identity.userId) {
        throw new Error(`User ${identity.userId} is not a member of workspace ${workspaceId}`);
      }
      await client.query("SELECT provision_personal_workspace_for_current_user()", []);
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

export const withRestrictedTrustedIdentityContext = async <T>(
  identity: UserIdentity,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  await ensureTrustedIdentityProvisioned(identity, workspaceId);
  const client = await (await getPool()).connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    await client.query("SET LOCAL ROLE api_sql_executor");
    const boundQuery: QueryFn = (text, params) => client.query(text, params as Array<unknown>);
    const result = await callback(boundQuery);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
