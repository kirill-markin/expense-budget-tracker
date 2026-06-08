import { getYear } from "@/lib/monthUtils";

export type ColumnEntry = Readonly<
  | { kind: "month"; month: string }
  | { kind: "year-total"; year: string }
>;

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
