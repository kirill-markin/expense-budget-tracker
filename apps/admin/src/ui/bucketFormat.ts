import type { NewReturningBucket } from "@/server/reports/newReturning";
import type { ReportPeriod } from "@/server/reports/period";

const COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const formatCount = (count: number): string => COUNT_FORMAT.format(count);

/** Weeks start on Monday and months on the 1st, as the report buckets do. */
export const formatBucketLabel = (period: ReportPeriod, bucketStart: string): string => {
  switch (period) {
    case "day":
      return bucketStart;
    case "week":
      return `Week of ${bucketStart}`;
    case "month":
      return bucketStart.slice(0, 7);
  }
};

/** Edge buckets count only the days inside the selected range. */
export const formatSelectedDays = (bucket: NewReturningBucket): string =>
  bucket.selectedFrom === bucket.selectedTo ? bucket.selectedFrom : `${bucket.selectedFrom} – ${bucket.selectedTo}`;

export const formatBucketTitle = (period: ReportPeriod, bucket: NewReturningBucket): string =>
  period === "day"
    ? formatBucketLabel(period, bucket.bucketStart)
    : `${formatBucketLabel(period, bucket.bucketStart)} (${formatSelectedDays(bucket)})`;
