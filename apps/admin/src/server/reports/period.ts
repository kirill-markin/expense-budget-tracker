export type ReportPeriod = "day" | "week" | "month";

/** Inclusive range of UTC ISO days (YYYY-MM-DD). */
export type DateRange = Readonly<{ from: string; to: string }>;

export const DEFAULT_RANGE_DAYS = 60;
export const MAX_RANGE_YEARS = 3;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

const BUCKET_INTERVAL_SQL: Readonly<Record<ReportPeriod, string>> = {
  day: "interval '1 day'",
  week: "interval '1 week'",
  month: "interval '1 month'",
};

const isReportPeriod = (value: string): value is ReportPeriod =>
  value === "day" || value === "week" || value === "month";

export const parseReportPeriod = (value: string): ReportPeriod => {
  if (!isReportPeriod(value)) {
    throw new Error(`Report period must be "day", "week" or "month", got ${JSON.stringify(value)}`);
  }
  return value;
};

const isIsoDay = (value: string): boolean =>
  ISO_DAY_PATTERN.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const requireIsoDay = (name: string, value: string): string => {
  if (!isIsoDay(value)) {
    throw new Error(`${name} must be a real calendar day in YYYY-MM-DD form, got ${JSON.stringify(value)}`);
  }
  return value;
};

const toIsoDay = (date: Date): string => date.toISOString().slice(0, 10);

const addUtcYears = (day: string, years: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return toIsoDay(date);
};

/** `today` is the UTC ISO day the range may not pass. */
export const parseDateRange = (from: string, to: string, today: string): DateRange => {
  requireIsoDay("from", from);
  requireIsoDay("to", to);
  requireIsoDay("today", today);
  if (from > to) {
    throw new Error(`from must be on or before to, got from=${from} to=${to}`);
  }
  if (to > today) {
    throw new Error(`to must not be later than today UTC (${today}), got to=${to}`);
  }
  if (to >= addUtcYears(from, MAX_RANGE_YEARS)) {
    throw new Error(`The range may span at most ${MAX_RANGE_YEARS} years, got from=${from} to=${to}`);
  }
  return { from, to };
};

/** The last DEFAULT_RANGE_DAYS days ending `today`, a UTC ISO day, inclusive. */
export const defaultDateRange = (today: string): DateRange => {
  requireIsoDay("today", today);
  const from = new Date(new Date(`${today}T00:00:00Z`).getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  return { from: toIsoDay(from), to: today };
};

/**
 * A `report_buckets` CTE over the range `$2::date`..`$3::date`: one row per
 * calendar bucket with `bucket_start`, `bucket_end`, and the selected days
 * `selected_from`..`selected_to` clipped to the range. The math runs on
 * timestamp without time zone so the session TimeZone never shifts a bucket;
 * `date_trunc('week')` starts weeks on Monday.
 */
export const buildReportBucketsCteSql = (period: ReportPeriod): string => {
  const interval = BUCKET_INTERVAL_SQL[period];
  return `report_buckets AS (
  SELECT
    bucket_start::date AS bucket_start,
    (bucket_start + ${interval})::date - 1 AS bucket_end,
    GREATEST(bucket_start::date, $2::date) AS selected_from,
    LEAST((bucket_start + ${interval})::date - 1, $3::date) AS selected_to
  FROM generate_series(
    date_trunc('${period}', $2::date::timestamp),
    date_trunc('${period}', $3::date::timestamp),
    ${interval}
  ) AS bucket_start
)`;
};
