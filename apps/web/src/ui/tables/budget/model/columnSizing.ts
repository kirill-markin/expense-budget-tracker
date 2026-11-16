import { getYear } from "@/lib/monthUtils";
import { isCategoryVisible } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import type { BusinessPersonalTransferCell } from "@/server/budget/getBudgetGrid";
import { formatFxAmount } from "@/ui/tables/fx/format";
import type { CumulativeBalance } from "./balances";
import type { DirectionBlock } from "./blocks";
import { formatAmount, formatSignedAmount, lookupCell, zeroCellValue, type CellValue } from "./cells";
import { buildBudgetValueColumns, isBudgetMonthLoaded, type ColumnEntry, type BudgetValueColumn } from "./dateRanges";
import { isSplitBudgetMonth, isSplitBudgetYear, type BudgetPlansMode } from "./plansMode";
import type { YearTotalComputed } from "./yearTotals";

export type BudgetColumnSizingData = Readonly<{
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  blocks: ReadonlyArray<Readonly<{ block: DirectionBlock; directionCategories: ReadonlyArray<string> }>>;
  effectiveAllowlist: ReadonlySet<string> | null;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined;
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined;
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  fxAdjustments: ReadonlyMap<string, number>;
  hasBusinessAccount: boolean;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasLiquidityBreakdown: boolean;
  liquidityTiers: ReadonlyArray<string>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
}>;

export type BudgetColumnContent = BudgetValueColumn & Readonly<{
  characters: number;
  adjustedCharacters: number;
  headerCharacters: number;
  headerSpan: number;
}>;

type BudgetColumnLabels = Readonly<{ plan: string; actual: string; total: string }>;

/** Monospace content lengths, using exactly the formatters and visible data of the cells. */
export const buildBudgetColumnContent = (
  data: BudgetColumnSizingData,
  numberFormat: NumberFormat,
  labels: BudgetColumnLabels,
): ReadonlyArray<BudgetColumnContent> => {
  const currentYear = getYear(data.currentMonth);
  const valueColumns = buildBudgetValueColumns(data.columnSequence, data.currentMonth, data.plansMode);
  let valueIndex = 0;
  return data.columnSequence.flatMap((entry): ReadonlyArray<BudgetColumnContent> => {
    const isYear = entry.kind === "year-total";
    const period = isYear ? entry.year : entry.month;
    const split = isYear
      ? isSplitBudgetYear(period, currentYear, data.plansMode)
      : isSplitBudgetMonth(period, data.currentMonth, data.plansMode);
    const parts: ReadonlyArray<"plan" | "actual"> = split ? ["plan", "actual"]
      : [period < (isYear ? currentYear : data.currentMonth) ? "actual" : "plan"];
    return parts.map((part): BudgetColumnContent => {
      const column = valueColumns[valueIndex++];
      const field = part === "plan" ? "planned" : "actual";
      let characters = labels[part].length;
      let adjustedCharacters = 0;
      const include = (value: number, formatter: typeof formatAmount = formatAmount, adjusted: boolean = false): void => {
        const length = formatter(value, numberFormat).length;
        if (adjusted) adjustedCharacters = Math.max(adjustedCharacters, length);
        else characters = Math.max(characters, length);
      };
      // Both masked and unloaded cells use one character (0 or an ellipsis).
      characters = Math.max(characters, 1);
      const year = isYear ? data.yearComputed.get(period) : undefined;
      const loaded = isYear ? year !== undefined : isBudgetMonthLoaded(period, data.loadedFrom, data.loadedTo);
      if (loaded) {
        for (const { block, directionCategories } of data.blocks) {
          const subtotal = isYear
            ? (data.effectiveAllowlist === null ? year!.directionSubtotals : year!.filteredSubtotals).get(block.direction)
            : (data.effectiveAllowlist === null ? block.subtotals : data.filteredSubtotalsMap.get(block.direction))?.get(period);
          include((subtotal ?? zeroCellValue)[field]);
          for (const category of block.categories) {
            if ((category === "" && directionCategories.length <= 1)
              || !isCategoryVisible(data.effectiveAllowlist, category)) continue;
            const cell = isYear
              ? year!.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue
              : lookupCell(block.cells, period, category);
            include(cell[field], formatAmount, !isYear && part === "plan" && cell.plannedModifier !== 0);
          }
        }
        // Aggregate and liquidity rows are masked when an allowlist is active.
        if (data.effectiveAllowlist === null) {
          if (isYear) {
            include(year!.remainder[field], formatSignedAmount);
            include(year!.decemberBalance[part]);
            if (part === "actual") {
              include(year!.yearFxAdjust, formatFxAmount);
              if (data.hasBusinessAccount) include(year!.businessPersonalTransfer.actual);
            }
            if (data.hasLiquidityBreakdown) {
              const balances = part === "plan" ? year!.decemberBalancesByLiquidityPlan : year!.decemberBalancesByLiquidity;
              for (const tier of data.liquidityTiers) include(balances[tier] ?? 0);
            }
          } else {
            const income = data.incomeSubtotals?.get(period) ?? zeroCellValue;
            const spend = data.spendSubtotals?.get(period) ?? zeroCellValue;
            const transfer = data.transferSubtotals?.get(period) ?? zeroCellValue;
            include(income[field] - spend[field] + transfer[field], formatSignedAmount);
            const balance = data.cumulativeBalances.get(period);
            if (balance === undefined) throw new RangeError(`Loaded budget month "${period}" is missing its cumulative balance`);
            include(balance[part]);
            if (part === "actual") {
              include(data.fxAdjustments.get(period) ?? 0, formatFxAmount);
              if (data.hasBusinessAccount) include(data.businessPersonalTransfers[period]?.actual ?? 0);
            }
            if (data.hasLiquidityBreakdown) {
              const balances = part === "plan" ? data.projectedLiqBalances.get(period) : data.mebByLiq[period];
              for (const tier of data.liquidityTiers) include(balances?.[tier] ?? 0);
            }
          }
        }
      }
      return {
        ...column,
        characters,
        adjustedCharacters,
        headerCharacters: (isYear ? `${labels.total} ${period}` : period).length,
        headerSpan: parts.length,
      };
    });
  });
};

/** All lengths resolve in CSS, including responsive padding and the fixed CSS triangle. */
export const getBudgetColumnInlineSize = (column: BudgetColumnContent): string => {
  const minimum = column.isYearTotal ? "--budget-year-column-width" : "--budget-value-column-width";
  const border = column.isYearTotal ? "2px" : column.startsMonthDivider ? "1px" : "0px";
  const padding = column.isYearTotal && column.headerSpan === 1
    ? "--budget-single-year-header-padding" : "--budget-cell-padding";
  const content = `calc(${column.characters}ch + 2 * var(--budget-cell-padding) + ${border})`;
  const adjusted = `calc(${column.adjustedCharacters}ch + var(--budget-modifier-inline-size) + var(--budget-modifier-gap) + 2 * var(--budget-cell-padding) + ${border})`;
  const header = `calc((${column.headerCharacters}ch + 2 * var(${padding}) + ${border}) / ${column.headerSpan})`;
  return `max(var(${minimum}), ${content}, ${adjusted}, ${header})`;
};

/** Group repeated widths so the fixed calendar stays within CSS math-expression limits. */
export const getBudgetValuesInlineSize = (inlineSizes: ReadonlyArray<string>): string => {
  const counts = new Map<string, number>();
  for (const size of inlineSizes) counts.set(size, (counts.get(size) ?? 0) + 1);
  const sum = [...counts].reduce(
    (expression: string, [size, count]): string => `${expression} + ${count} * ${size}`,
    "0px",
  );
  return `calc(${sum})`;
};
