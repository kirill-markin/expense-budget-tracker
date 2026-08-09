import { getYear, offsetMonth } from "@/lib/monthUtils";

export type ColumnEntry = Readonly<
  | { kind: "month"; month: string }
  | { kind: "year-total"; year: string }
>;

export type BudgetDisplayRange = Readonly<{
  monthFrom: string;
  monthTo: string;
}>;

export type BudgetRangeExtension = Readonly<{
  direction: "left" | "right";
  monthFrom: string;
  monthTo: string;
}>;

const DISPLAY_YEAR_RADIUS = 10;

export const getBudgetDisplayRange = (currentMonth: string): BudgetDisplayRange => {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(currentMonth)) {
    throw new RangeError(`Current budget month "${currentMonth}" must use YYYY-MM format`);
  }
  const currentYear = Number(getYear(currentMonth));

  return {
    monthFrom: `${currentYear - DISPLAY_YEAR_RADIUS}-01`,
    monthTo: `${currentYear + DISPLAY_YEAR_RADIUS}-12`,
  };
};

/**
 * Returns the next missing range needed to keep loaded months contiguous while
 * extending toward the observed fixed-calendar columns.
 */
export const getBudgetRangeExtension = (
  displayFrom: string,
  displayTo: string,
  loadedFrom: string,
  loadedTo: string,
  observedFrom: string,
  observedTo: string,
  batchSize: number,
): BudgetRangeExtension | null => {
  if (displayFrom > loadedFrom || loadedFrom > loadedTo || loadedTo > displayTo) {
    throw new RangeError(
      `Loaded budget range ${loadedFrom}..${loadedTo} must be inside display range ${displayFrom}..${displayTo}`,
    );
  }
  if (observedFrom > observedTo) {
    throw new RangeError(
      `Observed budget month ${observedFrom} must not be after ${observedTo}`,
    );
  }
  if (observedFrom < displayFrom || observedTo > displayTo) {
    throw new RangeError(
      `Observed budget range ${observedFrom}..${observedTo} must be inside display range ${displayFrom}..${displayTo}`,
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`Budget range batch size must be a positive integer, received ${batchSize}`);
  }

  if (observedFrom < loadedFrom) {
    const overscannedFrom = offsetMonth(observedFrom, -(batchSize - 1));
    return {
      direction: "left",
      monthFrom: overscannedFrom < displayFrom ? displayFrom : overscannedFrom,
      monthTo: offsetMonth(loadedFrom, -1),
    };
  }

  if (observedTo > loadedTo) {
    const overscannedTo = offsetMonth(observedTo, batchSize - 1);
    return {
      direction: "right",
      monthFrom: offsetMonth(loadedTo, 1),
      monthTo: overscannedTo > displayTo ? displayTo : overscannedTo,
    };
  }

  return null;
};

/**
 * Builds an ordered column sequence from a month range, inserting a
 * year-total entry after December of each calendar year present in the range.
 */
export const buildColumnSequence = (months: ReadonlyArray<string>): ReadonlyArray<ColumnEntry> => {
  const result: Array<ColumnEntry> = [];
  for (const month of months) {
    result.push({ kind: "month", month });
    if (month.endsWith("-12")) {
      result.push({ kind: "year-total", year: getYear(month) });
    }
  }
  return result;
};

export const isPastMonth = (month: string, currentMonth: string): boolean => month < currentMonth;
export const isFutureMonth = (month: string, currentMonth: string): boolean => month > currentMonth;

export const isDecember = (month: string): boolean => month.endsWith("-12");

export const monthToDateFrom = (month: string): string => `${month}-01`;

export const monthToDateTo = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

export const getTargetFillMonths = (sourceMonth: string): ReadonlyArray<string> => {
  const year = sourceMonth.substring(0, 4);
  const monthNum = parseInt(sourceMonth.substring(5, 7), 10);
  const result: Array<string> = [];
  for (let m = monthNum + 1; m <= 12; m++) {
    result.push(`${year}-${String(m).padStart(2, "0")}`);
  }
  return result;
};
