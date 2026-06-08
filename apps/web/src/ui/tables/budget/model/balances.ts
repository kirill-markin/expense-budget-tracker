import { offsetMonth } from "@/lib/monthUtils";
import type { BudgetRow, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { zeroCellValue } from "@/ui/tables/budget/model/cells";
import type { CellValue } from "@/ui/tables/budget/model/cells";

export const LIQUIDITY_ORDER: ReadonlyArray<string> = ["high", "medium", "low"];
export const LIQUIDITY_LABELS: Readonly<Record<string, string>> = { high: "Balance (high)", medium: "Balance (medium)", low: "Balance (low)" };

export type CumulativeBalance = Readonly<{
  plan: number;
  actual: number;
  isTainted: boolean;
}>;

export type BudgetTaintedState = Readonly<{
  taintedCells: ReadonlySet<string>;
  taintedDirectionMonths: ReadonlySet<string>;
  taintedMonths: ReadonlySet<string>;
}>;

export const buildBudgetTaintedState = (
  rows: ReadonlyArray<BudgetRow>,
): BudgetTaintedState => {
  const taintedCells = new Set<string>();
  const taintedDirectionMonths = new Set<string>();
  const taintedMonths = new Set<string>();

  for (const row of rows) {
    if (!row.hasUnconvertible) {
      continue;
    }

    taintedCells.add(`${row.direction}::${row.month}::${row.category}`);
    taintedDirectionMonths.add(`${row.direction}::${row.month}`);
    taintedMonths.add(row.month);
  }

  return {
    taintedCells,
    taintedDirectionMonths,
    taintedMonths,
  };
};

export const adjustCumulativeBeforeForPrependedRows = (
  cumulativeBefore: CumulativeBefore,
  prependedRows: ReadonlyArray<BudgetRow>,
): CumulativeBefore => {
  let incomeDelta = 0;
  let spendDelta = 0;
  let transferDelta = 0;

  for (const row of prependedRows) {
    if (row.direction === "income") {
      incomeDelta += row.actual;
    } else if (row.direction === "spend") {
      spendDelta += row.actual;
    } else if (row.direction === "transfer") {
      transferDelta += row.actual;
    }
  }

  return {
    incomeActual: cumulativeBefore.incomeActual - incomeDelta,
    spendActual: cumulativeBefore.spendActual - spendDelta,
    transferActual: cumulativeBefore.transferActual - transferDelta,
  };
};

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
  // cumBefore covers months strictly before the loaded range - always past, so use actual.
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
        // No actual data - route budget delta to "high".
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
