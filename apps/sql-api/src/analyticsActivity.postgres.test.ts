/**
 * Postgres-backed check of the activity-day analytics: the app records open
 * days through analytics.record_user_open_day, and every ledger insert made in
 * a person's context records that person's track day, including AI inserts that
 * run as api_sql_executor, while an insert of zero rows records none.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const appDatabaseUrl = process.env.APP_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || appDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and APP_DATABASE_URL are required for the Postgres-backed analytics activity test";
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const INSERT_LEDGER_ENTRY_SQL = `INSERT INTO public.ledger_entries (event_id, ts, account_id, amount, currency, kind, workspace_id)
  VALUES ($1, now(), 'Cash', -1, 'USD', 'spend', $2)`;
const INSERT_ZERO_LEDGER_ENTRIES_SQL = `INSERT INTO public.ledger_entries (event_id, ts, account_id, amount, currency, kind, workspace_id)
  SELECT $1::text, now(), 'Cash', -1, 'USD', 'spend', $2::text WHERE false`;
const TRACK_DAYS_SQL = "SELECT activity_date::text AS activity_date FROM analytics.user_track_days WHERE user_id = $1";

const onlyRow = <T extends pg.QueryResultRow>(result: pg.QueryResult<T>, label: string): T => {
  const [row, ...rest] = result.rows;
  if (row === undefined || rest.length > 0) {
    throw new Error(`${label}: expected exactly 1 row, got ${String(result.rows.length)}`);
  }
  return row;
};

const readDates = async (ownerPool: pg.Pool, sql: string, userId: string): Promise<ReadonlyArray<string>> => {
  const result = await ownerPool.query<{ activity_date: string }>(sql, [userId]);
  return result.rows.map((row) => row.activity_date);
};

test(
  "ledger inserts record one track day and the app records one open day per person per UTC day",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const suffix = randomUUID().replaceAll("-", "");
    const userId = `analytics-activity-user-${suffix}`;
    const workspaceId = `analytics-activity-ws-${suffix}`;
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const appPool = new pg.Pool({ connectionString: appDatabaseUrl, max: 1 });

    try {
      await ownerPool.query(
        "INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled) VALUES ($1, $2, true, 'CONFIRMED', true)",
        [userId, `${userId}@example.invalid`],
      );
      await ownerPool.query("INSERT INTO public.workspaces (workspace_id, name) VALUES ($1, 'Analytics')", [workspaceId]);
      await ownerPool.query("INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)", [workspaceId, userId]);

      const appClient = await appPool.connect();
      let today: string;
      let functionOid: number;
      try {
        // The zero-row insert commits alone: app cannot read analytics tables and the owner sees only committed rows.
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        await appClient.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        await appClient.query(INSERT_ZERO_LEDGER_ENTRIES_SQL, [`analytics-activity-event-zero-${suffix}`, workspaceId]);
        await appClient.query("COMMIT");
        assert.deepEqual(await readDates(ownerPool, TRACK_DAYS_SQL, userId), []);

        // One transaction keeps now(), and so the UTC day, the same for every statement.
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        await appClient.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        today = onlyRow(
          await appClient.query<{ today: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS today"),
          "UTC today",
        ).today;
        await appClient.query("SELECT analytics.record_user_open_day('web')");
        await appClient.query("SELECT analytics.record_user_open_day('web')");
        // The role switch below loses schema USAGE, so the function is resolved while still app.
        functionOid = onlyRow(
          await appClient.query<{ oid: number }>("SELECT 'analytics.record_user_open_day(text)'::regprocedure::oid AS oid"),
          "record_user_open_day oid",
        ).oid;
        await appClient.query("SET LOCAL ROLE api_sql_executor");
        const privilege = onlyRow(
          await appClient.query<{ allowed: boolean }>("SELECT has_function_privilege($1::oid, 'EXECUTE') AS allowed", [functionOid]),
          "api_sql_executor EXECUTE privilege",
        );
        assert.equal(privilege.allowed, false);
        // AI inserts run as api_sql_executor, which has no USAGE on the analytics schema.
        // Both inserts run here, so the expected track day can come only from this path.
        await appClient.query(INSERT_LEDGER_ENTRY_SQL, [`analytics-activity-event-1-${suffix}`, workspaceId]);
        await appClient.query(INSERT_LEDGER_ENTRY_SQL, [`analytics-activity-event-2-${suffix}`, workspaceId]);
        await appClient.query("COMMIT");

        await assert.rejects(
          appClient.query("SELECT analytics.record_user_open_day('web')"),
          /analytics\.record_user_open_day: app\.user_id must be set by the caller's user context/u,
        );
      } catch (error) {
        await appClient.query("ROLLBACK");
        throw error;
      } finally {
        appClient.release();
      }

      assert.deepEqual(await readDates(ownerPool, TRACK_DAYS_SQL, userId), [today]);
      assert.deepEqual(
        await readDates(
          ownerPool,
          "SELECT activity_date::text AS activity_date FROM analytics.user_open_days WHERE user_id = $1 AND surface = 'web'",
          userId,
        ),
        [today],
      );

      // Owner scripts insert with no acting person. The snapshot hides other sessions' rows, so any change is this insert's.
      const ownerClient = await ownerPool.connect();
      try {
        await ownerClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const countTrackRows = async (): Promise<string> =>
          onlyRow(
            await ownerClient.query<{ count: string }>("SELECT count(*)::text AS count FROM analytics.user_track_days"),
            "track day count",
          ).count;
        const before = await countTrackRows();
        await ownerClient.query(INSERT_LEDGER_ENTRY_SQL, [`analytics-activity-event-owner-${suffix}`, workspaceId]);
        assert.equal(await countTrackRows(), before);
        await ownerClient.query("COMMIT");
      } catch (error) {
        await ownerClient.query("ROLLBACK");
        throw error;
      } finally {
        ownerClient.release();
      }
    } finally {
      await ownerPool.query("DELETE FROM public.ledger_entries WHERE workspace_id = $1", [workspaceId]);
      await ownerPool.query("DELETE FROM public.workspace_members WHERE workspace_id = $1", [workspaceId]);
      await ownerPool.query("DELETE FROM public.workspaces WHERE workspace_id = $1", [workspaceId]);
      // Deleting the person cascades to their analytics rows.
      await ownerPool.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
      await appPool.end();
      await ownerPool.end();
    }
  },
);
