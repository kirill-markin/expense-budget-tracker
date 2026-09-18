"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import type { FieldHints } from "@/server/transactions/getTransactions";
import type { BudgetAdjustment } from "@/server/budget/budgetAdjustments";
import type { BudgetRow, BusinessPersonalTransferCell, ConversionWarning, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { getCurrentMonth, getYear } from "@/lib/monthUtils";
import type {
  CellValue,
  ColumnEntry,
  CumulativeBalance,
  YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import type { BudgetGridSection } from "@/ui/tables/budget/controller/useBudgetTableDerivedState";
import { getBudgetCategoryKey, useBudgetTableDerivedState } from "@/ui/tables/budget/controller/useBudgetTableDerivedState";
import { useBudgetTableRangeState } from "@/ui/tables/budget/controller/useBudgetTableRangeState";
import { useBudgetTableViewport } from "@/ui/tables/budget/controller/useBudgetTableViewport";
import { useBudgetTableYearTotals } from "@/ui/tables/budget/controller/useBudgetTableYearTotals";
import { useBudgetAdjustmentRowsController } from "@/ui/tables/budget/controller/useBudgetAdjustmentRowsController";
import type {
  BudgetAdjustmentCellLocation,
  BudgetAdjustmentRowsController,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import type { BudgetBaseLocalAcknowledgementByCell } from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import { getBudgetDisplayRange } from "@/ui/tables/budget/budgetTableLogic";

export type BudgetTableProps = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  adjustments: ReadonlyArray<BudgetAdjustment>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  initialMonthFrom: string;
  initialMonthTo: string;
  reportingCurrency: string;
  hints: FieldHints;
  refreshToken: string;
}>;

export type BudgetTableController = Readonly<{
  effectiveAllowlist: ReadonlySet<string> | null;
  localBaseAcknowledgementByCell: BudgetBaseLocalAcknowledgementByCell;
  currentMonth: string;
  currentYear: string;
  loadedFrom: string;
  loadedTo: string;
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
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  liquidityTiers: ReadonlyArray<string>;
  hasLiquidityBreakdown: boolean;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  pendingSaves: number;
  budgetAdjustments: BudgetAdjustmentRowsController;
  scrollRef: RefObject<HTMLDivElement | null>;
  drillDownFilter: DrillDownFilter | null;
  fxBreakdownMonth: string | null;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  scrollToCurrentMonth: () => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
  handlePlanSave: (
    month: string,
    direction: string,
    category: string,
    value: number,
  ) => void;
  handleBaseMutationIssued: (
    month: string,
    direction: string,
    category: string,
  ) => number;
  handleFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => number;
  handleBaseAcknowledged: (
    month: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  handleFillMonthsAcknowledged: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  openDrillDown: (filter: DrillDownFilter) => void;
  handleDrillDownClose: (dirty: boolean) => void;
  openFxBreakdown: (month: string) => void;
  closeFxBreakdown: () => void;
}>;

/**
 * Keeps the budget table's current viewport and overlays stable while route
 * refreshes update the underlying live data through the current refresh token.
 */
export const useBudgetTableController = (
  props: BudgetTableProps,
): BudgetTableController => {
  const { effectiveAllowlist } = useFilteredMode();

  const currentMonth = useMemo(() => getCurrentMonth(), []);
  const currentYear = useMemo(() => getYear(currentMonth), [currentMonth]);
  const displayRange = useMemo(() => getBudgetDisplayRange(currentMonth), [currentMonth]);
  const [observedYearTotals, setObservedYearTotals] = useState<ReadonlySet<string>>(new Set());
  const resetYearTotalsRef = useRef<() => void>(() => undefined);
  const invalidateYearTotalsRef = useRef<(years: ReadonlySet<string>) => void>(
    () => undefined,
  );
  const handleVisibleRangeRefreshStart = useCallback((): void => {
    resetYearTotalsRef.current();
  }, []);

  const invalidateAdjustmentYears = useCallback((years: ReadonlySet<string>): void => {
    invalidateYearTotalsRef.current(years);
  }, []);

  // A category the user touches in this session stays visible until the page
  // reloads, so clearing the last non-zero value cannot make the row vanish
  // under the cursor.
  const [sessionEditedCategoryKeys, setSessionEditedCategoryKeys] =
    useState<ReadonlySet<string>>(new Set());
  const markCategoryEdited = useCallback((direction: string, category: string): void => {
    const key = getBudgetCategoryKey(direction, category);
    setSessionEditedCategoryKeys((previous): ReadonlySet<string> => {
      if (previous.has(key)) return previous;
      const next = new Set(previous);
      next.add(key);
      return next;
    });
  }, []);

  const adjustmentsController = useBudgetAdjustmentRowsController({
    adjustments: props.adjustments,
    planFrom: currentMonth,
    actualTo: currentMonth,
    refreshToken: props.refreshToken,
    invalidateYears: invalidateAdjustmentYears,
  });

  // Retaining a cell means its adjustment editor is open, which is the single
  // gate every adjustment create, patch and delete passes through.
  // The wrapper must keep the stable identity the retaining effect depends on.
  const retainAdjustmentCell = adjustmentsController.retainCell;
  const retainEditedCell = useCallback((
    ownerId: string,
    location: BudgetAdjustmentCellLocation,
  ): (() => void) => {
    markCategoryEdited(location.direction, location.category);
    return retainAdjustmentCell(ownerId, location);
  }, [markCategoryEdited, retainAdjustmentCell]);

  const budgetAdjustments: BudgetAdjustmentRowsController = {
    ...adjustmentsController,
    retainCell: retainEditedCell,
  };

  const rangeState = useBudgetTableRangeState({
    rows: props.rows,
    displayMonthFrom: displayRange.monthFrom,
    displayMonthTo: displayRange.monthTo,
    initialMonthFrom: props.initialMonthFrom,
    initialMonthTo: props.initialMonthTo,
    cumulativeBefore: props.cumulativeBefore,
    monthEndBalances: props.monthEndBalances,
    monthEndBalancesByLiquidity: props.monthEndBalancesByLiquidity,
    businessPersonalTransfers: props.businessPersonalTransfers,
    hasBusinessAccount: props.hasBusinessAccount,
    refreshToken: props.refreshToken,
    onVisibleRangeRefreshStart: handleVisibleRangeRefreshStart,
    loadBudgetRange: budgetAdjustments.loadRange,
    onCategoryEdited: markCategoryEdited,
  });

  const { yearComputed, invalidateYearTotals, resetYearTotals } = useBudgetTableYearTotals({
    observedYears: observedYearTotals,
    currentMonth,
    effectiveAllowlist,
    refreshToken: props.refreshToken,
  });
  resetYearTotalsRef.current = resetYearTotals;
  invalidateYearTotalsRef.current = invalidateYearTotals;

  const rowsWithAdjustments = useMemo<ReadonlyArray<BudgetRow>>(
    () => budgetAdjustments.applyToBudgetRows(
      rangeState.allRows,
      rangeState.loadedFrom,
      rangeState.loadedTo,
      effectiveAllowlist,
    ),
    [
      budgetAdjustments,
      effectiveAllowlist,
      rangeState.allRows,
      rangeState.loadedFrom,
      rangeState.loadedTo,
    ],
  );

  const handleYearTotalsObserved = useCallback((years: ReadonlySet<string>): void => {
    setObservedYearTotals((previous) => {
      const next = new Set(previous);
      for (const year of years) {
        next.add(year);
      }
      return next.size === previous.size ? previous : next;
    });
  }, []);

  const viewportState = useBudgetTableViewport({
    currentMonth,
    pendingSaves: rangeState.pendingSaves + budgetAdjustments.pendingMutationCount,
    onMonthsObserved: rangeState.requestVisibleMonths,
    onYearTotalsObserved: handleYearTotalsObserved,
  });

  const derivedState = useBudgetTableDerivedState({
    allRows: rowsWithAdjustments,
    displayFrom: displayRange.monthFrom,
    displayTo: displayRange.monthTo,
    loadedFrom: rangeState.loadedFrom,
    loadedTo: rangeState.loadedTo,
    cumBefore: rangeState.cumBefore,
    meb: rangeState.meb,
    mebByLiq: rangeState.mebByLiq,
    currentMonth,
    effectiveAllowlist,
    adjustmentRows: budgetAdjustments.rows,
    sessionEditedCategoryKeys,
  });

  const [drillDownFilter, setDrillDownFilter] = useState<DrillDownFilter | null>(null);
  const [fxBreakdownMonth, setFxBreakdownMonth] = useState<string | null>(null);

  const handleDrillDownClose = useCallback((dirty: boolean): void => {
    setDrillDownFilter(null);
    if (!dirty) {
      return;
    }

    rangeState.refreshLoadedRange();
  }, [rangeState.refreshLoadedRange]);

  const openDrillDown = useCallback((filter: DrillDownFilter): void => {
    setDrillDownFilter(filter);
  }, []);

  const openFxBreakdown = useCallback((month: string): void => {
    setFxBreakdownMonth(month);
  }, []);

  const closeFxBreakdown = useCallback((): void => {
    setFxBreakdownMonth(null);
  }, []);

  return {
    effectiveAllowlist,
    localBaseAcknowledgementByCell:
      rangeState.localBaseAcknowledgementByCell,
    currentMonth,
    currentYear,
    loadedFrom: rangeState.loadedFrom,
    loadedTo: rangeState.loadedTo,
    months: derivedState.months,
    blocks: derivedState.blocks,
    columnSequence: derivedState.columnSequence,
    allCategories: derivedState.allCategories,
    filteredSubtotalsMap: derivedState.filteredSubtotalsMap,
    incomeSubtotals: derivedState.incomeSubtotals,
    spendSubtotals: derivedState.spendSubtotals,
    transferSubtotals: derivedState.transferSubtotals,
    taintedCells: derivedState.taintedCells,
    taintedDirectionMonths: derivedState.taintedDirectionMonths,
    taintedMonths: derivedState.taintedMonths,
    cumulativeBalances: derivedState.cumulativeBalances,
    fxAdjustments: derivedState.fxAdjustments,
    businessPersonalTransfers: rangeState.businessPersonalTransfers,
    hasBusinessAccount: rangeState.hasBusinessAccount,
    liquidityTiers: derivedState.liquidityTiers,
    hasLiquidityBreakdown: derivedState.hasLiquidityBreakdown,
    projectedLiqBalances: derivedState.projectedLiqBalances,
    yearComputed,
    pendingSaves: rangeState.pendingSaves + budgetAdjustments.pendingMutationCount,
    budgetAdjustments,
    scrollRef: viewportState.scrollRef,
    drillDownFilter,
    fxBreakdownMonth,
    mebByLiq: rangeState.mebByLiq,
    scrollToCurrentMonth: viewportState.scrollToCurrentMonth,
    onSyncStart: rangeState.onSyncStart,
    onSyncEnd: rangeState.onSyncEnd,
    handlePlanSave: rangeState.handlePlanSave,
    handleBaseMutationIssued: rangeState.handleBaseMutationIssued,
    handleFillMonths: rangeState.handleFillMonths,
    handleBaseAcknowledged: rangeState.handleBaseAcknowledged,
    handleFillMonthsAcknowledged: rangeState.handleFillMonthsAcknowledged,
    openDrillDown,
    handleDrillDownClose,
    openFxBreakdown,
    closeFxBreakdown,
  };
};
