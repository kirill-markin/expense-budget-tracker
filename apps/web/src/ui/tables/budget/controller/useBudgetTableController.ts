"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { useCommentPresence } from "@/ui/hooks/useCommentPresence";
import type { FieldHints } from "@/server/transactions/getTransactions";
import type { BudgetRow, BusinessPersonalTransferCell, ConversionWarning, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { getCurrentMonth, getYear } from "@/lib/monthUtils";
import type {
  CellValue,
  ColumnEntry,
  CumulativeBalance,
  DirectionBlock,
  YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import { useBudgetTableDerivedState } from "@/ui/tables/budget/controller/useBudgetTableDerivedState";
import { useBudgetTableRangeState } from "@/ui/tables/budget/controller/useBudgetTableRangeState";
import { useBudgetTableViewport } from "@/ui/tables/budget/controller/useBudgetTableViewport";
import { useBudgetTableYearTotals } from "@/ui/tables/budget/controller/useBudgetTableYearTotals";

export type BudgetTableProps = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
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
  currentMonth: string;
  currentYear: string;
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
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  liquidityTiers: ReadonlyArray<string>;
  hasLiquidityBreakdown: boolean;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  commentedCells: ReadonlySet<string>;
  pendingSaves: number;
  isLoadingLeft: boolean;
  isLoadingRight: boolean;
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
    kind: "base" | "modifier",
    value: number,
  ) => void;
  handleFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => void;
  updateCommentCell: (
    month: string,
    direction: string,
    category: string,
    hasComment: boolean,
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
  const {
    commentedCells,
    fetchRange: fetchCommentRange,
    reloadRange: reloadCommentRange,
    updateCell: updateCommentCell,
  } = useCommentPresence(props.initialMonthFrom, props.initialMonthTo, props.refreshToken);

  const currentMonth = useMemo(() => getCurrentMonth(), []);
  const currentYear = useMemo(() => getYear(currentMonth), [currentMonth]);
  const resetYearTotalsRef = useRef<() => void>(() => undefined);
  const handleVisibleRangeRefreshStart = useCallback((): void => {
    resetYearTotalsRef.current();
  }, []);

  const rangeState = useBudgetTableRangeState({
    rows: props.rows,
    initialMonthFrom: props.initialMonthFrom,
    initialMonthTo: props.initialMonthTo,
    cumulativeBefore: props.cumulativeBefore,
    monthEndBalances: props.monthEndBalances,
    monthEndBalancesByLiquidity: props.monthEndBalancesByLiquidity,
    businessPersonalTransfers: props.businessPersonalTransfers,
    hasBusinessAccount: props.hasBusinessAccount,
    currentMonth,
    refreshToken: props.refreshToken,
    fetchCommentRange,
    reloadCommentRange,
    onVisibleRangeRefreshStart: handleVisibleRangeRefreshStart,
  });

  const { yearComputed, resetYearTotals } = useBudgetTableYearTotals({
    loadedFrom: rangeState.loadedFrom,
    loadedTo: rangeState.loadedTo,
    currentMonth,
    effectiveAllowlist,
    refreshToken: props.refreshToken,
  });
  resetYearTotalsRef.current = resetYearTotals;

  const viewportState = useBudgetTableViewport({
    currentMonth,
    pendingSaves: rangeState.pendingSaves,
    onReachLeft: rangeState.loadLeft,
    onReachRight: rangeState.loadRight,
  });

  const derivedState = useBudgetTableDerivedState({
    allRows: rangeState.allRows,
    loadedFrom: rangeState.loadedFrom,
    loadedTo: rangeState.loadedTo,
    cumBefore: rangeState.cumBefore,
    meb: rangeState.meb,
    mebByLiq: rangeState.mebByLiq,
    currentMonth,
    effectiveAllowlist,
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
    currentMonth,
    currentYear,
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
    commentedCells,
    pendingSaves: rangeState.pendingSaves,
    isLoadingLeft: rangeState.isLoadingLeft,
    isLoadingRight: rangeState.isLoadingRight,
    scrollRef: viewportState.scrollRef,
    drillDownFilter,
    fxBreakdownMonth,
    mebByLiq: rangeState.mebByLiq,
    scrollToCurrentMonth: viewportState.scrollToCurrentMonth,
    onSyncStart: rangeState.onSyncStart,
    onSyncEnd: rangeState.onSyncEnd,
    handlePlanSave: rangeState.handlePlanSave,
    handleFillMonths: rangeState.handleFillMonths,
    updateCommentCell,
    openDrillDown,
    handleDrillDownClose,
    openFxBreakdown,
    closeFxBreakdown,
  };
};
