import Link from "next/link";
import type { ReactElement } from "react";

import type { DateRange, ReportPeriod } from "@/server/reports/period";
import { ACTIVITY_SURFACES, type ActivitySurface } from "@/server/reports/usersList";

import styles from "./FilterBar.module.css";

type Props = Readonly<{
  range: DateRange;
  period: ReportPeriod;
  surfaces: ReadonlyArray<ActivitySurface>;
  /** UTC ISO day; the last day either date input offers. */
  today: string;
  resetHref: string;
}>;

const PERIOD_OPTIONS: ReadonlyArray<Readonly<{ value: ReportPeriod; label: string }>> = [
  { value: "day", label: "Days" },
  { value: "week", label: "Weeks" },
  { value: "month", label: "Months" },
];

/** Sent with every submit; unchecked boxes send nothing, so it tells an empty selection from a bare URL. */
export const SURFACES_SET_PARAM = "surfaces_set";

const SURFACE_LABELS: Readonly<Record<ActivitySurface, string>> = { web: "Web", api: "API", mcp: "MCP" };

/** A plain GET form: every filter lives in the URL, so it survives reload and needs no client state. */
export const FilterBar = (props: Props): ReactElement => {
  const { range, period, surfaces, today, resetHref } = props;
  return (
    <form method="get" className={styles.bar} data-testid="level1-filter-bar">
      <label className={styles.field}>
        <span>From (UTC)</span>
        <input type="date" name="from" defaultValue={range.from} max={today} required data-testid="filter-from" />
      </label>
      <label className={styles.field}>
        <span>To (UTC)</span>
        <input type="date" name="to" defaultValue={range.to} max={today} required data-testid="filter-to" />
      </label>
      <label className={styles.field}>
        <span>Group by</span>
        <select name="period" defaultValue={period} data-testid="filter-period">
          {PERIOD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <fieldset className={styles.surfaces}>
        <legend>Surfaces · Who opened the app</legend>
        <input type="hidden" name={SURFACES_SET_PARAM} value="1" />
        <div className={styles.checkboxes}>
          {ACTIVITY_SURFACES.map((surface: ActivitySurface) => (
            <label key={surface} className={styles.checkbox}>
              <input
                type="checkbox"
                name="surface"
                value={surface}
                defaultChecked={surfaces.includes(surface)}
                data-testid={`filter-surface-${surface}`}
              />
              {SURFACE_LABELS[surface]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className={styles.actions}>
        <button type="submit" className={styles.apply} data-testid="filter-apply">Apply</button>
        <Link href={resetHref} data-testid="filter-reset">Reset</Link>
      </div>
    </form>
  );
};
