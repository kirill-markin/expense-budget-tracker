"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BudgetGridResult, BudgetRow, BusinessPersonalTransferCell, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { offsetMonth } from "@/lib/monthUtils";
import {
  adjustCumulativeBeforeForPrependedRows,
  getTargetFillMonths,
} from "@/ui/tables/budget/budgetTableLogic";
import {
  applyBudgetBaseToRows,
  getCurrentBudgetBaseMutationCells,
  issueBudgetBaseMutation,
  publishBudgetBaseLocalAcknowledgements,
  protectBudgetBaseAcknowledgement,
  reconcileBudgetBaseRange,
  retainProtectedBudgetBaseLocalAcknowledgements,
  type BudgetBaseCell,
  type BudgetBaseLocalAcknowledgementByCell,
  type BudgetBaseMutationGenerationByCell,
  type BudgetBaseProtectionByCell,
  type BudgetBaseRangeRequest,
} from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import type { BudgetAdjustmentRangeLoadOutcome } from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
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
  refreshToken: string;
  fetchCommentRange: (monthFrom: string, monthTo: string) => void;
  reloadCommentRange: (monthFrom: string, monthTo: string) => void;
  onVisibleRangeRefreshStart: () => void;
  loadBudgetRange: (
    monthFrom: string,
    monthTo: string,
  ) => Promise<BudgetAdjustmentRangeLoadOutcome>;
}>;

export type BudgetTableRangeState = Readonly<{
  allRows: ReadonlyArray<BudgetRow>;
  localBaseAcknowledgementByCell: BudgetBaseLocalAcknowledgementByCell;
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
  rows: ReadonlyArray<BudgetRow>,
): void => {
  setAllRows(rows);
  setCumBefore(result.cumulativeBefore);
  setMeb(result.monthEndBalances);
  setMebByLiq(result.monthEndBalancesByLiquidity);
  setBusinessPersonalTransfers(result.businessPersonalTransfers);
  setHasBusinessAccount(result.hasBusinessAccount);
};

type GeneratedBudgetRangeLoadOutcome =
  | Readonly<{
    status: "accepted";
    result: BudgetGridResult;
    request: BudgetBaseRangeRequest;
  }>
  | Readonly<{
    status: "superseded";
    request: BudgetBaseRangeRequest;
  }>;

const enumerateRangeMonths = (
  monthFrom: string,
  monthTo: string,
): ReadonlyArray<string> => {
  if (monthFrom > monthTo) {
    throw new RangeError(
      `Budget range monthFrom "${monthFrom}" must not be after monthTo "${monthTo}"`,
    );
  }
  const months: Array<string> = [];
  let current = monthFrom;
  while (true) {
    months.push(current);
    if (current === monthTo) return months;
    current = offsetMonth(current, 1);
  }
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
  refreshToken,
  fetchCommentRange,
  reloadCommentRange,
  onVisibleRangeRefreshStart,
  loadBudgetRange,
}: UseBudgetTableRangeStateParams): BudgetTableRangeState => {
  const [allRows, setAllRows] = useState<ReadonlyArray<BudgetRow>>(rows);
  const [
    localBaseAcknowledgementByCell,
    setLocalBaseAcknowledgementByCell,
  ] = useState<BudgetBaseLocalAcknowledgementByCell>(new Map());
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
  const latestRangeRequestGenerationRef = useRef<number>(0);
  const latestRangeRequestGenerationByMonthRef = useRef<Map<string, number>>(
    new Map(),
  );
  const baseProtectionsRef = useRef<BudgetBaseProtectionByCell>(new Map());
  const latestBaseMutationGenerationRef = useRef<number>(0);
  const baseMutationGenerationByCellRef =
    useRef<BudgetBaseMutationGenerationByCell>(new Map());

  const loadGeneratedBudgetRange = useCallback(async (
    monthFrom: string,
    monthTo: string,
  ): Promise<GeneratedBudgetRangeLoadOutcome> => {
    if (latestRangeRequestGenerationRef.current === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Cannot issue another budget range request: generation limit reached");
    }
    const generation = latestRangeRequestGenerationRef.current + 1;
    latestRangeRequestGenerationRef.current = generation;
    const request: BudgetBaseRangeRequest = {
      generation,
      monthFrom,
      monthTo,
    };
    for (const month of enumerateRangeMonths(monthFrom, monthTo)) {
      latestRangeRequestGenerationByMonthRef.current.set(month, generation);
    }

    const outcome = await loadBudgetRange(monthFrom, monthTo);
    return outcome.status === "accepted"
      ? { status: "accepted", result: outcome.result, request }
      : { status: "superseded", request };
  }, [loadBudgetRange]);

  const reconcileAcceptedBaseRange = useCallback((
    result: BudgetGridResult,
    request: BudgetBaseRangeRequest,
  ): ReadonlyArray<BudgetRow> => {
    const reconciled = reconcileBudgetBaseRange(
      result.rows,
      baseProtectionsRef.current,
      request,
    );
    baseProtectionsRef.current = reconciled.protections;
    setLocalBaseAcknowledgementByCell(
      (previous): BudgetBaseLocalAcknowledgementByCell => (
        retainProtectedBudgetBaseLocalAcknowledgements(
          previous,
          reconciled.protections,
        )
      ),
    );
    return reconciled.rows;
  }, []);

  const onSyncStart = useCallback((): void => {
    setPendingSaves((count) => count + 1);
  }, []);

  const onSyncEnd = useCallback((): void => {
    setPendingSaves((count) => Math.max(0, count - 1));
  }, []);

  const runVisibleRangeRefresh = useCallback(async (): Promise<void> => {
    onVisibleRangeRefreshStart();

    try {
      const outcome = await loadGeneratedBudgetRange(loadedFrom, loadedTo);
      if (outcome.status === "superseded") return;
      const result = outcome.result;
      const reconciledRows = reconcileAcceptedBaseRange(result, outcome.request);
      applyFetchedBudgetResult(setAllRows, setCumBefore, setMeb, setMebByLiq, setBusinessPersonalTransfers, setHasBusinessAccount, result, reconciledRows);
      reloadCommentRange(loadedFrom, loadedTo);
    } catch (error) {
      logBudgetTableError("visible range refresh", error);
    }
  }, [loadGeneratedBudgetRange, loadedFrom, loadedTo, onVisibleRangeRefreshStart, reconcileAcceptedBaseRange, refreshToken, reloadCommentRange]);

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

  const issueBaseMutation = useCallback((
    cells: ReadonlyArray<BudgetBaseCell>,
  ): number => {
    const issued = issueBudgetBaseMutation(
      latestBaseMutationGenerationRef.current,
      baseMutationGenerationByCellRef.current,
      cells,
    );
    latestBaseMutationGenerationRef.current = issued.generation;
    baseMutationGenerationByCellRef.current = issued.generationByCell;
    return issued.generation;
  }, []);

  const handleBaseMutationIssued = useCallback((
    month: string,
    direction: string,
    category: string,
  ): number => issueBaseMutation([{ month, direction, category }]), [
    issueBaseMutation,
  ]);

  const handleFillMonths = useCallback((
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ): number => {
    const targetCells = getTargetFillMonths(sourceMonth).map(
      (month): BudgetBaseCell => ({ month, direction, category }),
    );
    const mutationGeneration = issueBaseMutation(targetCells);
    setAllRows((previous) => applyFillMonthsToRows(previous, sourceMonth, direction, category, baseValue));
    return mutationGeneration;
  }, [issueBaseMutation]);

  const publishBaseAcknowledgements = useCallback((
    cells: ReadonlyArray<BudgetBaseCell>,
    baseValue: number,
    mutationGeneration: number,
  ): void => {
    let protections = baseProtectionsRef.current;
    for (const cell of cells) {
      protections = protectBudgetBaseAcknowledgement(protections, {
        cell,
        value: baseValue,
        throughRequestGeneration:
          latestRangeRequestGenerationByMonthRef.current.get(cell.month) ?? 0,
      });
    }
    baseProtectionsRef.current = protections;
    setLocalBaseAcknowledgementByCell(
      (previous): BudgetBaseLocalAcknowledgementByCell => (
        publishBudgetBaseLocalAcknowledgements(
          previous,
          cells,
          baseValue,
          mutationGeneration,
        )
      ),
    );
  }, []);

  const handleBaseAcknowledged = useCallback((
    month: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ): void => {
    const cell = { month, direction, category };
    const currentCells = getCurrentBudgetBaseMutationCells(
      baseMutationGenerationByCellRef.current,
      [cell],
      mutationGeneration,
    );
    if (currentCells.length === 0) return;
    publishBaseAcknowledgements(
      currentCells,
      baseValue,
      mutationGeneration,
    );
    setAllRows((previous): ReadonlyArray<BudgetRow> => (
      applyBudgetBaseToRows(previous, cell, baseValue)
    ));
  }, [publishBaseAcknowledgements]);

  const handleFillMonthsAcknowledged = useCallback((
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ): void => {
    const targetCells = getTargetFillMonths(sourceMonth).map(
      (month): BudgetBaseCell => ({ month, direction, category }),
    );
    const currentCells = getCurrentBudgetBaseMutationCells(
      baseMutationGenerationByCellRef.current,
      targetCells,
      mutationGeneration,
    );
    if (currentCells.length === 0) return;
    publishBaseAcknowledgements(
      currentCells,
      baseValue,
      mutationGeneration,
    );
    setAllRows((previous): ReadonlyArray<BudgetRow> => (
      currentCells.reduce(
        (updatedRows, cell): ReadonlyArray<BudgetRow> => (
          applyBudgetBaseToRows(updatedRows, cell, baseValue)
        ),
        previous,
      )
    ));
  }, [publishBaseAcknowledgements]);

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
      const outcome = await loadGeneratedBudgetRange(newFrom, newTo);
      if (outcome.status === "superseded") return;
      const result = outcome.result;
      const prependedRows = reconcileAcceptedBaseRange(result, outcome.request);
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
  }, [fetchCommentRange, loadGeneratedBudgetRange, loadedFrom, reconcileAcceptedBaseRange]);

  const loadRight = useCallback(async (): Promise<void> => {
    if (isLoadingRightRef.current) {
      return;
    }

    isLoadingRightRef.current = true;
    setIsLoadingRight(true);

    const newFrom = offsetMonth(loadedTo, 1);
    const newTo = offsetMonth(loadedTo, BATCH_SIZE);

    try {
      const outcome = await loadGeneratedBudgetRange(newFrom, newTo);
      if (outcome.status === "superseded") return;
      const result = outcome.result;
      const appendedRows = reconcileAcceptedBaseRange(result, outcome.request);
      setAllRows((previous) => [...previous, ...appendedRows]);
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
  }, [fetchCommentRange, loadGeneratedBudgetRange, loadedTo, reconcileAcceptedBaseRange]);

  return {
    allRows,
    localBaseAcknowledgementByCell,
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
    handleBaseMutationIssued,
    handleFillMonths,
    handleBaseAcknowledged,
    handleFillMonthsAcknowledged,
    refreshLoadedRange,
    loadLeft,
    loadRight,
  };
};
