type Translate = (key: string, opts?: Record<string, string | number>) => string;

const DAY_MS = 1000 * 60 * 60 * 24;
const MISSING_DAYS_AGO_SORT_VALUE = Number.NEGATIVE_INFINITY;

export const normalizeDaysAgo = (days: number): number => {
  return Math.max(0, days);
};

export const getDaysAgoValue = (isoString: string, now: Date): number => {
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const rawDays = Math.floor(diffMs / DAY_MS);
  return normalizeDaysAgo(rawDays);
};

export const formatDaysAgoLabel = (days: number, t: Translate): string => {
  if (days === 0) return t("balances.daysAgoToday");
  if (days === 1) return t("balances.daysAgoOne");
  return t("balances.daysAgoMany", { count: days });
};

const getDaysAgoSortValue = (isoString: string | null, now: Date): number => {
  if (isoString === null) return MISSING_DAYS_AGO_SORT_VALUE;
  return getDaysAgoValue(isoString, now);
};

export const compareDaysAgoTimestamps = (
  aIsoString: string | null,
  bIsoString: string | null,
  now: Date,
): number => {
  const cmp = getDaysAgoSortValue(aIsoString, now) - getDaysAgoSortValue(bIsoString, now);
  if (cmp !== 0) return cmp;

  const aValue = aIsoString ?? "";
  const bValue = bIsoString ?? "";
  return aValue.localeCompare(bValue);
};
