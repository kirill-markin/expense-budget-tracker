import { createBadRequestError } from "@/server/api/errors";
import { monthSchema, parseWithSchema } from "@/server/api/validation";

export const PUBLIC_MONTHLY_SHARE_MAX_WINDOW_MONTHS = 24;

export type MonthWindow = Readonly<{
  monthFrom: string;
  monthTo: string;
}>;

const parseMonthParts = (month: string): Readonly<{ year: number; month: number }> => {
  const parsed = parseWithSchema(month, monthSchema);
  const year = Number(parsed.slice(0, 4));
  const monthNumber = Number(parsed.slice(5, 7));
  return { year, month: monthNumber };
};

const toMonthIndex = (month: string): number => {
  const parts = parseMonthParts(month);
  return parts.year * 12 + parts.month - 1;
};

const formatMonthIndex = (monthIndex: number): string => {
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12 + 1;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
};

export const clampMonthWindow = (
  monthFrom: string,
  monthTo: string,
  maxMonths: number,
): MonthWindow => {
  if (!Number.isInteger(maxMonths) || maxMonths < 1) {
    throw new Error(`Invalid maxMonths. Expected positive integer, received ${maxMonths}`);
  }

  const fromIndex = toMonthIndex(monthFrom);
  const toIndex = toMonthIndex(monthTo);
  if (fromIndex > toIndex) {
    throw createBadRequestError("monthFrom must be <= monthTo");
  }

  const cappedToIndex = Math.min(toIndex, fromIndex + maxMonths - 1);
  return {
    monthFrom: formatMonthIndex(fromIndex),
    monthTo: formatMonthIndex(cappedToIndex),
  };
};

export const parsePublicMonthWindowQuery = (searchParams: URLSearchParams): MonthWindow => {
  const monthFrom = searchParams.get("monthFrom");
  const monthTo = searchParams.get("monthTo");

  if (monthFrom === null || monthTo === null) {
    throw createBadRequestError("Missing required query params: monthFrom, monthTo");
  }

  return clampMonthWindow(
    parseWithSchema(monthFrom, monthSchema),
    parseWithSchema(monthTo, monthSchema),
    PUBLIC_MONTHLY_SHARE_MAX_WINDOW_MONTHS,
  );
};

export const monthToDateString = (month: string): string => {
  const parsed = parseWithSchema(month, monthSchema);
  return `${parsed}-01`;
};

export const dateStringToMonth = (dateString: string | null): string | null => {
  if (dateString === null) {
    return null;
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(dateString)) {
    throw new Error(`Invalid first-day month date from database: ${dateString}`);
  }
  return dateString.slice(0, 7);
};
