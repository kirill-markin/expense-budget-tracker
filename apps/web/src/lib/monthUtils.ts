export const offsetMonth = (base: string, offset: number): string => {
  const [year, month] = base.split("-").map(Number);
  const d = new Date(year, month - 1 + offset, 1);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
};

export const getCurrentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

/**
 * Extracts the four-digit year from a "YYYY-MM" month string.
 */
export const getYear = (month: string): string => month.substring(0, 4);

/**
 * Returns all 12 months ("YYYY-01" through "YYYY-12") for a given year string.
 */
export const getYearMonths = (year: string): ReadonlyArray<string> => {
  const result: Array<string> = [];
  for (let m = 1; m <= 12; m++) {
    result.push(`${year}-${String(m).padStart(2, "0")}`);
  }
  return result;
};

export const generateMonthRange = (from: string, to: string): ReadonlyArray<string> => {
  const result: Array<string> = [];
  let current = from;
  while (current <= to) {
    result.push(current);
    current = offsetMonth(current, 1);
  }
  return result;
};
