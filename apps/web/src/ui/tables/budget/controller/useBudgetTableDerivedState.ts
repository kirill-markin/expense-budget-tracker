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
import type { BudgetAdjustmentEditorRow } from "@/ui/tables/budget/budgetAdjustmentRowsState";
import { generateMonthRange } from "@/lib/monthUtils";

/** Identity of a budget category inside one direction block. */
export const getBudgetCategoryKey = (direction: string, category: string): string =>
  `${direction}\u0000${category}`;

const carriesValue = (row: BudgetRow): boolean =>
  row.hasActualRows
  || row.plannedBase !== 0
  || row.plannedModifier !== 0
  || row.actual !== 0;

/**
 * Categories that must stay on screen across the whole loaded range: those with
 * ledger facts or any non-zero amount, those carrying an adjustment row (even a
 * zero-amount or note-only one, so the user can still open the cell and delete
 * it), and those the user created or edited in the current session.
 * An adjustment counts under both its draft and its confirmed category, so a
 * pending category move keeps its source and its target visible.
 */
export const selectVisibleBudgetCategoryKeys = (
  rows: ReadonlyArray<BudgetRow>,
  adjustmentRows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  sessionEditedCategoryKeys: ReadonlySet<string>,
): ReadonlySet<string> => {
  const visible = new Set<string>(sessionEditedCategoryKeys);
  for (const row of rows) {
    if (!carriesValue(row)) continue;
    visible.add(getBudgetCategoryKey(row.direction, row.category));
  }
  for (const adjustment of adjustmentRows) {
    visible.add(getBudgetCategoryKey(adjustment.direction, adjustment.draft.category));
    visible.add(getBudgetCategoryKey(adjustment.direction, adjustment.confirmed.category));
  }
  return visible;
};

/**
 * The uncategorized bucket is never hidden: its plan cells are the only place
 * an amount that carries no category can be edited.
 */
const UNCATEGORIZED_CATEGORY = "";

/**
 * Drops the categories that carry nothing real from one direction block. The
 * result feeds the rendered category rows only: every category list the user
 * picks from keeps reading the unfiltered block, so hiding never removes a
 * choice. Subtotals stay untouched because a hidden category has only all-zero
 * rows across the loaded range and therefore contributes exactly zero to them.
 */
export const hideEmptyBudgetCategories = (
  block: DirectionBlock,
  visibleCategoryKeys: ReadonlySet<string>,
): DirectionBlock => ({
  ...block,
  categories: block.categories.filter((category): boolean =>
    category === UNCATEGORIZED_CATEGORY
    || visibleCategoryKeys.has(getBudgetCategoryKey(block.direction, category))),
});

/**
 * One direction section of the grid. `block` carries the category rows the grid
 * renders, already filtered, while `directionCategories` stays unfiltered so the
 * adjustment editor can still move an adjustment into a currently hidden
 * category of the same direction.
 */
export type BudgetGridSection = Readonly<{
  block: DirectionBlock;
  directionCategories: ReadonlyArray<string>;
}>;

export type BudgetTableDerivedState = Readonly<{
  months: ReadonlyArray<string>;
  blocks: ReadonlyArray<BudgetGridSection>;
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
  displayFrom: string;
  displayTo: string;
  loadedFrom: string;
  loadedTo: string;
  cumBefore: CumulativeBefore;
  meb: Readonly<Record<string, number>>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  currentMonth: string;
  effectiveAllowlist: ReadonlySet<string> | null;
  adjustmentRows: ReadonlyArray<BudgetAdjustmentEditorRow>;
  sessionEditedCategoryKeys: ReadonlySet<string>;
}>;

export const useBudgetTableDerivedState = ({
  allRows,
  displayFrom,
  displayTo,
  loadedFrom,
  loadedTo,
  cumBefore,
  meb,
  mebByLiq,
  currentMonth,
  effectiveAllowlist,
  adjustmentRows,
  sessionEditedCategoryKeys,
}: UseBudgetTableDerivedStateParams): BudgetTableDerivedState => {
  const months = useMemo<ReadonlyArray<string>>(
    () => generateMonthRange(displayFrom, displayTo),
    [displayFrom, displayTo],
  );

  const loadedMonths = useMemo<ReadonlyArray<string>>(
    () => generateMonthRange(loadedFrom, loadedTo),
    [loadedFrom, loadedTo],
  );

  const allBlocks = useMemo<ReadonlyArray<DirectionBlock>>(
    () => buildBlocks(allRows, months, currentMonth, effectiveAllowlist),
    [allRows, months, currentMonth, effectiveAllowlist],
  );

  const blocks = useMemo<ReadonlyArray<BudgetGridSection>>(() => {
    const visibleCategoryKeys = selectVisibleBudgetCategoryKeys(
      allRows,
      adjustmentRows,
      sessionEditedCategoryKeys,
    );
    return allBlocks.map((block): BudgetGridSection => ({
      block: hideEmptyBudgetCategories(block, visibleCategoryKeys),
      directionCategories: block.categories,
    }));
  }, [allBlocks, allRows, adjustmentRows, sessionEditedCategoryKeys]);

  const columnSequence = useMemo<ReadonlyArray<ColumnEntry>>(
    () => buildColumnSequence(months),
    [months],
  );

  // Built from the unfiltered blocks: this list feeds the transaction category
  // picker, which must keep offering a category the grid currently hides.
  const allCategories = useMemo<ReadonlyArray<string>>(() => {
    const categories = new Set<string>();
    for (const block of allBlocks) {
      for (const category of block.categories) {
        categories.add(category);
      }
    }
    return [...categories].sort();
  }, [allBlocks]);

  const filteredSubtotalsMap = useMemo<ReadonlyMap<string, ReadonlyMap<string, CellValue>>>(() => {
    if (effectiveAllowlist === null) {
      return new Map();
    }

    // Reads the rendered blocks, as it did before hiding existed. Passing the
    // unfiltered blocks would be numerically identical, because a hidden
    // category has only all-zero rows across the loaded range.
    const result = new Map<string, ReadonlyMap<string, CellValue>>();
    for (const section of blocks) {
      result.set(
        section.block.direction,
        computeAllowedSubtotals(section.block, months, effectiveAllowlist),
      );
    }
    return result;
  }, [blocks, months, effectiveAllowlist]);

  // Direction subtotals come from buildBlocks and never depend on which
  // category rows the grid renders.
  const incomeSubtotals = blocks.find((section) => section.block.direction === "income")?.block.subtotals;
  const spendSubtotals = blocks.find((section) => section.block.direction === "spend")?.block.subtotals;
  const transferSubtotals = blocks.find((section) => section.block.direction === "transfer")?.block.subtotals;

  const taintedState = useMemo(() => buildBudgetTaintedState(allRows), [allRows]);
  const { taintedCells, taintedDirectionMonths, taintedMonths } = taintedState;

  const cumulativeBalances = useMemo<ReadonlyMap<string, CumulativeBalance>>(
    () =>
      computeCumulativeBalances(
        loadedMonths,
        incomeSubtotals,
        spendSubtotals,
        transferSubtotals,
        cumBefore,
        taintedMonths,
        currentMonth,
        meb,
      ),
    [loadedMonths, incomeSubtotals, spendSubtotals, transferSubtotals, cumBefore, taintedMonths, currentMonth, meb],
  );

  const fxAdjustments = useMemo<ReadonlyMap<string, number>>(
    () => computeFxAdjustments(loadedMonths, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth),
    [loadedMonths, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth],
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
        loadedMonths,
        incomeSubtotals,
        spendSubtotals,
        transferSubtotals,
        currentMonth,
        mebByLiq,
      ),
    [loadedMonths, incomeSubtotals, spendSubtotals, transferSubtotals, currentMonth, mebByLiq],
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
