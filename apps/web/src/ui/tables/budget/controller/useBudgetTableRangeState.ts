"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BudgetGridResult, BudgetRow, BusinessPersonalTransferCell, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { offsetMonth } from "@/lib/monthUtils";
import {
  adjustCumulativeBeforeForPrependedRows,
  getBudgetRangeExtension,
  getTargetFillMonths,
  type BudgetRangeExtension,
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
import {
  createBudgetBackgroundRetryProgress,
  finishBudgetBackgroundRetryCycle,
  getBudgetBackgroundRetryDelayMs,
  resumeBudgetBackgroundRetryCycle,
  startBudgetBackgroundRetryAttempt,
  waitForBudgetBackgroundRetry,
  type BudgetBackgroundRetryProgress,
} from "@/ui/tables/budget/controller/budgetBackgroundRetry";
import {
  logBudgetTableError,
  logBudgetTableWarning,
} from "@/ui/tables/budget/table/logBudgetTableError";

const BATCH_SIZE = 6;

type UseBudgetTableRangeStateParams = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  displayMonthFrom: string;
  displayMonthTo: string;
  initialMonthFrom: string;
  initialMonthTo: string;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  refreshToken: string;
  onVisibleRangeRefreshStart: () => void;
  loadBudgetRange: (
    monthFrom: string,
    monthTo: string,
    signal: AbortSignal,
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
  refreshLoadedRange: () => void;
  requestVisibleMonths: (monthFrom: string, monthTo: string) => void;
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

type AcceptedGeneratedBudgetRange = Readonly<{
  result: BudgetGridResult;
  request: BudgetBaseRangeRequest;
}>;

export type BudgetViewportRetryKey =
  `${"left" | "right"}:${string}:${string}`;

export const buildBudgetViewportRetryKey = (
  direction: "left" | "right",
  monthFrom: string,
  monthTo: string,
): BudgetViewportRetryKey => `${direction}:${monthFrom}:${monthTo}`;

export const selectBudgetViewportRangeExtension = (
  extensions: ReadonlyArray<BudgetRangeExtension>,
  progressByKey: ReadonlyMap<BudgetViewportRetryKey, BudgetBackgroundRetryProgress>,
): BudgetRangeExtension | null => extensions.find((extension): boolean => {
  const progress = progressByKey.get(buildBudgetViewportRetryKey(
    extension.direction,
    extension.monthFrom,
    extension.monthTo,
  ));
  return progress === undefined || progress.status === "attempting";
}) ?? null;

export const retainPendingBudgetViewportRetryProgress = (
  progressByKey: ReadonlyMap<BudgetViewportRetryKey, BudgetBackgroundRetryProgress>,
  pendingKeys: ReadonlySet<BudgetViewportRetryKey>,
): Map<BudgetViewportRetryKey, BudgetBackgroundRetryProgress> => new Map(
  [...progressByKey].filter(([requestKey]): boolean => (
    pendingKeys.has(requestKey)
  )),
);

const getPendingBudgetViewportRangeExtensions = (
  displayMonthFrom: string,
  displayMonthTo: string,
  loadedFrom: string,
  loadedTo: string,
  requestedVisibleFrom: string,
  requestedVisibleTo: string,
): ReadonlyArray<BudgetRangeExtension> => {
  const extensions: Array<BudgetRangeExtension> = [];
  if (requestedVisibleFrom < loadedFrom) {
    const leftExtension = getBudgetRangeExtension(
      displayMonthFrom,
      displayMonthTo,
      loadedFrom,
      loadedTo,
      requestedVisibleFrom,
      loadedTo,
      BATCH_SIZE,
    );
    if (leftExtension === null || leftExtension.direction !== "left") {
      throw new Error("Cannot build pending left budget viewport extension");
    }
    extensions.push(leftExtension);
  }
  if (requestedVisibleTo > loadedTo) {
    const rightExtension = getBudgetRangeExtension(
      displayMonthFrom,
      displayMonthTo,
      loadedFrom,
      loadedTo,
      loadedFrom,
      requestedVisibleTo,
      BATCH_SIZE,
    );
    if (rightExtension === null || rightExtension.direction !== "right") {
      throw new Error("Cannot build pending right budget viewport extension");
    }
    extensions.push(rightExtension);
  }
  return extensions;
};

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
  value: number,
): ReadonlyArray<BudgetRow> => {
  const rowIndex = previous.findIndex((row) =>
    row.month === month && row.direction === direction && row.category === category);

  if (rowIndex >= 0) {
    const row = previous[rowIndex];
    const updatedRow: BudgetRow = {
      ...row,
      plannedBase: value,
      planned: value + row.plannedModifier,
    };
    return [...previous.slice(0, rowIndex), updatedRow, ...previous.slice(rowIndex + 1)];
  }

  return [...previous, buildNewBudgetRow(month, direction, category, value, 0)];
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
  displayMonthFrom,
  displayMonthTo,
  initialMonthFrom,
  initialMonthTo,
  cumulativeBefore,
  monthEndBalances,
  monthEndBalancesByLiquidity,
  businessPersonalTransfers: initialBusinessPersonalTransfers,
  hasBusinessAccount: initialHasBusinessAccount,
  refreshToken,
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
  const [pendingSaves, setPendingSaves] = useState<number>(0);

  const isLoadingViewportRangeRef = useRef<boolean>(false);
  const viewportRetryTimerRef = useRef<number | null>(null);
  const viewportRetryProgressByKeyRef = useRef<
    Map<BudgetViewportRetryKey, BudgetBackgroundRetryProgress>
  >(new Map());
  const activeViewportRetryKeyRef =
    useRef<BudgetViewportRetryKey | null>(null);
  const enqueueViewportRangeLoadRef = useRef<(() => void) | null>(null);
  const lifecycleAbortControllerRef = useRef<AbortController | null>(null);
  if (lifecycleAbortControllerRef.current === null) {
    lifecycleAbortControllerRef.current = new AbortController();
  }
  const isMountedRef = useRef<boolean>(true);
  const rangeRequestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadedFromRef = useRef<string>(initialMonthFrom);
  const loadedToRef = useRef<string>(initialMonthTo);
  const requestedVisibleFromRef = useRef<string>(initialMonthFrom);
  const requestedVisibleToRef = useRef<string>(initialMonthTo);
  const initialRefreshHandledRef = useRef<boolean>(false);
  const latestRangeRequestGenerationRef = useRef<number>(0);
  const latestRangeRequestGenerationByMonthRef = useRef<Map<string, number>>(
    new Map(),
  );
  const baseProtectionsRef = useRef<BudgetBaseProtectionByCell>(new Map());
  const latestBaseMutationGenerationRef = useRef<number>(0);
  const baseMutationGenerationByCellRef =
    useRef<BudgetBaseMutationGenerationByCell>(new Map());

  useEffect(() => {
    const abortController = lifecycleAbortControllerRef.current;
    const isLifecycleReplay = abortController?.signal.aborted === true;
    if (abortController === null || isLifecycleReplay) {
      lifecycleAbortControllerRef.current = new AbortController();
    }
    isMountedRef.current = true;
    const activeRetryKey = activeViewportRetryKeyRef.current;
    const activeRetryProgress = activeRetryKey === null
      ? undefined
      : viewportRetryProgressByKeyRef.current.get(activeRetryKey);
    if (isLifecycleReplay && activeRetryProgress?.status === "cycle-wait") {
      viewportRetryProgressByKeyRef.current.set(
        activeRetryKey,
        resumeBudgetBackgroundRetryCycle(activeRetryProgress),
      );
      const enqueueViewportRangeLoadCurrent =
        enqueueViewportRangeLoadRef.current;
      if (enqueueViewportRangeLoadCurrent === null) {
        throw new Error(
          "Cannot resume viewport month range after lifecycle replay: queue callback is unavailable",
        );
      }
      enqueueViewportRangeLoadCurrent();
    }
    return (): void => {
      isMountedRef.current = false;
      lifecycleAbortControllerRef.current?.abort();
      if (viewportRetryTimerRef.current !== null) {
        window.clearTimeout(viewportRetryTimerRef.current);
        viewportRetryTimerRef.current = null;
      }
    };
  }, []);

  const loadGeneratedBudgetRange = useCallback(async (
    monthFrom: string,
    monthTo: string,
    signal: AbortSignal,
  ): Promise<GeneratedBudgetRangeLoadOutcome> => {
    signal.throwIfAborted();
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

    const outcome = await loadBudgetRange(monthFrom, monthTo, signal);
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

  const enqueueRangeRequest = useCallback((
    request: () => Promise<void>,
    operation: string,
  ): void => {
    rangeRequestQueueRef.current = rangeRequestQueueRef.current
      .then(request)
      .catch((error: unknown): void => {
        logBudgetTableError(operation, error);
      });
  }, []);

  const runVisibleRangeRefresh = useCallback(async (): Promise<void> => {
    const lifecycleSignal = lifecycleAbortControllerRef.current?.signal;
    if (lifecycleSignal === undefined || lifecycleSignal.aborted) {
      return;
    }
    onVisibleRangeRefreshStart();

    try {
      const outcome = await loadGeneratedBudgetRange(
        loadedFromRef.current,
        loadedToRef.current,
        lifecycleSignal,
      );
      if (lifecycleSignal.aborted) return;
      if (outcome.status === "superseded") return;
      const result = outcome.result;
      const reconciledRows = reconcileAcceptedBaseRange(result, outcome.request);
      applyFetchedBudgetResult(setAllRows, setCumBefore, setMeb, setMebByLiq, setBusinessPersonalTransfers, setHasBusinessAccount, result, reconciledRows);
    } catch (error) {
      if (lifecycleSignal.aborted) return;
      logBudgetTableError("visible range refresh", error);
    }
  }, [loadGeneratedBudgetRange, onVisibleRangeRefreshStart, reconcileAcceptedBaseRange]);

  useEffect(() => {
    if (!initialRefreshHandledRef.current) {
      initialRefreshHandledRef.current = true;
      return;
    }

    enqueueRangeRequest(runVisibleRangeRefresh, "visible range refresh coordination");
  }, [enqueueRangeRequest, refreshToken, runVisibleRangeRefresh]);

  const handlePlanSave = useCallback((
    month: string,
    direction: string,
    category: string,
    value: number,
  ): void => {
    setAllRows((previous) => applyPlanSaveToRows(previous, month, direction, category, value));
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
    enqueueRangeRequest(runVisibleRangeRefresh, "visible range refresh coordination");
  }, [enqueueRangeRequest, runVisibleRangeRefresh]);

  const loadViewportRangeWithRetry = useCallback(async (
    monthFrom: string,
    monthTo: string,
    direction: "left" | "right",
    lifecycleSignal: AbortSignal,
  ): Promise<AcceptedGeneratedBudgetRange> => {
    const operation = `load ${direction} viewport month range ${monthFrom}..${monthTo}`;
    const requestKey = buildBudgetViewportRetryKey(
      direction,
      monthFrom,
      monthTo,
    );

    while (true) {
      if (lifecycleSignal.aborted) {
        throw new Error(`Cancelled ${operation}: budget table unmounted`);
      }
      const currentProgress =
        viewportRetryProgressByKeyRef.current.get(requestKey)
        ?? createBudgetBackgroundRetryProgress();
      const progress = startBudgetBackgroundRetryAttempt(currentProgress);
      viewportRetryProgressByKeyRef.current.set(requestKey, progress);
      const completedAttemptCount = progress.completedAttemptCount;
      let failure: unknown;
      try {
        const outcome = await loadGeneratedBudgetRange(
          monthFrom,
          monthTo,
          lifecycleSignal,
        );
        if (lifecycleSignal.aborted) {
          throw new Error(`Cancelled ${operation}: budget table unmounted`);
        }
        if (outcome.status === "accepted") {
          viewportRetryProgressByKeyRef.current.delete(requestKey);
          if (activeViewportRetryKeyRef.current === requestKey) {
            activeViewportRetryKeyRef.current = null;
          }
          return { result: outcome.result, request: outcome.request };
        }
        failure = new Error(
          `Budget viewport range ${monthFrom}..${monthTo} was superseded on attempt ${completedAttemptCount}`,
        );
      } catch (error) {
        if (lifecycleSignal.aborted) {
          throw error;
        }
        failure = error;
      }

      const retryDelayMs = getBudgetBackgroundRetryDelayMs(
        completedAttemptCount,
      );
      if (retryDelayMs === null) {
        const reason = failure instanceof Error
          ? failure.message
          : String(failure);
        throw new Error(
          `${operation} exhausted ${completedAttemptCount} attempts: ${reason}`,
          { cause: failure },
        );
      }
      logBudgetTableWarning(
        `${operation} retrying in ${retryDelayMs}ms after attempt ${completedAttemptCount}`,
        failure,
      );
      const waitOutcome = await waitForBudgetBackgroundRetry(
        retryDelayMs,
        lifecycleSignal,
      );
      if (waitOutcome === "cancelled") {
        throw new Error(`Cancelled ${operation}: budget table unmounted`);
      }
    }
  }, [loadGeneratedBudgetRange]);

  const loadRequestedViewportRange = useCallback(async (
    lifecycleSignal: AbortSignal,
  ): Promise<void> => {
    while (true) {
      if (lifecycleSignal.aborted) {
        return;
      }
      const pendingExtensions = getPendingBudgetViewportRangeExtensions(
        displayMonthFrom,
        displayMonthTo,
        loadedFromRef.current,
        loadedToRef.current,
        requestedVisibleFromRef.current,
        requestedVisibleToRef.current,
      );
      const pendingExtensionByKey = new Map(
        pendingExtensions.map((extension): readonly [
          BudgetViewportRetryKey,
          BudgetRangeExtension,
        ] => [
          buildBudgetViewportRetryKey(
            extension.direction,
            extension.monthFrom,
            extension.monthTo,
          ),
          extension,
        ]),
      );
      viewportRetryProgressByKeyRef.current =
        retainPendingBudgetViewportRetryProgress(
          viewportRetryProgressByKeyRef.current,
          new Set(pendingExtensionByKey.keys()),
        );
      if (
        activeViewportRetryKeyRef.current !== null
        && !viewportRetryProgressByKeyRef.current.has(
          activeViewportRetryKeyRef.current,
        )
      ) {
        activeViewportRetryKeyRef.current = null;
      }
      const activeRequestKey = activeViewportRetryKeyRef.current;
      const activeExtension = activeRequestKey === null
        ? undefined
        : pendingExtensionByKey.get(activeRequestKey);
      const activeProgress = activeRequestKey === null
        ? undefined
        : viewportRetryProgressByKeyRef.current.get(activeRequestKey);
      const extension = activeExtension !== undefined
        && (activeProgress === undefined || activeProgress.status === "attempting")
        ? activeExtension
        : selectBudgetViewportRangeExtension(
          pendingExtensions,
          viewportRetryProgressByKeyRef.current,
        );
      if (extension === null) {
        if (activeProgress?.status !== "cycle-wait") {
          activeViewportRetryKeyRef.current = null;
        }
        return;
      }
      activeViewportRetryKeyRef.current = buildBudgetViewportRetryKey(
        extension.direction,
        extension.monthFrom,
        extension.monthTo,
      );

      const isLeft = extension.direction === "left";

      const outcome = await loadViewportRangeWithRetry(
        extension.monthFrom,
        extension.monthTo,
        extension.direction,
        lifecycleSignal,
      );
      if (lifecycleSignal.aborted) {
        return;
      }
      const result = outcome.result;
      const reconciledRows = reconcileAcceptedBaseRange(result, outcome.request);
      if (isLeft) {
        setAllRows((previous) => [...reconciledRows, ...previous]);
        setCumBefore((previous) => (
          adjustCumulativeBeforeForPrependedRows(previous, reconciledRows)
        ));
        loadedFromRef.current = extension.monthFrom;
        setLoadedFrom(extension.monthFrom);
      } else {
        setAllRows((previous) => [...previous, ...reconciledRows]);
        loadedToRef.current = extension.monthTo;
        setLoadedTo(extension.monthTo);
      }
      setMeb((previous) => ({ ...previous, ...result.monthEndBalances }));
      setMebByLiq((previous) => ({
        ...previous,
        ...result.monthEndBalancesByLiquidity,
      }));
      setBusinessPersonalTransfers((previous) => ({
        ...previous,
        ...result.businessPersonalTransfers,
      }));
      setHasBusinessAccount(result.hasBusinessAccount);
    }
  }, [displayMonthFrom, displayMonthTo, loadViewportRangeWithRetry, reconcileAcceptedBaseRange]);

  const enqueueViewportRangeLoad = useCallback((): void => {
    if (
      isLoadingViewportRangeRef.current
      || viewportRetryTimerRef.current !== null
    ) {
      return;
    }

    isLoadingViewportRangeRef.current = true;
    enqueueRangeRequest(
      async (): Promise<void> => {
        const lifecycleSignal = lifecycleAbortControllerRef.current?.signal;
        if (lifecycleSignal === undefined || lifecycleSignal.aborted) {
          isLoadingViewportRangeRef.current = false;
          return;
        }
        let failed = false;
        let failure: unknown;
        try {
          await loadRequestedViewportRange(lifecycleSignal);
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          isLoadingViewportRangeRef.current = false;
        }

        if (lifecycleSignal.aborted) {
          const activeLifecycleSignal =
            lifecycleAbortControllerRef.current?.signal;
          if (
            isMountedRef.current
            && activeLifecycleSignal !== undefined
            && activeLifecycleSignal !== lifecycleSignal
            && !activeLifecycleSignal.aborted
          ) {
            const enqueueViewportRangeLoadCurrent =
              enqueueViewportRangeLoadRef.current;
            if (enqueueViewportRangeLoadCurrent === null) {
              throw new Error(
                "Cannot resume viewport month range: queue callback is unavailable",
              );
            }
            enqueueViewportRangeLoadCurrent();
          }
          return;
        }
        if (!isMountedRef.current) {
          return;
        }
        if (!failed) {
          return;
        }
        const activeRequestKey = activeViewportRetryKeyRef.current;
        const activeRetryProgress = activeRequestKey === null
          ? undefined
          : viewportRetryProgressByKeyRef.current.get(activeRequestKey);
        if (activeRequestKey === null || activeRetryProgress === undefined) {
          throw new Error(
            "Cannot finish viewport month range retry cycle: progress is unavailable",
          );
        }
        const cycleCompletion = finishBudgetBackgroundRetryCycle(
          activeRetryProgress,
        );
        viewportRetryProgressByKeyRef.current.set(
          activeRequestKey,
          cycleCompletion.progress,
        );
        if (cycleCompletion.retryDelayMs === null) {
          activeViewportRetryKeyRef.current = null;
          logBudgetTableError(
            `viewport month range background load after ${cycleCompletion.progress.completedCycleCount} cycles`,
            failure,
          );
          const enqueueViewportRangeLoadCurrent =
            enqueueViewportRangeLoadRef.current;
          if (enqueueViewportRangeLoadCurrent === null) {
            throw new Error(
              "Cannot continue viewport month ranges after exhaustion: queue callback is unavailable",
            );
          }
          enqueueViewportRangeLoadCurrent();
          return;
        }

        logBudgetTableWarning(
          `viewport month range background load retrying cycle ${cycleCompletion.progress.completedCycleCount + 1} in ${cycleCompletion.retryDelayMs}ms`,
          failure,
        );
        const scheduledRequestKey = activeRequestKey;
        viewportRetryTimerRef.current = window.setTimeout((): void => {
          viewportRetryTimerRef.current = null;
          if (lifecycleSignal.aborted || !isMountedRef.current) {
            return;
          }
          const scheduledRetryProgress =
            viewportRetryProgressByKeyRef.current.get(scheduledRequestKey);
          if (
            activeViewportRetryKeyRef.current !== scheduledRequestKey
            || scheduledRetryProgress?.status !== "cycle-wait"
          ) {
            return;
          }
          viewportRetryProgressByKeyRef.current.set(
            scheduledRequestKey,
            resumeBudgetBackgroundRetryCycle(scheduledRetryProgress),
          );
          const enqueueViewportRangeLoadCurrent =
            enqueueViewportRangeLoadRef.current;
          if (enqueueViewportRangeLoadCurrent === null) {
            throw new Error(
              "Cannot retry viewport month range: queue callback is unavailable",
            );
          }
          enqueueViewportRangeLoadCurrent();
        }, cycleCompletion.retryDelayMs);
      },
      "viewport month range coordination",
    );
  }, [enqueueRangeRequest, loadRequestedViewportRange]);
  enqueueViewportRangeLoadRef.current = enqueueViewportRangeLoad;

  const requestVisibleMonths = useCallback((
    monthFrom: string,
    monthTo: string,
  ): void => {
    if (monthFrom < requestedVisibleFromRef.current) {
      requestedVisibleFromRef.current = monthFrom;
    }
    if (monthTo > requestedVisibleToRef.current) {
      requestedVisibleToRef.current = monthTo;
    }
    if (
      isLoadingViewportRangeRef.current
      || viewportRetryTimerRef.current !== null
    ) {
      return;
    }
    enqueueViewportRangeLoad();
  }, [enqueueViewportRangeLoad]);

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
    onSyncStart,
    onSyncEnd,
    handlePlanSave,
    handleBaseMutationIssued,
    handleFillMonths,
    handleBaseAcknowledged,
    handleFillMonthsAcknowledged,
    refreshLoadedRange,
    requestVisibleMonths,
  };
};
