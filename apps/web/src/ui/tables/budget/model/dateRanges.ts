import { getYear, offsetMonth } from "@/lib/monthUtils";
import {
  isSplitBudgetMonth,
  isSplitBudgetYear,
  type BudgetPlansMode,
} from "@/ui/tables/budget/model/plansMode";

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

/** Which half of the split current-month column a value column renders. */
export type BudgetCurrentMonthPart = "plan" | "actual";

export type BudgetValueColumn = Readonly<{
  key: string;
  /** Column rendered inside the year-total band. */
  isYearTotal: boolean;
  /**
   * Set only for the two split columns of the real current month. The
   * "all-plans" mode splits every elapsed month as well, and those columns
   * carry null: the current-month emphasis belongs to one month alone.
   */
  currentMonthPart: BudgetCurrentMonthPart | null;
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

export const buildBudgetValueColumns = (
  columnSequence: ReadonlyArray<ColumnEntry>,
  currentMonth: string,
  plansMode: BudgetPlansMode,
): ReadonlyArray<BudgetValueColumn> => {
  const currentYear = getYear(currentMonth);
  const result: Array<BudgetValueColumn> = [];

  for (const column of columnSequence) {
    if (column.kind === "month") {
      if (isSplitBudgetMonth(column.month, currentMonth, plansMode)) {
        // Which months split depends on the mode; which month is the current
        // one does not. Only the latter identifies an emphasized column.
        const isCurrentMonth = column.month === currentMonth;
        result.push(
          {
            key: `${column.month}-plan`,
            isYearTotal: false,
            currentMonthPart: isCurrentMonth ? "plan" : null,
          },
          {
            key: `${column.month}-actual`,
            isYearTotal: false,
            currentMonthPart: isCurrentMonth ? "actual" : null,
          },
        );
      } else {
        result.push({ key: column.month, isYearTotal: false, currentMonthPart: null });
      }
      continue;
    }

    if (isSplitBudgetYear(column.year, currentYear, plansMode)) {
      result.push(
        { key: `total-${column.year}-plan`, isYearTotal: true, currentMonthPart: null },
        { key: `total-${column.year}-actual`, isYearTotal: true, currentMonthPart: null },
      );
    } else {
      result.push({ key: `total-${column.year}`, isYearTotal: true, currentMonthPart: null });
    }
  }

  return result;
};

export const isBudgetMonthLoaded = (
  month: string,
  loadedFrom: string,
  loadedTo: string,
): boolean => month >= loadedFrom && month <= loadedTo;

export const isPastMonth = (month: string, currentMonth: string): boolean => month < currentMonth;
export const isFutureMonth = (month: string, currentMonth: string): boolean => month > currentMonth;

export const isDecember = (month: string): boolean => month.endsWith("-12");

export const monthToDateFrom = (month: string): string => `${month}-01`;

export const monthToDateTo = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

/**
 * A month a fill may start from.
 *
 * Filling rewrites the base plan of every later month of the same calendar
 * year, so starting it in an elapsed month would overwrite recorded plan
 * history together with the current and future budget. Plan history stays
 * editable one month at a time.
 */
export const isBudgetFillSourceMonth = (
  month: string,
  currentMonth: string,
): boolean => month >= currentMonth;

export const getTargetFillMonths = (sourceMonth: string): ReadonlyArray<string> => {
  const year = sourceMonth.substring(0, 4);
  const monthNum = parseInt(sourceMonth.substring(5, 7), 10);
  const result: Array<string> = [];
  for (let m = monthNum + 1; m <= 12; m++) {
    result.push(`${year}-${String(m).padStart(2, "0")}`);
  }
  return result;
};
