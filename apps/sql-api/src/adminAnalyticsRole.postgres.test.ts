/**
 * Postgres-backed check of the admin_analytics role's reach, run as that role
 * so its grants, read policy and read-only sessions are the ones exercised.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const adminAnalyticsDatabaseUrl = process.env.ADMIN_ANALYTICS_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || adminAnalyticsDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and ADMIN_ANALYTICS_DATABASE_URL are required for the Postgres-backed admin-analytics role test";
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const INSUFFICIENT_PRIVILEGE = "42501";
const READ_ONLY_SQL_TRANSACTION = "25006";

const failsWithCode = (code: string): ((error: unknown) => boolean) =>
  (error: unknown): boolean => error instanceof pg.DatabaseError && error.code === code;

test(
  "admin_analytics reads analytics tables and user identity columns, and nothing else",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const suffix = randomUUID().replaceAll("-", "");
    const userId = `admin-analytics-user-${suffix}`;
    const email = `admin-analytics-${suffix}@example.invalid`;
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const adminAnalyticsPool = new pg.Pool({ connectionString: adminAnalyticsDatabaseUrl, max: 1 });

    try {
      await ownerPool.query(
        "INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled) VALUES ($1, $2, true, 'CONFIRMED', true)",
        [userId, email],
      );
      await ownerPool.query(
        "INSERT INTO analytics.user_open_days (user_id, activity_date, surface) VALUES ($1, '2026-11-01', 'web')",
        [userId],
      );
      await ownerPool.query(
        "INSERT INTO analytics.user_track_days (user_id, activity_date) VALUES ($1, '2026-11-01')",
        [userId],
      );

      const users = await adminAnalyticsPool.query<{ email: string }>(
        "SELECT email FROM public.users WHERE user_id = $1",
        [userId],
      );
      assert.deepEqual(users.rows, [{ email }]);
      for (const table of ["analytics.user_open_days", "analytics.user_track_days"]) {
        const counted = await adminAnalyticsPool.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE user_id = $1`,
          [userId],
        );
        assert.deepEqual(counted.rows, [{ count: "1" }], table);
      }

      await assert.rejects(
        adminAnalyticsPool.query("SELECT count(*) FROM public.ledger_entries"),
        failsWithCode(INSUFFICIENT_PRIVILEGE),
      );
      await assert.rejects(
        adminAnalyticsPool.query("SELECT cognito_status FROM public.users WHERE user_id = $1", [userId]),
        failsWithCode(INSUFFICIENT_PRIVILEGE),
      );
      await assert.rejects(
        adminAnalyticsPool.query(
          "INSERT INTO analytics.user_track_days (user_id, activity_date) VALUES ($1, '2026-11-02')",
          [userId],
        ),
        failsWithCode(READ_ONLY_SQL_TRANSACTION),
      );

      // A read-write transaction lifts the session default, so the grants alone must refuse writes.
      const client = await adminAnalyticsPool.connect();
      try {
        for (const insert of [
          "INSERT INTO analytics.user_track_days (user_id, activity_date) VALUES ($1, '2026-11-02')",
          "INSERT INTO analytics.user_open_days (user_id, activity_date, surface) VALUES ($1, '2026-11-02', 'web')",
          "INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled) VALUES ($1 || '-copy', 'copy@example.invalid', true, 'CONFIRMED', true)",
        ]) {
          await client.query("BEGIN READ WRITE");
          await assert.rejects(client.query(insert, [userId]), failsWithCode(INSUFFICIENT_PRIVILEGE), insert);
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    } finally {
      await ownerPool.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
      await adminAnalyticsPool.end();
      await ownerPool.end();
    }
  },
);
