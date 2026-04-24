"use client";

import { useMemo } from "react";
import type { BudgetRow, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import type {
  CellValue,
  ColumnEntry,
  CumulativeBalance,
  DirectionBlock,
} from "@/ui/tables/budget/budgetTableLogic";
import {
  LIQUIDITY_ORDER,
  buildBlocks,
  buildBudgetTaintedState,
  buildColumnSequence,
  computeAllowedSubtotals,
  computeCumulativeBalances,
  computeCumulativeBalancesByLiquidity,
  computeFxAdjustments,
} from "@/ui/tables/budget/budgetTableLogic";
import { generateMonthRange } from "@/lib/monthUtils";

export type BudgetTableDerivedState = Readonly<{
  months: ReadonlyArray<string>;
  blocks: ReadonlyArray<DirectionBlock>;
  columnSequence: ReadonlyArray<ColumnEntry>;
  allCategories: ReadonlyArray<string>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined;
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined;
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined;
  taintedCells: ReadonlySet<string>;
  taintedDirectionMonths: ReadonlySet<string>;
  taintedMonths: ReadonlySet<string>;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  fxAdjustments: ReadonlyMap<string, number>;
  liquidityTiers: ReadonlyArray<string>;
  hasLiquidityBreakdown: boolean;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
}>;

type UseBudgetTableDerivedStateParams = Readonly<{
  allRows: ReadonlyArray<BudgetRow>;
  loadedFrom: string;
  loadedTo: string;
  cumBefore: CumulativeBefore;
  meb: Readonly<Record<string, number>>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  currentMonth: string;
  effectiveAllowlist: ReadonlySet<string> | null;
}>;

export const useBudgetTableDerivedState = ({
  allRows,
  loadedFrom,
  loadedTo,
  cumBefore,
  meb,
  mebByLiq,
  currentMonth,
  effectiveAllowlist,
}: UseBudgetTableDerivedStateParams): BudgetTableDerivedState => {
  const months = useMemo<ReadonlyArray<string>>(
    () => generateMonthRange(loadedFrom, loadedTo),
    [loadedFrom, loadedTo],
  );

  const blocks = useMemo<ReadonlyArray<DirectionBlock>>(
    () => buildBlocks(allRows, months, currentMonth, effectiveAllowlist),
    [allRows, months, currentMonth, effectiveAllowlist],
  );

  const columnSequence = useMemo<ReadonlyArray<ColumnEntry>>(
    () => buildColumnSequence(months),
    [months],
  );

  const allCategories = useMemo<ReadonlyArray<string>>(() => {
    const categories = new Set<string>();
    for (const block of blocks) {
      for (const category of block.categories) {
        categories.add(category);
      }
    }
    return [...categories].sort();
  }, [blocks]);

  const filteredSubtotalsMap = useMemo<ReadonlyMap<string, ReadonlyMap<string, CellValue>>>(() => {
    if (effectiveAllowlist === null) {
      return new Map();
    }

    const result = new Map<string, ReadonlyMap<string, CellValue>>();
    for (const block of blocks) {
      result.set(block.direction, computeAllowedSubtotals(block, months, effectiveAllowlist));
    }
    return result;
  }, [blocks, months, effectiveAllowlist]);

  const incomeSubtotals = blocks.find((block) => block.direction === "income")?.subtotals;
  const spendSubtotals = blocks.find((block) => block.direction === "spend")?.subtotals;
  const transferSubtotals = blocks.find((block) => block.direction === "transfer")?.subtotals;

  const taintedState = useMemo(() => buildBudgetTaintedState(allRows), [allRows]);
  const { taintedCells, taintedDirectionMonths, taintedMonths } = taintedState;

  const cumulativeBalances = useMemo<ReadonlyMap<string, CumulativeBalance>>(
    () =>
      computeCumulativeBalances(
        months,
        incomeSubtotals,
        spendSubtotals,
        transferSubtotals,
        cumBefore,
        taintedMonths,
        currentMonth,
        meb,
      ),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, cumBefore, taintedMonths, currentMonth, meb],
  );

  const fxAdjustments = useMemo<ReadonlyMap<string, number>>(
    () => computeFxAdjustments(months, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth],
  );

  const liquidityTiers = useMemo<ReadonlyArray<string>>(() => {
    const tiers = new Set<string>();
    for (const liquidityMap of Object.values(mebByLiq)) {
      for (const [liquidity, value] of Object.entries(liquidityMap)) {
        if (value !== 0) {
          tiers.add(liquidity);
        }
      }
    }
    return LIQUIDITY_ORDER.filter((liquidity) => tiers.has(liquidity));
  }, [mebByLiq]);

  const hasLiquidityBreakdown = useMemo<boolean>(
    () => liquidityTiers.length > 1 || (liquidityTiers.length === 1 && liquidityTiers[0] !== "high"),
    [liquidityTiers],
  );

  const projectedLiqBalances = useMemo<ReadonlyMap<string, Readonly<Record<string, number>>>>(
    () =>
      computeCumulativeBalancesByLiquidity(
        months,
        incomeSubtotals,
        spendSubtotals,
        transferSubtotals,
        currentMonth,
        mebByLiq,
      ),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, currentMonth, mebByLiq],
  );

  return {
    months,
    blocks,
    columnSequence,
    allCategories,
    filteredSubtotalsMap,
    incomeSubtotals,
    spendSubtotals,
    transferSubtotals,
    taintedCells,
    taintedDirectionMonths,
    taintedMonths,
    cumulativeBalances,
    fxAdjustments,
    liquidityTiers,
    hasLiquidityBreakdown,
    projectedLiqBalances,
  };
};
