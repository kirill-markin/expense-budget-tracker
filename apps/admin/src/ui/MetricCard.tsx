import type { ReactElement, ReactNode } from "react";

import type { NewReturningBucket } from "@/server/reports/newReturning";
import type { ReportPeriod } from "@/server/reports/period";
import { formatBucketLabel, formatCount, formatSelectedDays } from "@/ui/bucketFormat";

import styles from "./MetricCard.module.css";

type MetricCardProps = Readonly<{
  title: string;
  testId: string;
  notes: ReadonlyArray<string>;
  children: ReactNode;
}>;

export const MetricCard = (props: MetricCardProps): ReactElement => {
  const { title, testId, notes, children } = props;
  const headingId = `${testId}-title`;
  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid={testId}>
      <h2 id={headingId} className={styles.title}>{title}</h2>
      {notes.length > 0 && (
        <ul className={styles.notes}>
          {notes.map((note: string) => <li key={note}>{note}</li>)}
        </ul>
      )}
      {children}
    </section>
  );
};

export const MetricEmptyState = (props: Readonly<{ message: string }>): ReactElement => (
  <p className={styles.empty} data-testid="metric-empty-state">{props.message}</p>
);

export const NewReturningDataTable = (
  props: Readonly<{ period: ReportPeriod; buckets: ReadonlyArray<NewReturningBucket> }>,
): ReactElement => {
  const { period, buckets } = props;
  return (
    <details className={styles.details}>
      <summary>Data table</summary>
      <div className={styles.tableWrapper}>
        <table className={styles.table} data-testid="new-returning-table">
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Selected days (UTC)</th>
              <th scope="col" className={styles.number}>New</th>
              <th scope="col" className={styles.number}>Returning</th>
              <th scope="col" className={styles.number}>Total</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket: NewReturningBucket) => (
              <tr key={bucket.bucketStart}>
                <th scope="row">
                  {formatBucketLabel(period, bucket.bucketStart)}
                  {bucket.inProgress && <span className={styles.inProgress}>in progress</span>}
                </th>
                <td>{formatSelectedDays(bucket)}</td>
                <td className={styles.number}>{formatCount(bucket.newCount)}</td>
                <td className={styles.number}>{formatCount(bucket.returningCount)}</td>
                <td className={styles.number}>{formatCount(bucket.newCount + bucket.returningCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
};
