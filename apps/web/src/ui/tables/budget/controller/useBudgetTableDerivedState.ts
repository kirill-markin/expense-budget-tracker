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
  DIRECTION_LABELS,
  DIRECTION_ORDER,
  LIQUIDITY_ORDER,
  buildBlocks,
  buildBudgetTaintedState,
  buildColumnSequence,
  computeAllowedSubtotals,
  computeCumulativeBalances,
  computeCumulativeBalancesByLiquidity,
  computeFxAdjustments,
  zeroCellValue,
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

const NO_SESSION_ADDED_CATEGORIES: ReadonlyArray<string> = [];

/**
 * The directions that carry named categories, in the order the grid renders
 * them. Transfers are excluded: they have no named categories, so an empty
 * transfer section would offer nothing.
 */
const NAMED_CATEGORY_DIRECTIONS: ReadonlyArray<string> = ["income", "spend"];

const buildEmptyDirectionBlock = (
  direction: string,
  months: ReadonlyArray<string>,
): DirectionBlock => ({
  direction,
  label: DIRECTION_LABELS[direction] ?? direction,
  categories: [],
  cells: new Map(),
  subtotals: new Map(months.map((month): [string, CellValue] => [month, zeroCellValue])),
});

/**
 * Guarantees an income and a spend block even when no row carries that
 * direction: `buildBlocks` emits a block only for a direction present in the
 * data, so a workspace whose last spend category vanished would lose the
 * section, and with it the only place a category can be named. The synthesized
 * block holds no categories and zero subtotals over the displayed months, which
 * the balance, FX and liquidity rows already treat exactly like a direction
 * with no block at all.
 * Filtered mode synthesizes nothing: the grid offers no add-category control
 * there, so a synthesized block would render only a header and an all-zero
 * subtotal row that reads as "income is zero" rather than "not present".
 */
export const withNamedCategoryDirectionBlocks = (
  blocks: ReadonlyArray<DirectionBlock>,
  months: ReadonlyArray<string>,
  effectiveAllowlist: ReadonlySet<string> | null,
): ReadonlyArray<DirectionBlock> => {
  if (effectiveAllowlist !== null) {
    return blocks;
  }
  const missing = NAMED_CATEGORY_DIRECTIONS.filter((direction): boolean =>
    !blocks.some((block): boolean => block.direction === direction));
  if (missing.length === 0) {
    return blocks;
  }
  const byDirection = new Map<string, DirectionBlock>(
    blocks.map((block): [string, DirectionBlock] => [block.direction, block]),
  );
  for (const direction of missing) {
    byDirection.set(direction, buildEmptyDirectionBlock(direction, months));
  }
  // `buildBlocks` only ever emits directions from DIRECTION_ORDER, so ordering
  // by it keeps every existing block exactly where it was.
  return DIRECTION_ORDER
    .map((direction): DirectionBlock | undefined => byDirection.get(direction))
    .filter((block): block is DirectionBlock => block !== undefined);
};

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
 * Adds the categories the user named in the budget grid during this session to
 * one direction block. Such a name has no row anywhere yet, so it exists in no
 * `buildBlocks` output and the hiding rule alone could never surface it; it
 * joins the unfiltered block so that every picker list sees it too, and it
 * renders as an all-zero category row until a plan value is saved for it.
 */
export const withSessionAddedBudgetCategories = (
  block: DirectionBlock,
  sessionAddedCategories: ReadonlyArray<string>,
): DirectionBlock => {
  const known = new Set(block.categories);
  const added = sessionAddedCategories.filter((category): boolean => !known.has(category));
  if (added.length === 0) {
    return block;
  }
  return { ...block, categories: [...block.categories, ...added] };
};

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
  sessionAddedCategoriesByDirection: ReadonlyMap<string, ReadonlyArray<string>>;
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
  sessionAddedCategoriesByDirection,
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
    () => withNamedCategoryDirectionBlocks(
      buildBlocks(allRows, months, currentMonth, effectiveAllowlist),
      months,
      effectiveAllowlist,
    ),
    [allRows, months, currentMonth, effectiveAllowlist],
  );

  // The session-added names join the unfiltered blocks, so from here on they
  // are treated exactly like a category that already has rows: the hiding rule
  // keeps them because adding one also marks it edited in this session.
  const blocksWithSessionAdded = useMemo<ReadonlyArray<DirectionBlock>>(
    () => allBlocks.map((block): DirectionBlock => withSessionAddedBudgetCategories(
      block,
      sessionAddedCategoriesByDirection.get(block.direction) ?? NO_SESSION_ADDED_CATEGORIES,
    )),
    [allBlocks, sessionAddedCategoriesByDirection],
  );

  const blocks = useMemo<ReadonlyArray<BudgetGridSection>>(() => {
    const visibleCategoryKeys = selectVisibleBudgetCategoryKeys(
      allRows,
      adjustmentRows,
      sessionEditedCategoryKeys,
    );
    return blocksWithSessionAdded.map((block): BudgetGridSection => ({
      block: hideEmptyBudgetCategories(block, visibleCategoryKeys),
      directionCategories: block.categories,
    }));
  }, [blocksWithSessionAdded, allRows, adjustmentRows, sessionEditedCategoryKeys]);

  const columnSequence = useMemo<ReadonlyArray<ColumnEntry>>(
    () => buildColumnSequence(months),
    [months],
  );

  // Built from the unfiltered blocks: this list feeds the transaction category
  // picker, which must keep offering a category the grid currently hides.
  const allCategories = useMemo<ReadonlyArray<string>>(() => {
    const categories = new Set<string>();
    for (const block of blocksWithSessionAdded) {
      for (const category of block.categories) {
        categories.add(category);
      }
    }
    return [...categories].sort();
  }, [blocksWithSessionAdded]);

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
