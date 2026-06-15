import { generateMonthRange, getCurrentMonth, getYear, offsetMonth } from "@/lib/monthUtils";
import type {
  PublicMonthlyCategoryShare,
  PublicMonthlyShareAccessLevel,
  PublicMonthlyShareCell,
  PublicMonthlyShareYearTotal,
} from "@/server/community/publicMonthlyCategoryShareTypes";

export const PUBLIC_MONTHLY_SHARE_INITIAL_WINDOW_MONTHS = 12;
export const PUBLIC_MONTHLY_SHARE_BACKFILL_WINDOW_MONTHS = 12;

export type PublicMonthlyShareWindow = Readonly<{
  monthFrom: string;
  monthTo: string;
}>;

export type PublicMonthlyShareColumn = Readonly<
  | { kind: "month"; month: string }
  | { kind: "year-total"; year: string }
>;

export type PublicMonthlyShareTableRow = Readonly<{
  category: string;
  accessLevel: PublicMonthlyShareAccessLevel;
  monthAmounts: ReadonlyMap<string, number>;
  yearTotals: ReadonlyMap<string, number>;
  visibleYearTotal: number;
}>;

export type PublicMonthlyShareTableModel = Readonly<{
  months: ReadonlyArray<string>;
  columns: ReadonlyArray<PublicMonthlyShareColumn>;
  rows: ReadonlyArray<PublicMonthlyShareTableRow>;
  hasSelectedCategories: boolean;
}>;

const cellKey = (cell: PublicMonthlyShareCell): string =>
  `${cell.month}\u0000${cell.category}`;

const compareCells = (
  left: PublicMonthlyShareCell,
  right: PublicMonthlyShareCell,
): number => {
  const monthCompare = left.month.localeCompare(right.month);
  if (monthCompare !== 0) {
    return monthCompare;
  }
  return left.category.localeCompare(right.category);
};

const compareYearTotals = (
  left: PublicMonthlyShareYearTotal,
  right: PublicMonthlyShareYearTotal,
): number => {
  const yearCompare = left.year.localeCompare(right.year);
  if (yearCompare !== 0) {
    return yearCompare;
  }
  return left.category.localeCompare(right.category);
};

const minMonthOrNull = (left: string | null, right: string | null): string | null => {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left < right ? left : right;
};

const maxMonthOrNull = (left: string | null, right: string | null): string | null => {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left > right ? left : right;
};

const maxMonth = (left: string, right: string): string =>
  left > right ? left : right;

const minMonth = (left: string, right: string): string =>
  left < right ? left : right;

const clampLoadedMonthFrom = (
  loadedMonthFrom: string | null,
  availableMonthFrom: string | null,
  availableMonthTo: string | null,
): string | null => {
  if (loadedMonthFrom === null || availableMonthFrom === null || availableMonthTo === null) {
    return null;
  }
  const clamped = maxMonth(loadedMonthFrom, availableMonthFrom);
  return clamped > availableMonthTo ? null : clamped;
};

const clampLoadedMonthTo = (
  loadedMonthTo: string | null,
  availableMonthFrom: string | null,
  availableMonthTo: string | null,
): string | null => {
  if (loadedMonthTo === null || availableMonthFrom === null || availableMonthTo === null) {
    return null;
  }
  const clamped = minMonth(loadedMonthTo, availableMonthTo);
  return clamped < availableMonthFrom ? null : clamped;
};

const mergeCells = (
  currentCells: ReadonlyArray<PublicMonthlyShareCell>,
  fetchedCells: ReadonlyArray<PublicMonthlyShareCell>,
): ReadonlyArray<PublicMonthlyShareCell> => {
  const merged = new Map<string, PublicMonthlyShareCell>();
  for (const cell of currentCells) {
    merged.set(cellKey(cell), cell);
  }
  for (const cell of fetchedCells) {
    merged.set(cellKey(cell), cell);
  }
  return Array.from(merged.values()).sort(compareCells);
};

const buildMonthlyValueCategorySet = (
  share: PublicMonthlyCategoryShare,
): ReadonlySet<string> => {
  const monthlyValueCategories = new Set<string>();
  for (const category of share.categories) {
    if (category.accessLevel === "monthly_values") {
      monthlyValueCategories.add(category.category);
    }
  }
  return monthlyValueCategories;
};

const filterCellsForShare = (
  cells: ReadonlyArray<PublicMonthlyShareCell>,
  share: PublicMonthlyCategoryShare,
): ReadonlyArray<PublicMonthlyShareCell> => {
  const loadedMonthFrom = share.loadedMonthFrom;
  const loadedMonthTo = share.loadedMonthTo;
  if (loadedMonthFrom === null || loadedMonthTo === null) {
    return [];
  }

  const monthlyValueCategories = buildMonthlyValueCategorySet(share);
  return cells.filter((cell: PublicMonthlyShareCell): boolean =>
    monthlyValueCategories.has(cell.category)
    && cell.month >= loadedMonthFrom
    && cell.month <= loadedMonthTo);
};

const buildMonthAmountsByCategory = (
  cells: ReadonlyArray<PublicMonthlyShareCell>,
): ReadonlyMap<string, ReadonlyMap<string, number>> => {
  const byCategory = new Map<string, Map<string, number>>();

  for (const cell of cells) {
    const categoryAmounts = byCategory.get(cell.category) ?? new Map<string, number>();
    categoryAmounts.set(cell.month, cell.amount);
    byCategory.set(cell.category, categoryAmounts);
  }

  return byCategory;
};

const buildYearTotalsByCategory = (
  yearTotals: ReadonlyArray<PublicMonthlyShareYearTotal>,
): ReadonlyMap<string, ReadonlyMap<string, number>> => {
  const byCategory = new Map<string, Map<string, number>>();

  for (const total of yearTotals) {
    const categoryTotals = byCategory.get(total.category) ?? new Map<string, number>();
    categoryTotals.set(total.year, total.amount);
    byCategory.set(total.category, categoryTotals);
  }

  return byCategory;
};

const yearTotalKey = (category: string, year: string): string =>
  `${year}\u0000${category}`;

const buildVisibleYears = (months: ReadonlyArray<string>): ReadonlyArray<string> => {
  const years: Array<string> = [];
  for (const month of months) {
    const year = getYear(month);
    if (!years.includes(year)) {
      years.push(year);
    }
  }
  return years;
};

const buildVisibleYearSet = (
  loadedMonthFrom: string | null,
  loadedMonthTo: string | null,
): ReadonlySet<string> => {
  if (loadedMonthFrom === null || loadedMonthTo === null) {
    return new Set<string>();
  }
  return new Set(buildVisibleYears(generateMonthRange(loadedMonthFrom, loadedMonthTo)));
};

const mergeYearTotals = (
  currentYearTotals: ReadonlyArray<PublicMonthlyShareYearTotal>,
  fetchedYearTotals: ReadonlyArray<PublicMonthlyShareYearTotal>,
  mergedShare: PublicMonthlyCategoryShare,
): ReadonlyArray<PublicMonthlyShareYearTotal> => {
  const visibleYears = buildVisibleYearSet(mergedShare.loadedMonthFrom, mergedShare.loadedMonthTo);
  const monthlyValueCategories = buildMonthlyValueCategorySet(mergedShare);
  const totals = new Map<string, PublicMonthlyShareYearTotal>();

  for (const total of [...currentYearTotals, ...fetchedYearTotals]) {
    if (!visibleYears.has(total.year) || !monthlyValueCategories.has(total.category)) {
      continue;
    }
    totals.set(yearTotalKey(total.category, total.year), total);
  }

  return Array.from(totals.values()).sort(compareYearTotals);
};

const sumVisibleYearTotals = (
  totals: ReadonlyMap<string, number>,
  visibleYears: ReadonlyArray<string>,
): number => {
  let result = 0;
  for (const year of visibleYears) {
    result += totals.get(year) ?? 0;
  }
  return result;
};

export const buildPublicMonthlyShareProbeWindow = (): PublicMonthlyShareWindow => {
  const previousMonth = offsetMonth(getCurrentMonth(), -1);
  return {
    monthFrom: previousMonth,
    monthTo: previousMonth,
  };
};

export const buildLatestPublicMonthlyShareWindow = (
  availableMonthFrom: string | null,
  availableMonthTo: string | null,
  windowMonths: number,
): PublicMonthlyShareWindow | null => {
  if (!Number.isInteger(windowMonths) || windowMonths < 1) {
    throw new Error(`Invalid public monthly share window size: ${windowMonths}`);
  }
  if (availableMonthFrom === null || availableMonthTo === null) {
    return null;
  }

  const candidateFrom = offsetMonth(availableMonthTo, -(windowMonths - 1));
  return {
    monthFrom: maxMonth(availableMonthFrom, candidateFrom),
    monthTo: availableMonthTo,
  };
};

export const buildEarlierPublicMonthlyShareWindow = (
  loadedMonthFrom: string | null,
  availableMonthFrom: string | null,
  windowMonths: number,
): PublicMonthlyShareWindow | null => {
  if (!Number.isInteger(windowMonths) || windowMonths < 1) {
    throw new Error(`Invalid public monthly share backfill window size: ${windowMonths}`);
  }
  if (loadedMonthFrom === null || availableMonthFrom === null || loadedMonthFrom <= availableMonthFrom) {
    return null;
  }

  return {
    monthFrom: maxMonth(availableMonthFrom, offsetMonth(loadedMonthFrom, -windowMonths)),
    monthTo: offsetMonth(loadedMonthFrom, -1),
  };
};

export const buildPublicMonthlyShareColumnSequence = (
  months: ReadonlyArray<string>,
): ReadonlyArray<PublicMonthlyShareColumn> => {
  const columns: Array<PublicMonthlyShareColumn> = [];

  for (let index = 0; index < months.length; index++) {
    const month = months[index];
    const nextMonth = months[index + 1];
    columns.push({ kind: "month", month });
    if (nextMonth === undefined || getYear(nextMonth) !== getYear(month)) {
      columns.push({ kind: "year-total", year: getYear(month) });
    }
  }

  return columns;
};

export const mergePublicMonthlyShareWindows = (
  currentShare: PublicMonthlyCategoryShare,
  fetchedShare: PublicMonthlyCategoryShare,
): PublicMonthlyCategoryShare => {
  const loadedMonthFrom = clampLoadedMonthFrom(
    minMonthOrNull(currentShare.loadedMonthFrom, fetchedShare.loadedMonthFrom),
    fetchedShare.availableMonthFrom,
    fetchedShare.availableMonthTo,
  );
  const loadedMonthTo = clampLoadedMonthTo(
    maxMonthOrNull(currentShare.loadedMonthTo, fetchedShare.loadedMonthTo),
    fetchedShare.availableMonthFrom,
    fetchedShare.availableMonthTo,
  );
  const mergedShare: PublicMonthlyCategoryShare = {
    label: fetchedShare.label,
    currency: fetchedShare.currency,
    availableMonthFrom: fetchedShare.availableMonthFrom,
    availableMonthTo: fetchedShare.availableMonthTo,
    loadedMonthFrom: loadedMonthFrom !== null && loadedMonthTo !== null && loadedMonthFrom <= loadedMonthTo
      ? loadedMonthFrom
      : null,
    loadedMonthTo: loadedMonthFrom !== null && loadedMonthTo !== null && loadedMonthFrom <= loadedMonthTo
      ? loadedMonthTo
      : null,
    categories: fetchedShare.categories,
    cells: [],
    yearTotals: [],
  };
  const mergedCells = filterCellsForShare(mergeCells(currentShare.cells, fetchedShare.cells), mergedShare);

  return {
    ...mergedShare,
    cells: mergedCells,
    yearTotals: mergeYearTotals(currentShare.yearTotals, fetchedShare.yearTotals, mergedShare),
  };
};

export const buildPublicMonthlyShareTableModel = (
  share: PublicMonthlyCategoryShare,
): PublicMonthlyShareTableModel => {
  const months = share.loadedMonthFrom === null || share.loadedMonthTo === null
    ? []
    : generateMonthRange(share.loadedMonthFrom, share.loadedMonthTo);
  const columns = buildPublicMonthlyShareColumnSequence(months);
  const visibleYears = buildVisibleYears(months);
  const monthAmountsByCategory = buildMonthAmountsByCategory(share.cells);
  const yearTotalsByCategory = buildYearTotalsByCategory(share.yearTotals);

  const monthlyValueRows: Array<PublicMonthlyShareTableRow> = [];
  const categoryOnlyRows: Array<PublicMonthlyShareTableRow> = [];

  for (const category of share.categories) {
    const yearTotals = yearTotalsByCategory.get(category.category) ?? new Map<string, number>();
    const row: PublicMonthlyShareTableRow = {
      category: category.category,
      accessLevel: category.accessLevel,
      monthAmounts: monthAmountsByCategory.get(category.category) ?? new Map<string, number>(),
      yearTotals,
      visibleYearTotal: sumVisibleYearTotals(yearTotals, visibleYears),
    };

    if (category.accessLevel === "monthly_values") {
      monthlyValueRows.push(row);
    } else {
      categoryOnlyRows.push(row);
    }
  }

  return {
    months,
    columns,
    rows: [
      ...monthlyValueRows.sort((left, right) =>
        right.visibleYearTotal - left.visibleYearTotal || left.category.localeCompare(right.category)),
      ...categoryOnlyRows,
    ],
    hasSelectedCategories: share.categories.length > 0,
  };
};

export const resolvePublicMonthlyShareLabel = (
  label: string,
  anonymousLabel: string,
): string =>
  label.trim() === "" ? anonymousLabel : label;
