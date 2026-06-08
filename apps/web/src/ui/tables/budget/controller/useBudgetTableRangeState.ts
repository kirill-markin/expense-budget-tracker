"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BudgetGridResult, BudgetRow, BusinessPersonalTransferCell, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { offsetMonth } from "@/lib/monthUtils";
import {
  adjustCumulativeBeforeForPrependedRows,
  getTargetFillMonths,
} from "@/ui/tables/budget/budgetTableLogic";
import { fetchBudgetRange } from "@/ui/tables/budget/budgetTableApi";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";

const BATCH_SIZE = 6;

type UseBudgetTableRangeStateParams = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  initialMonthFrom: string;
  initialMonthTo: string;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  currentMonth: string;
  refreshToken: string;
  fetchCommentRange: (monthFrom: string, monthTo: string) => void;
  reloadCommentRange: (monthFrom: string, monthTo: string) => void;
  onVisibleRangeRefreshStart: () => void;
}>;

export type BudgetTableRangeState = Readonly<{
  allRows: ReadonlyArray<BudgetRow>;
  loadedFrom: string;
  loadedTo: string;
  cumBefore: CumulativeBefore;
  meb: Readonly<Record<string, number>>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  pendingSaves: number;
  isLoadingLeft: boolean;
  isLoadingRight: boolean;
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
  refreshLoadedRange: () => void;
  loadLeft: () => Promise<void>;
  loadRight: () => Promise<void>;
}>;

const applyFetchedBudgetResult = (
  setAllRows: (value: ReadonlyArray<BudgetRow>) => void,
  setCumBefore: (value: CumulativeBefore) => void,
  setMeb: (value: Readonly<Record<string, number>>) => void,
  setMebByLiq: (value: Readonly<Record<string, Readonly<Record<string, number>>>>) => void,
  setBusinessPersonalTransfers: (value: Readonly<Record<string, BusinessPersonalTransferCell>>) => void,
  setHasBusinessAccount: (value: boolean) => void,
  result: BudgetGridResult,
): void => {
  setAllRows(result.rows);
  setCumBefore(result.cumulativeBefore);
  setMeb(result.monthEndBalances);
  setMebByLiq(result.monthEndBalancesByLiquidity);
  setBusinessPersonalTransfers(result.businessPersonalTransfers);
  setHasBusinessAccount(result.hasBusinessAccount);
};

const buildNewBudgetRow = (
  month: string,
  direction: string,
  category: string,
  plannedBase: number,
  plannedModifier: number,
): BudgetRow => ({
  month,
  direction,
  category,
  plannedBase,
  plannedModifier,
  planned: plannedBase + plannedModifier,
  actual: 0,
  hasUnconvertible: false,
});

const applyPlanSaveToRows = (
  previous: ReadonlyArray<BudgetRow>,
  month: string,
  direction: string,
  category: string,
  kind: "base" | "modifier",
  value: number,
): ReadonlyArray<BudgetRow> => {
  const rowIndex = previous.findIndex((row) =>
    row.month === month && row.direction === direction && row.category === category);

  if (rowIndex >= 0) {
    const row = previous[rowIndex];
    const plannedBase = kind === "base" ? value : row.plannedBase;
    const plannedModifier = kind === "modifier" ? value : row.plannedModifier;
    const updatedRow: BudgetRow = {
      ...row,
      plannedBase,
      plannedModifier,
      planned: plannedBase + plannedModifier,
    };
    return [...previous.slice(0, rowIndex), updatedRow, ...previous.slice(rowIndex + 1)];
  }

  const plannedBase = kind === "base" ? value : 0;
  const plannedModifier = kind === "modifier" ? value : 0;
  return [...previous, buildNewBudgetRow(month, direction, category, plannedBase, plannedModifier)];
};

const applyFillMonthsToRows = (
  previous: ReadonlyArray<BudgetRow>,
  sourceMonth: string,
  direction: string,
  category: string,
  baseValue: number,
): ReadonlyArray<BudgetRow> => {
  const targetMonths = getTargetFillMonths(sourceMonth);
  const updatedRows = [...previous];

  for (const month of targetMonths) {
    const rowIndex = updatedRows.findIndex((row) =>
      row.month === month && row.direction === direction && row.category === category);

    if (rowIndex >= 0) {
      const row = updatedRows[rowIndex];
      updatedRows[rowIndex] = {
        ...row,
        plannedBase: baseValue,
        planned: baseValue + row.plannedModifier,
      };
      continue;
    }

    updatedRows.push(buildNewBudgetRow(month, direction, category, baseValue, 0));
  }

  return updatedRows;
};

export const useBudgetTableRangeState = ({
  rows,
  initialMonthFrom,
  initialMonthTo,
  cumulativeBefore,
  monthEndBalances,
  monthEndBalancesByLiquidity,
  businessPersonalTransfers: initialBusinessPersonalTransfers,
  hasBusinessAccount: initialHasBusinessAccount,
  currentMonth,
  refreshToken,
  fetchCommentRange,
  reloadCommentRange,
  onVisibleRangeRefreshStart,
}: UseBudgetTableRangeStateParams): BudgetTableRangeState => {
  const [allRows, setAllRows] = useState<ReadonlyArray<BudgetRow>>(rows);
  const [loadedFrom, setLoadedFrom] = useState<string>(initialMonthFrom);
  const [loadedTo, setLoadedTo] = useState<string>(initialMonthTo);
  const [cumBefore, setCumBefore] = useState<CumulativeBefore>(cumulativeBefore);
  const [meb, setMeb] = useState<Readonly<Record<string, number>>>(monthEndBalances);
  const [mebByLiq, setMebByLiq] = useState<Readonly<Record<string, Readonly<Record<string, number>>>>>(monthEndBalancesByLiquidity);
  const [businessPersonalTransfers, setBusinessPersonalTransfers] = useState<Readonly<Record<string, BusinessPersonalTransferCell>>>(initialBusinessPersonalTransfers);
  const [hasBusinessAccount, setHasBusinessAccount] = useState<boolean>(initialHasBusinessAccount);
  const [isLoadingLeft, setIsLoadingLeft] = useState<boolean>(false);
  const [isLoadingRight, setIsLoadingRight] = useState<boolean>(false);
  const [pendingSaves, setPendingSaves] = useState<number>(0);

  const isLoadingLeftRef = useRef<boolean>(false);
  const isLoadingRightRef = useRef<boolean>(false);
  const initialRefreshHandledRef = useRef<boolean>(false);

  const onSyncStart = useCallback((): void => {
    setPendingSaves((count) => count + 1);
  }, []);

  const onSyncEnd = useCallback((): void => {
    setPendingSaves((count) => Math.max(0, count - 1));
  }, []);

  const runVisibleRangeRefresh = useCallback(async (): Promise<void> => {
    onVisibleRangeRefreshStart();

    try {
      const result = await fetchBudgetRange(loadedFrom, loadedTo, currentMonth, currentMonth, refreshToken);
      applyFetchedBudgetResult(setAllRows, setCumBefore, setMeb, setMebByLiq, setBusinessPersonalTransfers, setHasBusinessAccount, result);
      reloadCommentRange(loadedFrom, loadedTo);
    } catch (error) {
      logBudgetTableError("visible range refresh", error);
    }
  }, [currentMonth, loadedFrom, loadedTo, onVisibleRangeRefreshStart, refreshToken, reloadCommentRange]);

  useEffect(() => {
    if (!initialRefreshHandledRef.current) {
      initialRefreshHandledRef.current = true;
      return;
    }

    void runVisibleRangeRefresh();
  }, [runVisibleRangeRefresh]);

  const handlePlanSave = useCallback((
    month: string,
    direction: string,
    category: string,
    kind: "base" | "modifier",
    value: number,
  ): void => {
    setAllRows((previous) => applyPlanSaveToRows(previous, month, direction, category, kind, value));
  }, []);

  const handleFillMonths = useCallback((
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ): void => {
    setAllRows((previous) => applyFillMonthsToRows(previous, sourceMonth, direction, category, baseValue));
  }, []);

  const refreshLoadedRange = useCallback((): void => {
    void runVisibleRangeRefresh();
  }, [runVisibleRangeRefresh]);

  const loadLeft = useCallback(async (): Promise<void> => {
    if (isLoadingLeftRef.current) {
      return;
    }

    isLoadingLeftRef.current = true;
    setIsLoadingLeft(true);

    const newTo = offsetMonth(loadedFrom, -1);
    const newFrom = offsetMonth(loadedFrom, -BATCH_SIZE);

    try {
      const result = await fetchBudgetRange(newFrom, newTo, currentMonth, currentMonth, refreshToken);
      const prependedRows = result.rows;
      setAllRows((previous) => [...prependedRows, ...previous]);
      setCumBefore((previous) => adjustCumulativeBeforeForPrependedRows(previous, prependedRows));
      setLoadedFrom(newFrom);
      setMeb((previous) => ({ ...previous, ...result.monthEndBalances }));
      setMebByLiq((previous) => ({ ...previous, ...result.monthEndBalancesByLiquidity }));
      setBusinessPersonalTransfers((previous) => ({ ...previous, ...result.businessPersonalTransfers }));
      setHasBusinessAccount(result.hasBusinessAccount);
      fetchCommentRange(newFrom, newTo);
    } catch (error) {
      logBudgetTableError("load previous month range", error);
    } finally {
      isLoadingLeftRef.current = false;
      setIsLoadingLeft(false);
    }
  }, [currentMonth, fetchCommentRange, loadedFrom, refreshToken]);

  const loadRight = useCallback(async (): Promise<void> => {
    if (isLoadingRightRef.current) {
      return;
    }

    isLoadingRightRef.current = true;
    setIsLoadingRight(true);

    const newFrom = offsetMonth(loadedTo, 1);
    const newTo = offsetMonth(loadedTo, BATCH_SIZE);

    try {
      const result = await fetchBudgetRange(newFrom, newTo, currentMonth, currentMonth, refreshToken);
      setAllRows((previous) => [...previous, ...result.rows]);
      setLoadedTo(newTo);
      setMeb((previous) => ({ ...previous, ...result.monthEndBalances }));
      setMebByLiq((previous) => ({ ...previous, ...result.monthEndBalancesByLiquidity }));
      setBusinessPersonalTransfers((previous) => ({ ...previous, ...result.businessPersonalTransfers }));
      setHasBusinessAccount(result.hasBusinessAccount);
      fetchCommentRange(newFrom, newTo);
    } catch (error) {
      logBudgetTableError("load next month range", error);
    } finally {
      isLoadingRightRef.current = false;
      setIsLoadingRight(false);
    }
  }, [currentMonth, fetchCommentRange, loadedTo, refreshToken]);

  return {
    allRows,
    loadedFrom,
    loadedTo,
    cumBefore,
    meb,
    mebByLiq,
    businessPersonalTransfers,
    hasBusinessAccount,
    pendingSaves,
    isLoadingLeft,
    isLoadingRight,
    onSyncStart,
    onSyncEnd,
    handlePlanSave,
    handleFillMonths,
    refreshLoadedRange,
    loadLeft,
    loadRight,
  };
};
