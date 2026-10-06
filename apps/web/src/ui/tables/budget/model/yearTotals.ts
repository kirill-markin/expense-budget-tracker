import { getYear, getYearMonths } from "@/lib/monthUtils";
import type { BudgetRow, BusinessPersonalTransferCell, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { computeCumulativeBalances, computeCumulativeBalancesByLiquidity, computeFxAdjustments } from "@/ui/tables/budget/model/balances";
import type { CumulativeBalance } from "@/ui/tables/budget/model/balances";
import { buildBlocks, computeAllowedSubtotals } from "@/ui/tables/budget/model/blocks";
import { lookupCell, sumCellValuesOverMonths, zeroCellValue } from "@/ui/tables/budget/model/cells";
import type { CellValue } from "@/ui/tables/budget/model/cells";
import type { BudgetPlansMode } from "@/ui/tables/budget/model/plansMode";

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
  /**
   * True when this year's Plan column embeds actuals, so an unconvertible
   * actual taints the plan side as well. Plans themselves never pass through
   * an exchange rate; only this mixed-in actual can make them incomplete.
   */
  planEmbedsActuals: boolean;
  /** Unconvertible currencies of this year keyed by `direction`, sorted. */
  unconvertibleCurrenciesByDirection: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Unconvertible currencies of this year keyed by `direction::category`, sorted. */
  unconvertibleCurrenciesByCategory: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * Union over the whole year, sorted, for year-wide cells. December's
   * cumulative balance covers every month of the year, so it reads the same list.
   */
  unconvertibleCurrencies: ReadonlyArray<string>;
}>;

/**
 * In "actuals" mode the current year's plan reports what the year is actually
 * expected to end at: the elapsed months contribute their actual, which is an
 * FX-converted value. Every other year and mode keeps a pure plan.
 */
const doesYearPlanEmbedActuals = (
  year: string,
  currentMonth: string,
  plansMode: BudgetPlansMode,
): boolean => plansMode === "actuals" && year === getYear(currentMonth);

/**
 * Sums a year of cells for the year-total column.
 *
 * In "actuals" mode the current year's plan reports what the year is actually
 * expected to end at: the elapsed months contribute their actual. In
 * "all-plans" mode every year's plan is the pure sum of the twelve monthly
 * plans, which is the number the per-month Plan columns add up to.
 */
const sumCellValuesForYear = (
  months: ReadonlyArray<string>,
  getValue: (month: string) => CellValue,
  year: string,
  currentMonth: string,
  plansMode: BudgetPlansMode,
): CellValue => {
  const total = sumCellValuesOverMonths(months, getValue);
  if (!doesYearPlanEmbedActuals(year, currentMonth, plansMode)) {
    return total;
  }

  let planned = 0;
  for (const month of months) {
    const cell = getValue(month);
    planned += month < currentMonth ? cell.actual : cell.planned;
  }
  return { ...total, planned };
};

const collectCurrencies = (
  target: Map<string, Set<string>>,
  key: string,
  currencies: ReadonlyArray<string>,
): void => {
  const collected = target.get(key);
  if (collected === undefined) {
    target.set(key, new Set(currencies));
    return;
  }
  for (const currency of currencies) {
    collected.add(currency);
  }
};

const toSortedCurrencyLists = (
  source: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const sorted = new Map<string, ReadonlyArray<string>>();
  for (const [key, currencies] of source) {
    sorted.set(key, [...currencies].sort());
  }
  return sorted;
};

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
  plansMode: BudgetPlansMode,
): YearTotalComputed => {
  const yearMonths = getYearMonths(year);
  const blocks = buildBlocks(rows, yearMonths, currentMonth, allowlist);

  const directionSubtotals = new Map<string, CellValue>();
  const directionCategoryTotals = new Map<string, ReadonlyMap<string, CellValue>>();

  for (const block of blocks) {
    directionSubtotals.set(
      block.direction,
      sumCellValuesForYear(yearMonths, (m) => block.subtotals.get(m) ?? zeroCellValue, year, currentMonth, plansMode),
    );
    const catTotals = new Map<string, CellValue>();
    for (const cat of block.categories) {
      catTotals.set(cat, sumCellValuesForYear(yearMonths, (m) => lookupCell(block.cells, m, cat), year, currentMonth, plansMode));
    }
    directionCategoryTotals.set(block.direction, catTotals);
  }

  const filteredSubtotals = new Map<string, CellValue>();
  if (allowlist !== null) {
    for (const block of blocks) {
      const filtered = computeAllowedSubtotals(block, yearMonths, allowlist);
      filteredSubtotals.set(
        block.direction,
        sumCellValuesForYear(yearMonths, (m) => filtered.get(m) ?? zeroCellValue, year, currentMonth, plansMode),
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
  const currenciesByDirection = new Map<string, Set<string>>();
  const currenciesByCategory = new Map<string, Set<string>>();
  const yearCurrencies = new Set<string>();
  let anyTainted = false;
  for (const row of rows) {
    if (row.hasUnconvertible) {
      const categoryKey = `${row.direction}::${row.category}`;
      taintedCategories.add(categoryKey);
      taintedDirections.add(row.direction);
      taintedMonthSet.add(row.month);
      collectCurrencies(currenciesByDirection, row.direction, row.unconvertibleCurrencies);
      collectCurrencies(currenciesByCategory, categoryKey, row.unconvertibleCurrencies);
      for (const currency of row.unconvertibleCurrencies) {
        yearCurrencies.add(currency);
      }
      anyTainted = true;
    }
  }

  const inc = blocks.find((b) => b.direction === "income")?.subtotals;
  const spd = blocks.find((b) => b.direction === "spend")?.subtotals;
  const txf = blocks.find((b) => b.direction === "transfer")?.subtotals;
  const cumBalances = computeCumulativeBalances(yearMonths, inc, spd, txf, cumulativeBefore, taintedMonthSet, currentMonth, monthEndBalances, plansMode);
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

  const projectedLiqMap = computeCumulativeBalancesByLiquidity(yearMonths, inc, spd, txf, currentMonth, monthEndBalancesByLiquidity, plansMode);
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
    planEmbedsActuals: doesYearPlanEmbedActuals(year, currentMonth, plansMode),
    unconvertibleCurrenciesByDirection: toSortedCurrencyLists(currenciesByDirection),
    unconvertibleCurrenciesByCategory: toSortedCurrencyLists(currenciesByCategory),
    unconvertibleCurrencies: [...yearCurrencies].sort(),
  };
};
