/**
 * Postgres-backed check of the Level 1 new vs returning reports, run as the
 * admin_analytics role itself so its grants and read-only transactions are the
 * ones exercised. Seeded activity sits in 2003, so other rows in a shared test
 * database cannot reach these buckets.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { loadWhoOpenedBuckets, loadWhoTrackedBuckets, type NewReturningBucket } from "./newReturning";
import { defaultDateRange, parseDateRange } from "./period";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const adminAnalyticsDatabaseUrl = process.env.ADMIN_ANALYTICS_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || adminAnalyticsDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and ADMIN_ANALYTICS_DATABASE_URL are required for the Postgres-backed new vs returning test";
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const SEED_YEAR_FROM = "2003-01-01";
const SEED_YEAR_TO = "2003-12-31";
const TODAY = new Date().toISOString().slice(0, 10);

type ExpectedBucket = Readonly<[bucketStart: string, selectedFrom: string, selectedTo: string, newCount: number, returningCount: number]>;

const summarize = (buckets: ReadonlyArray<NewReturningBucket>): ReadonlyArray<ExpectedBucket> =>
  buckets.map((bucket: NewReturningBucket): ExpectedBucket => {
    assert.equal(bucket.inProgress, false, `a 2003 bucket cannot be in progress: ${JSON.stringify(bucket)}`);
    return [bucket.bucketStart, bucket.selectedFrom, bucket.selectedTo, bucket.newCount, bucket.returningCount];
  });

const range = (from: string, to: string) => parseDateRange(from, to, TODAY);

test(
  "admin_analytics counts new and returning people per UTC bucket",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const suffix = randomUUID().replaceAll("-", "");
    const alice = `new-returning-alice-${suffix}`;
    const bob = `new-returning-bob-${suffix}`;
    const admin = `new-returning-admin-${suffix}`;
    const excluded = `new-returning-excluded-${suffix}`;
    const adminEmail = `new-returning-admin-${suffix}@example.invalid`;
    const excludedEmail = `new-returning-excluded-${suffix}@example.invalid`;
    const seededUsers = [
      [alice, `new-returning-alice-${suffix}@example.invalid`],
      [bob, `new-returning-bob-${suffix}@example.invalid`],
      // Stored in mixed case to prove the exclusion ignores case.
      [admin, adminEmail.toUpperCase()],
      [excluded, excludedEmail],
    ] as const;

    // The report code reads its configuration and database URL from the environment on first use.
    process.env.ADMIN_AUTH_MODE = "none";
    process.env.ADMIN_ORIGIN = "http://127.0.0.1:3001";
    process.env.ADMIN_EMAILS = adminEmail;
    process.env.ANALYTICS_EXCLUDED_EMAILS = excludedEmail;
    process.env.DATABASE_URL = adminAnalyticsDatabaseUrl;

    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    try {
      for (const [userId, email] of seededUsers) {
        await ownerPool.query(
          "INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled) VALUES ($1, $2, true, 'CONFIRMED', true)",
          [userId, email],
        );
      }
      const openDays: ReadonlyArray<readonly [string, string, string]> = [
        // Alice first opens on Tuesday 2003-03-04 and returns on Thursday of the same week.
        [alice, "2003-03-04", "web"],
        [alice, "2003-03-06", "web"],
        // Bob first opens over MCP in February, then on the web in March.
        [bob, "2003-02-10", "mcp"],
        [bob, "2003-03-05", "web"],
        // Excluded people are active on every day that counts.
        ...[admin, excluded, "local"].flatMap((userId: string): ReadonlyArray<readonly [string, string, string]> => [
          [userId, "2003-02-10", "mcp"],
          [userId, "2003-03-04", "web"],
          [userId, "2003-03-05", "api"],
        ]),
      ];
      for (const [userId, day, surface] of openDays) {
        await ownerPool.query(
          "INSERT INTO analytics.user_open_days (user_id, activity_date, surface) VALUES ($1, $2, $3)",
          [userId, day, surface],
        );
      }
      const trackDays: ReadonlyArray<readonly [string, string]> = [
        [alice, "2003-03-04"],
        [alice, "2003-03-06"],
        [bob, "2003-03-05"],
        [admin, "2003-03-04"],
        [excluded, "2003-03-04"],
        ["local", "2003-03-04"],
      ];
      for (const [userId, day] of trackDays) {
        await ownerPool.query("INSERT INTO analytics.user_track_days (user_id, activity_date) VALUES ($1, $2)", [userId, day]);
      }

      const allSurfaces = ["web", "api", "mcp"] as const;

      // Alice counts on each of her two days, and once in their week.
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-03-04", "2003-03-06"), "day", allSurfaces)), [
        ["2003-03-04", "2003-03-04", "2003-03-04", 1, 0],
        ["2003-03-05", "2003-03-05", "2003-03-05", 0, 1],
        ["2003-03-06", "2003-03-06", "2003-03-06", 0, 1],
      ]);
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-03-04", "2003-03-06"), "week", allSurfaces)), [
        ["2003-03-03", "2003-03-04", "2003-03-06", 1, 1],
      ]);

      // Weeks start on Monday, empty weeks return zeros, and Bob is new only in his first week.
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-02-12", "2003-03-09"), "week", allSurfaces)), [
        ["2003-02-10", "2003-02-12", "2003-02-16", 0, 0],
        ["2003-02-17", "2003-02-17", "2003-02-23", 0, 0],
        ["2003-02-24", "2003-02-24", "2003-03-02", 0, 0],
        ["2003-03-03", "2003-03-03", "2003-03-09", 1, 1],
      ]);

      // Edge buckets clip to the range: Bob's day before February 15 is outside it.
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-02-15", "2003-03-05"), "month", allSurfaces)), [
        ["2003-02-01", "2003-02-15", "2003-02-28", 0, 0],
        ["2003-03-01", "2003-03-01", "2003-03-05", 1, 1],
      ]);

      // The surface filter narrows who is in a bucket but keeps Bob's MCP first day.
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-02-10", "2003-03-09"), "month", ["web"])), [
        ["2003-02-01", "2003-02-10", "2003-02-28", 0, 0],
        ["2003-03-01", "2003-03-01", "2003-03-09", 1, 1],
      ]);
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-02-10", "2003-03-09"), "month", ["mcp"])), [
        ["2003-02-01", "2003-02-10", "2003-02-28", 1, 0],
        ["2003-03-01", "2003-03-01", "2003-03-09", 0, 0],
      ]);
      assert.deepEqual(summarize(await loadWhoOpenedBuckets(range("2003-02-10", "2003-03-09"), "month", ["api"])), [
        ["2003-02-01", "2003-02-10", "2003-02-28", 0, 0],
        ["2003-03-01", "2003-03-01", "2003-03-09", 0, 0],
      ]);

      // Tracking has its own first day: Bob opened in February but first tracked in March.
      assert.deepEqual(summarize(await loadWhoTrackedBuckets(range("2003-03-03", "2003-03-09"), "week")), [
        ["2003-03-03", "2003-03-03", "2003-03-09", 2, 0],
      ]);
      assert.deepEqual(summarize(await loadWhoTrackedBuckets(range("2003-03-05", "2003-03-06"), "day")), [
        ["2003-03-05", "2003-03-05", "2003-03-05", 1, 0],
        ["2003-03-06", "2003-03-06", "2003-03-06", 0, 1],
      ]);

      // Only the bucket that contains today is in progress.
      const recentDays = await loadWhoTrackedBuckets(defaultDateRange(TODAY), "day");
      assert.equal(recentDays.length, 60);
      assert.deepEqual(
        recentDays.flatMap((bucket: NewReturningBucket): ReadonlyArray<string> => bucket.inProgress ? [bucket.bucketStart] : []),
        [TODAY],
      );
      const recentMonths = await loadWhoOpenedBuckets(defaultDateRange(TODAY), "month", allSurfaces);
      assert.equal(recentMonths.at(-1)?.inProgress, true);
      assert.equal(recentMonths.at(-1)?.selectedTo, TODAY);
      assert.ok(recentMonths.slice(0, -1).every((bucket: NewReturningBucket): boolean => !bucket.inProgress));
    } finally {
      await ownerPool.query(
        "DELETE FROM analytics.user_open_days WHERE user_id = 'local' AND activity_date BETWEEN $1 AND $2",
        [SEED_YEAR_FROM, SEED_YEAR_TO],
      );
      await ownerPool.query(
        "DELETE FROM analytics.user_track_days WHERE user_id = 'local' AND activity_date BETWEEN $1 AND $2",
        [SEED_YEAR_FROM, SEED_YEAR_TO],
      );
      // Activity rows of the seeded users go with them through ON DELETE CASCADE.
      await ownerPool.query("DELETE FROM public.users WHERE user_id = ANY($1::text[])", [
        seededUsers.map(([userId]): string => userId),
      ]);
      await ownerPool.end();
    }
  },
);
