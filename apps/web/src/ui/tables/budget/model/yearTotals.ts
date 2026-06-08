import { getYearMonths } from "@/lib/monthUtils";
import type { BudgetRow, BusinessPersonalTransferCell, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { computeCumulativeBalances, computeCumulativeBalancesByLiquidity, computeFxAdjustments } from "@/ui/tables/budget/model/balances";
import type { CumulativeBalance } from "@/ui/tables/budget/model/balances";
import { buildBlocks, computeAllowedSubtotals } from "@/ui/tables/budget/model/blocks";
import { lookupCell, sumCellValuesOverMonths, zeroCellValue } from "@/ui/tables/budget/model/cells";
import type { CellValue } from "@/ui/tables/budget/model/cells";

/**
 * Result of fetching a full year's budget data from the server.
 */
export type YearFetchResult = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
}>;

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
  businessPersonalTransfer: BusinessPersonalTransferCell;
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
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>,
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

  let businessPersonalTransferActual = 0;
  let businessPersonalTransferHasUnconvertible = false;
  for (const month of yearMonths) {
    const cell = businessPersonalTransfers[month];
    if (cell === undefined) {
      continue;
    }
    businessPersonalTransferActual += cell.actual;
    if (cell.hasUnconvertible) {
      businessPersonalTransferHasUnconvertible = true;
    }
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
    businessPersonalTransfer: {
      actual: businessPersonalTransferActual,
      hasUnconvertible: businessPersonalTransferHasUnconvertible,
    },
    decemberBalance,
    decemberBalancesByLiquidity,
    decemberBalancesByLiquidityPlan,
    taintedCategories,
    taintedDirections,
    anyTainted,
  };
};
