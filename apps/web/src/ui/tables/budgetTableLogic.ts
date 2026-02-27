import { offsetMonth, getYear, getYearMonths } from "@/lib/monthUtils";
import type { BudgetRow, CumulativeBefore } from "@/server/budget/getBudgetGrid";

export type CellValue = Readonly<{
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  actual: number;
}>;

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

export const LIQUIDITY_ORDER: ReadonlyArray<string> = ["high", "medium", "low"];
export const LIQUIDITY_LABELS: Readonly<Record<string, string>> = { high: "Balance (high)", medium: "Balance (medium)", low: "Balance (low)" };

export const cellKey = (month: string, category: string): string => `${month}::${category}`;

export const zeroCellValue: CellValue = { plannedBase: 0, plannedModifier: 0, planned: 0, actual: 0 };

export const lookupCell = (cells: ReadonlyMap<string, CellValue>, month: string, category: string): CellValue => {
  return cells.get(cellKey(month, category)) ?? zeroCellValue;
};

export const formatAmount = (value: number): string => {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return rounded.toLocaleString("en-US");
};

/**
 * Formats an FX adjustment for display.
 * Negates the internal value so that visually:
 *   positive display = book overestimated (FX loss, shown red)
 *   negative display = book underestimated (FX gain)
 * Always shows an explicit +/- prefix.
 */
export const formatFxAmount = (value: number): string => {
  const display = Math.round(-value);
  if (display === 0) return "0";
  const prefix = display > 0 ? "+" : "";
  return prefix + display.toLocaleString("en-US");
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
 * When maskedCategories is non-empty, visible categories come first,
 * then masked ones — each group sorted by effective value independently.
 * Stable sort preserves relative order for equal values.
 */
export const sortCategoriesByEffectiveValue = (
  categories: ReadonlyArray<string>,
  cells: ReadonlyMap<string, CellValue>,
  currentYearMonths: ReadonlyArray<string>,
  currentMonth: string,
  maskedCategories: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const withValues = [...categories].map((category) => ({
    category,
    value: computeEffectiveValue(cells, category, currentYearMonths, currentMonth),
    isMasked: maskedCategories.has(category),
  }));
  withValues.sort((a, b) => {
    if (a.isMasked !== b.isMasked) return a.isMasked ? 1 : -1;
    return b.value - a.value;
  });
  return withValues.map((entry) => entry.category);
};

/**
 * Groups budget rows into DirectionBlocks with per-month subtotals.
 * Categories are sorted by effective value for the current year (descending):
 * past months use actual, current and future months use planned.
 * When an allowlist is active, visible (allowed) categories
 * are sorted first, then masked ones — each group by effective value.
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

export type CumulativeBalance = Readonly<{
  plan: number;
  actual: number;
  isTainted: boolean;
}>;

/**
 * Pre-computes cumulative balance for each month.
 * Used by the Balance row and year-total Balance cells (which show December's value).
 *
 * When monthEndBalances are available (mark-to-market portfolio values at month-end
 * exchange rates), they override the budget-computed cumulative for past/current months.
 * This anchors the Balance row to the real portfolio value instead of historical-rate
 * bookkeeping.
 *
 * Past months: both plan and actual use monthEndBalance (actual portfolio value).
 * Current month: actual uses monthEndBalance, plan uses planned delta from previous
 *   month's monthEndBalance.
 * Future months: plan column only, projected from the last known monthEndBalance.
 *
 * Falls back to budget-computed cumulative when monthEndBalances are empty.
 * Transfer actuals are always included (transfers have no planned values).
 */
export const computeCumulativeBalances = (
  months: ReadonlyArray<string>,
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined,
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined,
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined,
  cumBefore: CumulativeBefore,
  taintedMonthSet: ReadonlySet<string>,
  currentMonth: string,
  monthEndBalances: Readonly<Record<string, number>>,
): ReadonlyMap<string, CumulativeBalance> => {
  const result = new Map<string, CumulativeBalance>();
  // cumBefore covers months strictly before the loaded range — always past, so use actual.
  const actualBefore = cumBefore.incomeActual - cumBefore.spendActual + cumBefore.transferActual;
  // If we have a month-end balance for the month before the range, use it as the
  // starting point. This anchors the cumulative to the real portfolio value.
  const monthBeforeRange = months.length > 0 ? offsetMonth(months[0], -1) : "";
  let cumulativePlan = monthBeforeRange in monthEndBalances ? monthEndBalances[monthBeforeRange] : actualBefore;
  let cumulativeActual = cumulativePlan;
  let taintedSoFar = false;
  for (const month of months) {
    const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
    const spd = spendSubtotals?.get(month) ?? zeroCellValue;
    const txf = transferSubtotals?.get(month) ?? zeroCellValue;
    if (month < currentMonth) {
      // Past month: use real portfolio value if available.
      if (month in monthEndBalances) {
        cumulativePlan = monthEndBalances[month];
        cumulativeActual = monthEndBalances[month];
      } else {
        const actualDelta = inc.actual - spd.actual + txf.actual;
        cumulativePlan += actualDelta;
        cumulativeActual += actualDelta;
      }
    } else if (month === currentMonth) {
      // Current month: actual uses real portfolio value, plan uses planned delta.
      cumulativePlan += inc.planned - spd.planned + txf.actual;
      if (month in monthEndBalances) {
        cumulativeActual = monthEndBalances[month];
      } else {
        cumulativeActual += inc.actual - spd.actual + txf.actual;
      }
    } else {
      // Future month: only plan column shown, use planned.
      // Transfers have no plan, so use actual (typically 0 for future).
      cumulativePlan += inc.planned - spd.planned + txf.actual;
      cumulativeActual += inc.planned - spd.planned + txf.actual;
    }
    if (taintedMonthSet.has(month)) taintedSoFar = true;
    result.set(month, { plan: cumulativePlan, actual: cumulativeActual, isTainted: taintedSoFar });
  }
  return result;
};

/**
 * Projects cumulative balance per liquidity tier for each month.
 * Past months: use actual monthEndBalancesByLiquidity when available.
 * Current & future months: route the planned budget delta entirely to "high";
 * "medium" and "low" stay frozen at their last known actual values.
 */
export const computeCumulativeBalancesByLiquidity = (
  months: ReadonlyArray<string>,
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined,
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined,
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined,
  currentMonth: string,
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>,
): ReadonlyMap<string, Readonly<Record<string, number>>> => {
  const result = new Map<string, Readonly<Record<string, number>>>();
  const running: Record<string, number> = {};

  // Seed from the month before the range if available.
  if (months.length > 0) {
    const monthBeforeRange = offsetMonth(months[0], -1);
    const seed = monthEndBalancesByLiquidity[monthBeforeRange];
    if (seed !== undefined) {
      for (const [tier, val] of Object.entries(seed)) {
        running[tier] = val;
      }
    }
  }

  for (const month of months) {
    if (month < currentMonth) {
      // Past month: replace running state with actual data.
      const actual = monthEndBalancesByLiquidity[month];
      if (actual !== undefined) {
        for (const key of Object.keys(running)) {
          if (!(key in actual)) running[key] = 0;
        }
        for (const [tier, val] of Object.entries(actual)) {
          running[tier] = val;
        }
      } else {
        // No actual data — route budget delta to "high".
        const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
        const spd = spendSubtotals?.get(month) ?? zeroCellValue;
        const txf = transferSubtotals?.get(month) ?? zeroCellValue;
        const delta = inc.actual - spd.actual + txf.actual;
        running["high"] = (running["high"] ?? 0) + delta;
      }
    } else if (month === currentMonth) {
      const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
      const spd = spendSubtotals?.get(month) ?? zeroCellValue;
      const txf = transferSubtotals?.get(month) ?? zeroCellValue;
      const delta = inc.planned - spd.planned + txf.actual;
      running["high"] = (running["high"] ?? 0) + delta;
    } else {
      // Future month: delta goes to "high", medium/low frozen.
      const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
      const spd = spendSubtotals?.get(month) ?? zeroCellValue;
      const txf = transferSubtotals?.get(month) ?? zeroCellValue;
      const delta = inc.planned - spd.planned + txf.actual;
      running["high"] = (running["high"] ?? 0) + delta;
    }
    result.set(month, { ...running });
  }
  return result;
};

/**
 * Computes the per-month FX adjustment: the difference between the actual
 * portfolio value change and the budget-computed change for that month.
 *
 * fxAdjust(M) = monthEndBalance(M) - monthEndBalance(M-1) - budgetDelta(M)
 *
 * Only computed for past/current months where both month-end balances exist.
 * Returns undefined for months without data (future months, missing rates).
 */
export const computeFxAdjustments = (
  months: ReadonlyArray<string>,
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined,
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined,
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined,
  monthEndBalances: Readonly<Record<string, number>>,
  currentMonth: string,
): ReadonlyMap<string, number> => {
  const result = new Map<string, number>();
  for (const month of months) {
    if (month > currentMonth) continue;
    if (!(month in monthEndBalances)) continue;
    const prevMonth = offsetMonth(month, -1);
    if (!(prevMonth in monthEndBalances)) continue;
    const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
    const spd = spendSubtotals?.get(month) ?? zeroCellValue;
    const txf = transferSubtotals?.get(month) ?? zeroCellValue;
    const budgetDelta = inc.actual - spd.actual + txf.actual;
    result.set(month, monthEndBalances[month] - monthEndBalances[prevMonth] - budgetDelta);
  }
  return result;
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

/**
 * Result of fetching a full year's budget data from the server.
 */
export type YearFetchResult = Readonly<{ rows: ReadonlyArray<BudgetRow>; cumulativeBefore: CumulativeBefore; monthEndBalances: Readonly<Record<string, number>>; monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>> }>;

/**
 * Pre-computed yearly totals fetched from the server.
 * All fields are derived from the full 12-month year data (Jan-Dec),
 * independent of the horizontally-scrolled loaded range.
 */
export type YearTotalComputed = Readonly<{
  directionCategoryTotals: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  directionSubtotals: ReadonlyMap<string, CellValue>;
  filteredSubtotals: ReadonlyMap<string, CellValue>;
  remainder: CellValue;
  /** Sum of per-month FX adjustments for all months in this year. */
  yearFxAdjust: number;
  decemberBalance: CumulativeBalance;
  /** December balance per liquidity tier (actual), for year-total column. */
  decemberBalancesByLiquidity: Readonly<Record<string, number>>;
  /** December balance per liquidity tier (projected plan), for year-total column. */
  decemberBalancesByLiquidityPlan: Readonly<Record<string, number>>;
  taintedCategories: ReadonlySet<string>;
  taintedDirections: ReadonlySet<string>;
  anyTainted: boolean;
}>;

/**
 * Computes all yearly totals from a full year of BudgetRows fetched from the server.
 * Returns pre-aggregated data for every year-total cell in the table:
 * direction subtotals, per-category totals, remainder, cumulative balance at December,
 * and tainted status.
 */
export const computeYearTotal = (
  rows: ReadonlyArray<BudgetRow>,
  cumulativeBefore: CumulativeBefore,
  monthEndBalances: Readonly<Record<string, number>>,
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>,
  year: string,
  currentMonth: string,
  allowlist: ReadonlySet<string> | null,
): YearTotalComputed => {
  const yearMonths = getYearMonths(year);
  const blocks = buildBlocks(rows, yearMonths, currentMonth, allowlist);

  const directionSubtotals = new Map<string, CellValue>();
  const directionCategoryTotals = new Map<string, ReadonlyMap<string, CellValue>>();

  for (const block of blocks) {
    directionSubtotals.set(
      block.direction,
      sumCellValuesOverMonths(yearMonths, (m) => block.subtotals.get(m) ?? zeroCellValue),
    );
    const catTotals = new Map<string, CellValue>();
    for (const cat of block.categories) {
      catTotals.set(cat, sumCellValuesOverMonths(yearMonths, (m) => lookupCell(block.cells, m, cat)));
    }
    directionCategoryTotals.set(block.direction, catTotals);
  }

  const filteredSubtotals = new Map<string, CellValue>();
  if (allowlist !== null) {
    for (const block of blocks) {
      const filtered = computeAllowedSubtotals(block, yearMonths, allowlist);
      filteredSubtotals.set(
        block.direction,
        sumCellValuesOverMonths(yearMonths, (m) => filtered.get(m) ?? zeroCellValue),
      );
    }
  }

  const incSub = directionSubtotals.get("income") ?? zeroCellValue;
  const spdSub = directionSubtotals.get("spend") ?? zeroCellValue;
  const txfSub = directionSubtotals.get("transfer") ?? zeroCellValue;
  const remainder: CellValue = {
    plannedBase: incSub.plannedBase - spdSub.plannedBase + txfSub.plannedBase,
    plannedModifier: incSub.plannedModifier - spdSub.plannedModifier + txfSub.plannedModifier,
    planned: incSub.planned - spdSub.planned + txfSub.planned,
    actual: incSub.actual - spdSub.actual + txfSub.actual,
  };

  const taintedCategories = new Set<string>();
  const taintedDirections = new Set<string>();
  const taintedMonthSet = new Set<string>();
  let anyTainted = false;
  for (const row of rows) {
    if (row.hasUnconvertible) {
      taintedCategories.add(`${row.direction}::${row.category}`);
      taintedDirections.add(row.direction);
      taintedMonthSet.add(row.month);
      anyTainted = true;
    }
  }

  const inc = blocks.find((b) => b.direction === "income")?.subtotals;
  const spd = blocks.find((b) => b.direction === "spend")?.subtotals;
  const txf = blocks.find((b) => b.direction === "transfer")?.subtotals;
  const cumBalances = computeCumulativeBalances(yearMonths, inc, spd, txf, cumulativeBefore, taintedMonthSet, currentMonth, monthEndBalances);
  const decemberBalance = cumBalances.get(`${year}-12`) ?? { plan: 0, actual: 0, isTainted: anyTainted };

  const yearFxMap = computeFxAdjustments(yearMonths, inc, spd, txf, monthEndBalances, currentMonth);
  let yearFxAdjust = 0;
  for (const val of yearFxMap.values()) {
    yearFxAdjust += val;
  }

  const decemberBalancesByLiquidity = monthEndBalancesByLiquidity[`${year}-12`] ?? {};

  const projectedLiqMap = computeCumulativeBalancesByLiquidity(yearMonths, inc, spd, txf, currentMonth, monthEndBalancesByLiquidity);
  const decemberBalancesByLiquidityPlan = projectedLiqMap.get(`${year}-12`) ?? {};

  return {
    directionCategoryTotals,
    directionSubtotals,
    filteredSubtotals,
    remainder,
    yearFxAdjust,
    decemberBalance,
    decemberBalancesByLiquidity,
    decemberBalancesByLiquidityPlan,
    taintedCategories,
    taintedDirections,
    anyTainted,
  };
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
