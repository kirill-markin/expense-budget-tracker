import { COUNTED_USERS_CTE, getExcludedEmails } from "@/server/countedUsers";
import { queryReport, type QueryParam, type RawRow } from "@/server/db";
import { buildReportBucketsCteSql, type DateRange, type ReportPeriod } from "@/server/reports/period";
import type { ActivitySurface } from "@/server/reports/usersList";

/**
 * Counted people active in one bucket. Days are UTC ISO dates; a person is new
 * when their first-ever day in the same activity table, across all surfaces,
 * falls on or after `selectedFrom`, and returning when it is earlier.
 */
export type NewReturningBucket = Readonly<{
  bucketStart: string;
  selectedFrom: string;
  selectedTo: string;
  newCount: number;
  returningCount: number;
  /** The bucket contains today UTC, so it is not complete yet. */
  inProgress: boolean;
}>;

type ActivitySource = Readonly<{
  table: "analytics.user_open_days" | "analytics.user_track_days";
  /** Narrows which activity rows put a person in a bucket; first days ignore it. */
  bucketActivityPredicate: string;
}>;

const OPEN_DAYS_SOURCE: ActivitySource = {
  table: "analytics.user_open_days",
  bucketActivityPredicate: "activity.surface = ANY($4::text[])",
};

const TRACK_DAYS_SOURCE: ActivitySource = {
  table: "analytics.user_track_days",
  bucketActivityPredicate: "TRUE",
};

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// Days are formatted in SQL because pg turns DATE values into local-time Date objects.
const buildNewReturningSql = (period: ReportPeriod, source: ActivitySource): string => `WITH ${COUNTED_USERS_CTE},
${buildReportBucketsCteSql(period)},
bucket_people AS (
  SELECT DISTINCT bucket.bucket_start, activity.user_id
  FROM report_buckets AS bucket
  JOIN ${source.table} AS activity
    ON activity.activity_date BETWEEN bucket.selected_from AND bucket.selected_to
  JOIN counted_users USING (user_id)
  WHERE ${source.bucketActivityPredicate}
),
first_days AS (
  SELECT user_id, min(activity_date) AS first_day
  FROM ${source.table}
  WHERE user_id IN (SELECT user_id FROM bucket_people)
  GROUP BY user_id
)
SELECT
  to_char(bucket.bucket_start, 'YYYY-MM-DD') AS bucket_start,
  to_char(bucket.selected_from, 'YYYY-MM-DD') AS selected_from,
  to_char(bucket.selected_to, 'YYYY-MM-DD') AS selected_to,
  count(person.user_id) FILTER (WHERE first_days.first_day >= bucket.selected_from)::int AS new_count,
  count(person.user_id) FILTER (WHERE first_days.first_day < bucket.selected_from)::int AS returning_count,
  (now() AT TIME ZONE 'UTC')::date BETWEEN bucket.bucket_start AND bucket.bucket_end AS in_progress
FROM report_buckets AS bucket
LEFT JOIN bucket_people AS person ON person.bucket_start = bucket.bucket_start
LEFT JOIN first_days ON first_days.user_id = person.user_id
GROUP BY bucket.bucket_start, bucket.bucket_end, bucket.selected_from, bucket.selected_to
ORDER BY bucket.bucket_start`;

const malformed = (row: RawRow, column: string): Error =>
  new Error(`new_returning row has a malformed ${column}: ${JSON.stringify(row)}`);

const requireIsoDay = (row: RawRow, column: string): string => {
  const value = row[column];
  if (typeof value !== "string" || !ISO_DAY_PATTERN.test(value)) throw malformed(row, column);
  return value;
};

const requireCount = (row: RawRow, column: string): number => {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw malformed(row, column);
  return value;
};

const requireBoolean = (row: RawRow, column: string): boolean => {
  const value = row[column];
  if (typeof value !== "boolean") throw malformed(row, column);
  return value;
};

const parseBucket = (row: RawRow): NewReturningBucket => ({
  bucketStart: requireIsoDay(row, "bucket_start"),
  selectedFrom: requireIsoDay(row, "selected_from"),
  selectedTo: requireIsoDay(row, "selected_to"),
  newCount: requireCount(row, "new_count"),
  returningCount: requireCount(row, "returning_count"),
  inProgress: requireBoolean(row, "in_progress"),
});

const loadNewReturningBuckets = (
  name: string,
  range: DateRange,
  period: ReportPeriod,
  source: ActivitySource,
  extraParams: ReadonlyArray<QueryParam>,
): Promise<ReadonlyArray<NewReturningBucket>> =>
  queryReport(
    name,
    buildNewReturningSql(period, source),
    [getExcludedEmails(), range.from, range.to, ...extraParams],
    parseBucket,
  );

/** People who opened the app on any of `surfaces` in each bucket; a person's first day counts every surface. */
export const loadWhoOpenedBuckets = (
  range: DateRange,
  period: ReportPeriod,
  surfaces: ReadonlyArray<ActivitySurface>,
): Promise<ReadonlyArray<NewReturningBucket>> => {
  if (surfaces.length === 0) {
    throw new Error("loadWhoOpenedBuckets needs at least one surface; an empty filter would count nobody");
  }
  return loadNewReturningBuckets(`who_opened_${period}`, range, period, OPEN_DAYS_SOURCE, [surfaces]);
};

/** People who tracked a transaction in each bucket. */
export const loadWhoTrackedBuckets = (
  range: DateRange,
  period: ReportPeriod,
): Promise<ReadonlyArray<NewReturningBucket>> =>
  loadNewReturningBuckets(`who_tracked_${period}`, range, period, TRACK_DAYS_SOURCE, []);
