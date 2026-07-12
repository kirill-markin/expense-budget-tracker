import type { NumberFormat } from "@/lib/locale";
import { NUMBER_FORMAT_LOCALE } from "@/ui/tables/shared/format";

export type CellValue = Readonly<{
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  actual: number;
}>;

export const cellKey = (month: string, category: string): string => `${month}::${category}`;

export const zeroCellValue: CellValue = { plannedBase: 0, plannedModifier: 0, planned: 0, actual: 0 };

export const lookupCell = (cells: ReadonlyMap<string, CellValue>, month: string, category: string): CellValue => {
  return cells.get(cellKey(month, category)) ?? zeroCellValue;
};

export const formatAmount = (value: number, numberFormat: NumberFormat): string => {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return rounded.toLocaleString(NUMBER_FORMAT_LOCALE[numberFormat]);
};

export const formatSignedAmount = (value: number, numberFormat: NumberFormat): string => {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  const formatted = rounded.toLocaleString(NUMBER_FORMAT_LOCALE[numberFormat]);
  return rounded > 0 ? `+${formatted}` : formatted;
};

/**
 * Sums CellValues produced by a lookup function over a list of months.
 * Used for both per-category totals and direction subtotals.
 */
export const sumCellValuesOverMonths = (
  monthsToSum: ReadonlyArray<string>,
  getValue: (month: string) => CellValue,
): CellValue => {
  let baseSum = 0;
  let modSum = 0;
  let plannedSum = 0;
  let actualSum = 0;
  for (const month of monthsToSum) {
    const cell = getValue(month);
    baseSum += cell.plannedBase;
    modSum += cell.plannedModifier;
    plannedSum += cell.planned;
    actualSum += cell.actual;
  }
  return { plannedBase: baseSum, plannedModifier: modSum, planned: plannedSum, actual: actualSum };
};
