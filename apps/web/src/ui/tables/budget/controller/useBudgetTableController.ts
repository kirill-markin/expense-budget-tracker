"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import type { FieldHints } from "@/server/transactions/getTransactions";
import type { BudgetAdjustment } from "@/server/budget/budgetAdjustments";
import type { BudgetRow, BusinessPersonalTransferCell, ConversionWarning, CumulativeBefore, UnpairedTransferLeg } from "@/server/budget/getBudgetGrid";
import { getCurrentMonth, getYear } from "@/lib/monthUtils";
import type {
  BudgetPlansMode,
  CellValue,
  ColumnEntry,
  CumulativeBalance,
  YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import type { BudgetGridSection } from "@/ui/tables/budget/controller/useBudgetTableDerivedState";
import { getBudgetCategoryKey, useBudgetTableDerivedState } from "@/ui/tables/budget/controller/useBudgetTableDerivedState";
import { useBudgetPlansMode } from "@/ui/tables/budget/controller/useBudgetPlansMode";
import {
  useBudgetTableRangeState,
  type BudgetVisibleRangeRefreshOutcome,
} from "@/ui/tables/budget/controller/useBudgetTableRangeState";
import { useBudgetTableViewport } from "@/ui/tables/budget/controller/useBudgetTableViewport";
import { useBudgetTableYearTotals } from "@/ui/tables/budget/controller/useBudgetTableYearTotals";
import { useBudgetAdjustmentRowsController } from "@/ui/tables/budget/controller/useBudgetAdjustmentRowsController";
import type {
  BudgetAdjustmentCellLocation,
  BudgetAdjustmentRowsController,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import type { BudgetBaseLocalAcknowledgementByCell } from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import {
  getBudgetDisplayRange,
  getBudgetPlansModeSwitchState,
  getBudgetRangeFetchPlansMode,
  getBudgetRefreshToken,
  getSettledBudgetPlansMode,
} from "@/ui/tables/budget/budgetTableLogic";

export type BudgetTableProps = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  adjustments: ReadonlyArray<BudgetAdjustment>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  unpairedTransferLegs: Readonly<Record<string, ReadonlyArray<UnpairedTransferLeg>>>;
  hasBusinessAccount: boolean;
  initialMonthFrom: string;
  initialMonthTo: string;
  initialPlansMode: BudgetPlansMode;
  reportingCurrency: string;
  hints: FieldHints;
  refreshToken: string;
}>;

export type BudgetTableController = Readonly<{
  effectiveAllowlist: ReadonlySet<string> | null;
  localBaseAcknowledgementByCell: BudgetBaseLocalAcknowledgementByCell;
  currentMonth: string;
  currentYear: string;
  /**
   * Mode the rows in state were fetched for, and therefore the one the whole
   * table renders: columns, split months and years, plans, balances and
   * liquidity rows all follow it.
   */
  plansMode: BudgetPlansMode;
  /** Mode the user asked for; it drives the fetch and the switcher. */
  requestedPlansMode: BudgetPlansMode;
  /**
   * The requested mode is not the one on screen: its refresh is queued, in
   * flight, or has settled without landing. The switcher marks the requested
   * segment as pending while this holds, so the segment it shows as selected
   * always matches the layout the user is looking at.
   */
  isPlansModePending: boolean;
  /** A refresh of the loaded range is in flight. */
  isPlansModeRefreshing: boolean;
  /**
   * The requested mode is pending with no refresh running, so nothing is going
   * to bring it on screen on its own and the switcher offers the retry. Purely
   * derived from the two signals above, which is what keeps it from outliving
   * the request it describes.
   */
  isPlansModeStuck: boolean;
  /** First loaded month the value cells can render. */
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
  unconvertibleCurrenciesByMonth: ReadonlyMap<string, ReadonlyArray<string>>;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  fxAdjustments: ReadonlyMap<string, number>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  unpairedTransferLegs: Readonly<Record<string, ReadonlyArray<UnpairedTransferLeg>>>;
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
  setPlansMode: (plansMode: BudgetPlansMode) => void;
  /**
   * Refreshes the loaded range again, which is exactly the run a stuck request
   * is waiting for; offered only while `isPlansModeStuck` holds.
   */
  retryPlansModeSwitch: () => void;
  addCategory: (direction: string, category: string) => void;
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
  const { plansMode, setPlansMode } = useBudgetPlansMode(props.initialPlansMode);
  const plansModeRef = useRef<BudgetPlansMode>(plansMode);
  plansModeRef.current = plansMode;
  // The mode the rows in state were fetched for, and the single source of
  // truth for everything the table renders. A switch widens or narrows the
  // plan window, so every loaded month and year total refetches through the
  // refresh token below; the layout follows only once those rows land, which
  // leaves a failed switch showing the previous, fully loaded view.
  const [loadedPlansMode, setLoadedPlansMode] = useState<BudgetPlansMode>(
    props.initialPlansMode,
  );
  const loadedPlansModeRef = useRef<BudgetPlansMode>(loadedPlansMode);
  loadedPlansModeRef.current = loadedPlansMode;
  const [isRangeRefreshing, setIsRangeRefreshing] = useState<boolean>(false);
  // Switching the mode has to refetch every loaded range and year total, which
  // is exactly what a new refresh token does.
  const refreshToken = getBudgetRefreshToken(props.refreshToken, plansMode);
  const displayRange = useMemo(() => getBudgetDisplayRange(currentMonth), [currentMonth]);
  const [observedYearTotals, setObservedYearTotals] = useState<ReadonlySet<string>>(new Set());
  const resetYearTotalsRef = useRef<() => void>(() => undefined);
  const invalidateYearTotalsRef = useRef<(years: ReadonlySet<string>) => void>(
    () => undefined,
  );
  const handleVisibleRangeRefreshStart = useCallback((): void => {
    setIsRangeRefreshing(true);
    resetYearTotalsRef.current();
  }, []);
  // Only rows that actually landed may change the rendered mode. A failed or
  // cancelled refresh leaves the previous, fully loaded view on screen, so no
  // column ever reads a plan out of rows nobody fetched it for; the requested
  // mode then stays pending with nothing running, which is the stuck state the
  // switcher derives its retry from.
  const handleVisibleRangeRefreshEnd = useCallback((
    outcome: BudgetVisibleRangeRefreshOutcome,
    refreshedPlansMode: BudgetPlansMode,
  ): void => {
    setIsRangeRefreshing(false);
    setLoadedPlansMode((loadedMode): BudgetPlansMode => (
      getSettledBudgetPlansMode(
        loadedMode,
        refreshedPlansMode,
        outcome === "accepted",
      )
    ));
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

  // Categories the user named in the grid before any row exists for them. They
  // are rendered from here until the first saved plan value makes the server
  // return them, and are gone after a reload when nothing was saved.
  const [sessionAddedCategoriesByDirection, setSessionAddedCategoriesByDirection] =
    useState<ReadonlyMap<string, ReadonlyArray<string>>>(new Map());
  const addCategory = useCallback((direction: string, category: string): void => {
    markCategoryEdited(direction, category);
    setSessionAddedCategoriesByDirection((previous): ReadonlyMap<string, ReadonlyArray<string>> => {
      const current = previous.get(direction) ?? [];
      if (current.includes(category)) return previous;
      const next = new Map(previous);
      next.set(direction, [...current, category]);
      return next;
    });
  }, [markCategoryEdited]);

  const adjustmentsController = useBudgetAdjustmentRowsController({
    adjustments: props.adjustments,
    actualTo: currentMonth,
    currentMonth,
    rangePlansMode: getBudgetRangeFetchPlansMode(plansMode, loadedPlansMode),
    refreshToken,
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
    unpairedTransferLegs: props.unpairedTransferLegs,
    hasBusinessAccount: props.hasBusinessAccount,
    plansMode,
    refreshToken,
    onVisibleRangeRefreshStart: handleVisibleRangeRefreshStart,
    onVisibleRangeRefreshEnd: handleVisibleRangeRefreshEnd,
    loadBudgetRange: budgetAdjustments.loadRange,
    onCategoryEdited: markCategoryEdited,
  });

  const { yearComputed, invalidateYearTotals, resetYearTotals } = useBudgetTableYearTotals({
    observedYears: observedYearTotals,
    currentMonth,
    plansMode: loadedPlansMode,
    effectiveAllowlist,
    refreshToken,
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
    // The value columns are re-widthed by the mode that renders, so the
    // scroll anchor is restored when the loaded rows change the layout.
    plansMode: loadedPlansMode,
    pendingSaves: rangeState.pendingSaves + budgetAdjustments.pendingMutationCount,
    onMonthsObserved: rangeState.requestVisibleMonths,
    onYearTotalsObserved: handleYearTotalsObserved,
  });

  const refreshLoadedRange = rangeState.refreshLoadedRange;
  const requestPlansMode = useCallback((
    nextPlansMode: BudgetPlansMode,
  ): void => {
    if (
      nextPlansMode === plansModeRef.current
      && nextPlansMode === loadedPlansModeRef.current
    ) {
      return;
    }
    if (nextPlansMode !== plansModeRef.current) {
      setPlansMode(nextPlansMode);
      return;
    }
    // The mode is already requested but its rows never landed, so asking for
    // it again means running its refresh again.
    refreshLoadedRange();
  }, [refreshLoadedRange, setPlansMode]);

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
    plansMode: loadedPlansMode,
    effectiveAllowlist,
    adjustmentRows: budgetAdjustments.rows,
    sessionEditedCategoryKeys,
    sessionAddedCategoriesByDirection,
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

  // Everything the switcher says about the requested mode is read off the
  // current render, so no notice can survive the request it is about.
  const plansModeSwitchState = getBudgetPlansModeSwitchState(
    plansMode,
    loadedPlansMode,
    isRangeRefreshing,
  );

  return {
    effectiveAllowlist,
    localBaseAcknowledgementByCell:
      rangeState.localBaseAcknowledgementByCell,
    currentMonth,
    currentYear,
    plansMode: loadedPlansMode,
    requestedPlansMode: plansMode,
    isPlansModePending: plansModeSwitchState !== "settled",
    isPlansModeRefreshing: isRangeRefreshing,
    isPlansModeStuck: plansModeSwitchState === "stuck",
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
    unconvertibleCurrenciesByMonth: derivedState.unconvertibleCurrenciesByMonth,
    cumulativeBalances: derivedState.cumulativeBalances,
    fxAdjustments: derivedState.fxAdjustments,
    businessPersonalTransfers: rangeState.businessPersonalTransfers,
    unpairedTransferLegs: rangeState.unpairedTransferLegs,
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
    setPlansMode: requestPlansMode,
    retryPlansModeSwitch: refreshLoadedRange,
    addCategory,
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
