import { getYear, getYearMonths } from "@/lib/monthUtils";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import { cellKey, lookupCell, zeroCellValue } from "@/ui/tables/budget/model/cells";
import type { CellValue } from "@/ui/tables/budget/model/cells";

export type DirectionBlock = Readonly<{
  direction: string;
  label: string;
  categories: ReadonlyArray<string>;
  cells: ReadonlyMap<string, CellValue>;
  subtotals: ReadonlyMap<string, CellValue>;
}>;

export const DIRECTION_ORDER: ReadonlyArray<string> = ["income", "spend", "transfer"];

export const DIRECTION_LABELS: Readonly<Record<string, string>> = {
  income: "Income",
  spend: "Spend",
  transfer: "Transfer",
};

/**
 * Computes the "effective value" of a category for sorting.
 * Months before currentMonth use actual; currentMonth and future use planned.
 */
export const computeEffectiveValue = (
  cells: ReadonlyMap<string, CellValue>,
  category: string,
  yearMonths: ReadonlyArray<string>,
  currentMonth: string,
): number => {
  let total = 0;
  for (const month of yearMonths) {
    const cell = lookupCell(cells, month, category);
    total += month < currentMonth ? cell.actual : cell.planned;
  }
  return total;
};

/**
 * Sorts categories by effective value for the current year, descending.
 * Visible categories come first and masked categories retain their source order.
 * Effective values are not computed for masked categories.
 * Stable sort preserves relative order for equal visible values.
 */
export const sortCategoriesByEffectiveValue = (
  categories: ReadonlyArray<string>,
  cells: ReadonlyMap<string, CellValue>,
  currentYearMonths: ReadonlyArray<string>,
  currentMonth: string,
  maskedCategories: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const visibleWithValues = categories
    .filter((category) => !maskedCategories.has(category))
    .map((category) => ({
      category,
      value: computeEffectiveValue(cells, category, currentYearMonths, currentMonth),
    }));
  visibleWithValues.sort((a, b) => b.value - a.value);

  const masked = categories.filter((category) => maskedCategories.has(category));
  return [...visibleWithValues.map((entry) => entry.category), ...masked];
};

/**
 * Groups budget rows into DirectionBlocks with per-month subtotals.
 * Categories are sorted by effective value for the current year (descending):
 * past months use actual, current and future months use planned.
 * When an allowlist is active, visible (allowed) categories
 * are sorted first, then masked ones in their original encounter order.
 */
export const buildBlocks = (
  rows: ReadonlyArray<BudgetRow>,
  months: ReadonlyArray<string>,
  currentMonth: string,
  allowlist: ReadonlySet<string> | null,
): ReadonlyArray<DirectionBlock> => {
  const cellMap = new Map<string, Map<string, CellValue>>();
  const categorySet = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!cellMap.has(row.direction)) {
      cellMap.set(row.direction, new Map());
    }
    if (!categorySet.has(row.direction)) {
      categorySet.set(row.direction, new Set());
    }

    const dirCells = cellMap.get(row.direction)!;
    const key = cellKey(row.month, row.category);
    const existing = dirCells.get(key) ?? zeroCellValue;
    dirCells.set(key, {
      plannedBase: existing.plannedBase + row.plannedBase,
      plannedModifier: existing.plannedModifier + row.plannedModifier,
      planned: existing.planned + row.planned,
      actual: existing.actual + row.actual,
    });

    categorySet.get(row.direction)!.add(row.category);
  }

  const currentYear = getYear(currentMonth);
  const monthSet = new Set(months);
  const currentYearMonths = getYearMonths(currentYear).filter((m) => monthSet.has(m));

  return DIRECTION_ORDER
    .filter((dir) => categorySet.has(dir))
    .map((dir) => {
      const cells = cellMap.get(dir)!;
      const unsortedCategories = Array.from(categorySet.get(dir)!);
      const maskedCategories: ReadonlySet<string> = allowlist !== null
        ? new Set(unsortedCategories.filter((c) => !allowlist.has(c)))
        : new Set();
      const categories = sortCategoriesByEffectiveValue(unsortedCategories, cells, currentYearMonths, currentMonth, maskedCategories);

      const subtotals = new Map<string, CellValue>();
      for (const month of months) {
        let baseSum = 0;
        let modSum = 0;
        let plannedSum = 0;
        let actualSum = 0;
        for (const cat of categories) {
          const cell = lookupCell(cells, month, cat);
          baseSum += cell.plannedBase;
          modSum += cell.plannedModifier;
          plannedSum += cell.planned;
          actualSum += cell.actual;
        }
        subtotals.set(month, { plannedBase: baseSum, plannedModifier: modSum, planned: plannedSum, actual: actualSum });
      }

      return {
        direction: dir,
        label: DIRECTION_LABELS[dir] ?? dir,
        categories,
        cells,
        subtotals,
      };
    });
};

/**
 * Computes subtotals for a direction block including only allowed categories.
 * Used in filtered mode to show partial but accurate direction subtotals.
 */
export const computeAllowedSubtotals = (
  block: DirectionBlock,
  months: ReadonlyArray<string>,
  allowlist: ReadonlySet<string>,
): ReadonlyMap<string, CellValue> => {
  const result = new Map<string, CellValue>();
  const visibleCategories = block.categories.filter((c) => allowlist.has(c));
  for (const month of months) {
    let baseSum = 0;
    let modSum = 0;
    let plannedSum = 0;
    let actualSum = 0;
    for (const cat of visibleCategories) {
      const cell = lookupCell(block.cells, month, cat);
      baseSum += cell.plannedBase;
      modSum += cell.plannedModifier;
      plannedSum += cell.planned;
      actualSum += cell.actual;
    }
    result.set(month, { plannedBase: baseSum, plannedModifier: modSum, planned: plannedSum, actual: actualSum });
  }
  return result;
};
