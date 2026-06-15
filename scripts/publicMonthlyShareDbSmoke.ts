import { randomUUID } from "node:crypto";
import pg from "pg";

type PgError = Error & Readonly<{
  code?: string;
}>;

type SmokeIds = Readonly<{
  userId: string;
  workspaceId: string;
  shareId: string;
  publicToken: string;
  rotatedToken: string;
}>;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const createPool = (connectionString: string): pg.Pool =>
  new pg.Pool({ connectionString });

const createToken = (): string =>
  randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");

const setupSmokeData = async (pool: pg.Pool): Promise<SmokeIds> => {
  const suffix = randomUUID();
  const ids: SmokeIds = {
    userId: `public-share-smoke-user-${suffix}`,
    workspaceId: `public-share-smoke-workspace-${suffix}`,
    shareId: `public-share-smoke-share-${suffix}`,
    publicToken: createToken(),
    rotatedToken: createToken(),
  };

  await pool.query("BEGIN");
  try {
    await pool.query(
      `
        INSERT INTO public.users (
          user_id,
          email,
          email_verified,
          cognito_status,
          cognito_enabled
        )
        VALUES ($1, $2, true, 'CONFIRMED', true)
      `,
      [ids.userId, `${ids.userId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO public.workspaces (workspace_id, name) VALUES ($1, $2)",
      [ids.workspaceId, "Public share DB smoke"],
    );
    await pool.query(
      "INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)",
      [ids.workspaceId, ids.userId],
    );
    await pool.query(
      "INSERT INTO public.workspace_settings (workspace_id, reporting_currency, timezone) VALUES ($1, 'USD', 'UTC')",
      [ids.workspaceId],
    );
    await pool.query(
      `
        INSERT INTO public.ledger_entries (
          event_id,
          ts,
          account_id,
          amount,
          currency,
          kind,
          category,
          counterparty,
          note,
          workspace_id
        )
        VALUES
          ($1, '2025-01-15T12:00:00.000Z', 'smoke-account', -12.34, 'USD', 'spend', 'Smoke monthly', 'private counterparty', 'private note', $2),
          ($3, '2025-01-15T12:00:00.000Z', 'smoke-account', -56.78, 'USD', 'spend', 'Smoke category only', 'private counterparty', 'private note', $2),
          ($4, '2025-01-15T12:00:00.000Z', 'smoke-account', 90.12, 'USD', 'income', 'Smoke monthly', 'private counterparty', 'private note', $2),
          ($5, '2025-01-15T12:00:00.000Z', 'smoke-account', -34.56, 'ZZZ', 'spend', 'Smoke monthly', 'private counterparty', 'private note', $2)
      `,
      [
        `event-spend-${suffix}`,
        ids.workspaceId,
        `event-category-only-${suffix}`,
        `event-income-${suffix}`,
        `event-unconvertible-${suffix}`,
      ],
    );
    await pool.query(
      `
        INSERT INTO community.monthly_category_shares (
          share_id,
          workspace_id,
          created_by_user_id,
          enabled,
          display_label,
          month_from,
          month_to
        )
        VALUES ($1, $2, $3, true, 'Smoke share', '2025-01-01', '2025-12-01')
      `,
      [ids.shareId, ids.workspaceId, ids.userId],
    );
    await pool.query(
      `
        INSERT INTO community.monthly_category_share_items (
          share_id,
          direction,
          category,
          access_level
        )
        VALUES
          ($1, 'spend', 'Smoke monthly', 'monthly_values'),
          ($1, 'spend', 'Smoke category only', 'category_only')
      `,
      [ids.shareId],
    );
    await pool.query(
      "INSERT INTO community.monthly_category_share_keys (share_id, public_token) VALUES ($1, $2)",
      [ids.shareId, ids.publicToken],
    );
    await pool.query("COMMIT");
    return ids;
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
};

const cleanupSmokeData = async (pool: pg.Pool, ids: SmokeIds): Promise<void> => {
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM community.monthly_category_shares WHERE share_id = $1", [ids.shareId]);
    await pool.query("DELETE FROM public.ledger_entries WHERE workspace_id = $1", [ids.workspaceId]);
    await pool.query("DELETE FROM public.workspace_settings WHERE workspace_id = $1", [ids.workspaceId]);
    await pool.query("DELETE FROM public.workspace_members WHERE workspace_id = $1", [ids.workspaceId]);
    await pool.query("DELETE FROM public.workspaces WHERE workspace_id = $1", [ids.workspaceId]);
    await pool.query("DELETE FROM public.users WHERE user_id = $1", [ids.userId]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
};

const assertAppRole = async (pool: pg.Pool): Promise<void> => {
  const result = await pool.query("SELECT current_user AS current_user", []);
  const currentUser = result.rows[0]?.current_user;
  if (currentUser !== "app") {
    throw new Error(`APP_DATABASE_URL must connect as role app; current_user=${String(currentUser)}`);
  }
};

const readPublicShareRows = async (
  pool: pg.Pool,
  publicToken: string,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> => {
  const result = await pool.query(
    `
      SELECT categories, cells, year_totals
      FROM community.read_public_monthly_category_share($1, '2025-01-01'::date, '2025-12-01'::date)
    `,
    [publicToken],
  );
  return result.rows as ReadonlyArray<Readonly<Record<string, unknown>>>;
};

const assertEnabledPublicReader = async (pool: pg.Pool, publicToken: string): Promise<void> => {
  const rows = await readPublicShareRows(pool, publicToken);
  if (rows.length !== 1) {
    throw new Error(`Expected enabled public reader to return one row; rowCount=${rows.length}`);
  }

  const serialized = JSON.stringify(rows[0]);
  if (!serialized.includes("Smoke monthly") || !serialized.includes("12.34")) {
    throw new Error(`Expected public monthly aggregate is missing from reader result: ${serialized}`);
  }
  if (
    serialized.includes("56.78")
    || serialized.includes("90.12")
    || serialized.includes("34.56")
    || serialized.includes("private counterparty")
    || serialized.includes("private note")
  ) {
    throw new Error(`Private, income, category-only, or unconvertible data leaked: ${serialized}`);
  }
};

const assertMissingPublicReader = async (
  pool: pg.Pool,
  publicToken: string,
  label: string,
): Promise<void> => {
  const rows = await readPublicShareRows(pool, publicToken);
  if (rows.length !== 0) {
    throw new Error(`Expected ${label} token to return no rows; rowCount=${rows.length}`);
  }
};

const assertApiSqlExecutorDenied = async (
  pool: pg.Pool,
  sql: string,
  params: ReadonlyArray<unknown>,
  label: string,
): Promise<void> => {
  await pool.query("BEGIN");
  try {
    await pool.query("SET LOCAL ROLE api_sql_executor", []);
    await pool.query(sql, params as Array<unknown>);
    throw new Error(`api_sql_executor unexpectedly accessed ${label}`);
  } catch (error) {
    const pgError = error as PgError;
    if (pgError.code !== "42501") {
      throw error;
    }
  } finally {
    await pool.query("ROLLBACK");
  }
};

const main = async (): Promise<void> => {
  const migrationDatabaseUrl = requireEnv("MIGRATION_DATABASE_URL");
  const appDatabaseUrl = requireEnv("APP_DATABASE_URL");
  const adminPool = createPool(migrationDatabaseUrl);
  const appPool = createPool(appDatabaseUrl);
  let ids: SmokeIds | null = null;

  try {
    ids = await setupSmokeData(adminPool);
    await assertAppRole(appPool);
    await assertEnabledPublicReader(appPool, ids.publicToken);

    await adminPool.query("UPDATE community.monthly_category_shares SET enabled = false WHERE share_id = $1", [ids.shareId]);
    await assertMissingPublicReader(appPool, ids.publicToken, "disabled");
    await adminPool.query("UPDATE community.monthly_category_shares SET enabled = true WHERE share_id = $1", [ids.shareId]);

    await adminPool.query(
      "UPDATE community.monthly_category_share_keys SET revoked_at = now() WHERE share_id = $1 AND revoked_at IS NULL",
      [ids.shareId],
    );
    await assertMissingPublicReader(appPool, ids.publicToken, "revoked");
    await adminPool.query(
      "INSERT INTO community.monthly_category_share_keys (share_id, public_token) VALUES ($1, $2)",
      [ids.shareId, ids.rotatedToken],
    );

    await adminPool.query("UPDATE community.monthly_category_shares SET blocked_at = now() WHERE share_id = $1", [ids.shareId]);
    await assertMissingPublicReader(appPool, ids.rotatedToken, "blocked");
    await assertMissingPublicReader(appPool, createToken(), "unknown");

    await assertApiSqlExecutorDenied(
      appPool,
      "SELECT 1 FROM community.monthly_category_shares LIMIT 1",
      [],
      "community.monthly_category_shares",
    );
    await assertApiSqlExecutorDenied(
      appPool,
      `
        SELECT 1
        FROM community.read_public_monthly_category_share($1, '2025-01-01'::date, '2025-12-01'::date)
      `,
      [ids.rotatedToken],
      "community.read_public_monthly_category_share",
    );

    console.log(JSON.stringify({ ok: true, workspaceId: ids.workspaceId }));
  } finally {
    if (ids !== null) {
      await cleanupSmokeData(adminPool, ids);
    }
    await adminPool.end();
    await appPool.end();
  }
};

void main().catch((error: unknown): void => {
  console.error(error);
  process.exitCode = 1;
});
