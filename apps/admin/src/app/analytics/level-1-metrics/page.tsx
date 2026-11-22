import Link from "next/link";
import type { ReactElement } from "react";

import { loadWhoOpenedBuckets, loadWhoTrackedBuckets } from "@/server/reports/newReturning";
import {
  defaultDateRange,
  parseDateRange,
  parseReportPeriod,
  type DateRange,
  type ReportPeriod,
} from "@/server/reports/period";
import { ACTIVITY_SURFACES, type ActivitySurface } from "@/server/reports/usersList";
import { FilterBar, SURFACES_SET_PARAM } from "@/ui/FilterBar";
import { MetricCard, MetricEmptyState, NewReturningDataTable } from "@/ui/MetricCard";
import { NewReturningBarChart } from "@/ui/NewReturningBarChart";

import styles from "./level1.module.css";

const PAGE_PATH = "/analytics/level-1-metrics";

type SearchParams = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

type Level1Filters = Readonly<{
  range: DateRange;
  period: ReportPeriod;
  surfaces: ReadonlyArray<ActivitySurface>;
}>;

type FilterError = Readonly<{ parameter: string; value: string; message: string }>;

type Parsed<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: FilterError }>;

const BUCKET_NOTES: Readonly<Record<ReportPeriod, string>> = {
  day: "Each bar is one UTC day.",
  week: "Each bar is one UTC week, Monday to Sunday; edge bars count only the selected days.",
  month: "Each bar is one UTC calendar month; edge bars count only the selected days.",
};

const parsedOrError = <Value,>(parameter: string, value: string, parse: () => Value): Parsed<Value> => {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, error: { parameter, value, message: error.message } };
  }
};

const readSingle = (params: SearchParams, name: string): Parsed<string | undefined> => {
  const value = params[name];
  if (typeof value === "string" || value === undefined) return { ok: true, value };
  return {
    ok: false,
    error: { parameter: name, value: value.join(", "), message: `${name} must be given once, got ${value.length} values` },
  };
};

const isActivitySurface = (value: string): value is ActivitySurface =>
  ACTIVITY_SURFACES.some((surface: ActivitySurface): boolean => surface === value);

/**
 * No `surface` parameter means every surface, unless the filter form's marker shows that the
 * person unchecked them all. The result keeps the canonical surface order.
 */
const parseSurfaces = (params: SearchParams): Parsed<ReadonlyArray<ActivitySurface>> => {
  const raw = params.surface;
  if (raw === undefined && params[SURFACES_SET_PARAM] !== undefined) {
    return { ok: false, error: { parameter: "surface", value: "", message: "select at least one surface" } };
  }
  if (raw === undefined) return { ok: true, value: ACTIVITY_SURFACES };
  const values: ReadonlyArray<string> = typeof raw === "string" ? [raw] : raw;
  const unknown = values.find((value: string): boolean => !isActivitySurface(value));
  if (unknown !== undefined) {
    return {
      ok: false,
      error: { parameter: "surface", value: unknown, message: `surface must be one of ${ACTIVITY_SURFACES.join(", ")}` },
    };
  }
  return { ok: true, value: ACTIVITY_SURFACES.filter((surface: ActivitySurface): boolean => values.includes(surface)) };
};

/** Missing parameters take the defaults: the last 60 days ending `today`, daily bars, every surface. */
const parseFilters = (params: SearchParams, today: string): Parsed<Level1Filters> => {
  const from = readSingle(params, "from");
  if (!from.ok) return from;
  const to = readSingle(params, "to");
  if (!to.ok) return to;
  const periodValue = readSingle(params, "period");
  if (!periodValue.ok) return periodValue;

  const defaults = defaultDateRange(today);
  const fromDay = from.value ?? defaults.from;
  const toDay = to.value ?? defaults.to;
  const range = parsedOrError("from/to", `${fromDay} – ${toDay}`, () => parseDateRange(fromDay, toDay, today));
  if (!range.ok) return range;
  const periodRaw = periodValue.value;
  const period: Parsed<ReportPeriod> = periodRaw === undefined
    ? { ok: true, value: "day" }
    : parsedOrError("period", periodRaw, () => parseReportPeriod(periodRaw));
  if (!period.ok) return period;
  const surfaces = parseSurfaces(params);
  if (!surfaces.ok) return surfaces;
  return { ok: true, value: { range: range.value, period: period.value, surfaces: surfaces.value } };
};

const newReturningNotes = (whatCounts: string, firstDay: string, period: ReportPeriod): ReadonlyArray<string> => [
  whatCounts,
  BUCKET_NOTES[period],
  `New: the person's first ${firstDay} falls inside the bar's selected days; returning: it came earlier.`,
  "A faded bar is still in progress: it contains today UTC.",
  "Admins, excluded emails and the local dev user are not counted.",
  "Days before activity recording launched are backfilled from older data, so that history is approximate.",
];

const FilterErrorMessage = (props: Readonly<{ error: FilterError }>): ReactElement => (
  <div className={styles.error} role="alert" data-testid="level1-filter-error">
    <strong>Invalid {props.error.parameter}: {JSON.stringify(props.error.value)}</strong>
    <span>{props.error.message}.</span>
    <Link href={PAGE_PATH}>Reset the filters</Link>
  </div>
);

export default async function Level1MetricsPage(
  props: Readonly<{ searchParams: Promise<SearchParams> }>,
): Promise<ReactElement> {
  const searchParams = await props.searchParams;
  // One UTC "today" per request, for the defaults and the range check alike.
  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseFilters(searchParams, today);

  if (!parsed.ok) {
    return (
      <>
        <h1 className={styles.title}>Level 1 metrics</h1>
        <FilterErrorMessage error={parsed.error} />
      </>
    );
  }

  const { range, period, surfaces } = parsed.value;
  const [openedBuckets, trackedBuckets] = await Promise.all([
    loadWhoOpenedBuckets(range, period, surfaces),
    loadWhoTrackedBuckets(range, period),
  ]);

  return (
    <>
      <h1 className={styles.title}>Level 1 metrics</h1>
      <p className={styles.summary}>
        Unique people per bar, from the last funnel stage to the first. {range.from} – {range.to}, UTC.
      </p>
      <FilterBar range={range} period={period} surfaces={surfaces} today={today} resetHref={PAGE_PATH} />
      <div className={styles.grid}>
        <MetricCard title="Who paid us" testId="metric-who-paid-us" notes={[]}>
          <MetricEmptyState message="There is no paywall yet, so there is nothing to count." />
        </MetricCard>
        <MetricCard
          title="Who tracked"
          testId="metric-who-tracked"
          notes={newReturningNotes(
            "Counts people who added at least one transaction. The surface filter does not apply: hand-entered and AI-entered transactions count the same.",
            "tracked day",
            period,
          )}
        >
          <NewReturningBarChart title="Who tracked" period={period} buckets={trackedBuckets} />
          <NewReturningDataTable period={period} buckets={trackedBuckets} />
        </MetricCard>
        <MetricCard
          title="Who opened the app"
          testId="metric-who-opened"
          notes={newReturningNotes(
            `Counts people who opened the app on the selected surfaces: ${surfaces.join(", ")}.`,
            "open day on any surface",
            period,
          )}
        >
          <NewReturningBarChart title="Who opened the app" period={period} buckets={openedBuckets} />
          <NewReturningDataTable period={period} buckets={openedBuckets} />
        </MetricCard>
        <MetricCard title="Who saw us" testId="metric-who-saw-us" notes={[]}>
          <MetricEmptyState message="Website visitor tracking is not collected yet, so there is nothing to count." />
        </MetricCard>
      </div>
    </>
  );
}
