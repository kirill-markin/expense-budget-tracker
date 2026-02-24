/**
 * Postgres connection pool and query helpers.
 *
 * query()           — bare pool.query, no RLS context. Used only for global
 *                     tables (exchange_rates) and health checks.
 * queryAs()         — single statement in a transaction with app.user_id and
 *                     app.workspace_id set.
 * withUserContext() — multiple statements in one transaction with app.user_id
 *                     and app.workspace_id. The callback receives a bound
 *                     queryFn sharing one client.
 */
import pg from "pg";

// AUTH_MODE=proxy means production behind ALB + Cognito → always RDS → always SSL.
const ssl = process.env.AUTH_MODE === "proxy" ? { rejectUnauthorized: false } : false;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});

/** Workspace IDs already verified to exist in this process. */
const provisionedWorkspaces = new Set<string>();

/**
 * Ensure a workspace, membership, and settings row exist for the given user.
 *
 * Uses an in-memory cache so only the very first request per workspace hits
 * the DB. Operates on its own connection with RLS context to go through the
 * self-provision policy (0002_workspace_self_provision.sql).
 */
const ensureWorkspace = async (userId: string, workspaceId: string): Promise<void> => {
  if (provisionedWorkspaces.has(workspaceId)) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

    const check = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );

    if (check.rows.length === 0) {
      // Plain INSERTs — no ON CONFLICT because PostgreSQL requires SELECT
      // visibility for conflict checks, which RLS blocks for new users.
      await client.query(
        "INSERT INTO workspaces (workspace_id, name) VALUES ($1, $1)",
        [workspaceId],
      );
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)",
        [workspaceId, userId],
      );
      await client.query(
        "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD')",
        [workspaceId],
      );
    }

    await client.query("COMMIT");
    provisionedWorkspaces.add(workspaceId);
  } catch (err) {
    await client.query("ROLLBACK");
    // Concurrent request already provisioned this workspace — treat as success.
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "23505") {
      provisionedWorkspaces.add(workspaceId);
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
  await ensureWorkspace(userId, workspaceId);
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

/** Execute multiple statements in one transaction with app.user_id and app.workspace_id set. */
export const withUserContext = async <T>(
  userId: string,
  workspaceId: string,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  await ensureWorkspace(userId, workspaceId);
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
