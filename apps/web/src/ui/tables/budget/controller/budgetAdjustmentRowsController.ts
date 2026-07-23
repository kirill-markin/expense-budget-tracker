import type {
  BudgetAdjustment,
  BudgetAdjustmentDirection,
  CreateBudgetAdjustmentParams,
  PatchBudgetAdjustmentParams,
} from "@/server/budget/budgetAdjustments";
import type { BudgetGridResult, BudgetRow } from "@/server/budget/getBudgetGrid";
import {
  addOptimisticBudgetAdjustmentRow,
  createBudgetAdjustmentRowsReconciliationState,
  discardOptimisticBudgetAdjustmentRow,
  getBudgetAdjustmentInvalidatedCellKeys,
  issueBudgetAdjustmentCreateRequest,
  issueBudgetAdjustmentDeleteRequest,
  issueBudgetAdjustmentPatchRequest,
  issueBudgetAdjustmentRangeRequest,
  reconcileBudgetAdjustmentCreateAcknowledgement,
  reconcileBudgetAdjustmentCreateFailure,
  reconcileBudgetAdjustmentDeleteAcknowledgement,
  reconcileBudgetAdjustmentDeleteAmbiguousFailure,
  reconcileBudgetAdjustmentDeleteDefinitiveFailure,
  reconcileBudgetAdjustmentPatchAcknowledgement,
  reconcileBudgetAdjustmentPatchAmbiguousFailure,
  reconcileBudgetAdjustmentPatchDefinitiveFailure,
  reconcileBudgetAdjustmentRangeFailure,
  reconcileBudgetAdjustmentRangeResponse,
  replaceBudgetAdjustmentReconciliationDraft,
  type BudgetAdjustmentRowsReconciliationState,
} from "@/ui/tables/budget/budgetAdjustmentRowsReconciliation";
import {
  applyBudgetAdjustmentRowsWithProtectedCells,
  getBudgetAdjustmentCellKey,
  getBudgetAdjustmentCellRows,
  getBudgetAdjustmentCellTotal,
  isBudgetAdjustmentRowVisible,
  parseBudgetAdjustmentDraft,
  type BudgetAdjustmentDraft,
  type BudgetAdjustmentDraftError,
  type BudgetAdjustmentEditorRow,
  type ProtectedBudgetAdjustmentCell,
} from "@/ui/tables/budget/budgetAdjustmentRowsState";
import {
  BudgetAdjustmentApiError,
  type DeleteBudgetAdjustmentOutcome,
} from "@/ui/tables/budget/budgetTableApi";

export type BudgetAdjustmentCellLocation = Readonly<{
  month: string;
  direction: BudgetAdjustmentDirection;
  category: string;
}>;

export type BudgetAdjustmentRowOperation = "creating" | "saving" | "deleting";
export type BudgetAdjustmentFailureClassification = "definitive" | "ambiguous";

export type BudgetAdjustmentRowError = Readonly<{
  operation: "create" | "patch" | "delete";
  classification: BudgetAdjustmentFailureClassification;
  message: string;
  httpStatus: number | null;
  action: "retry-save" | "refresh-range";
}>;

export type BudgetAdjustmentRangeError = Readonly<{
  monthFrom: string;
  monthTo: string;
  message: string;
  httpStatus: number | null;
}>;

type BudgetAdjustmentRangeFailure = Readonly<{
  error: BudgetAdjustmentRangeError;
  requestId: number;
}>;

export type BudgetAdjustmentFlushOutcome =
  | "saved"
  | "unchanged"
  | "invalid"
  | "error"
  | "refresh-required"
  | "deleted";

export type BudgetAdjustmentRecoveryOutcome = "recovered" | "unsuccessful";

export type BudgetAdjustmentRangeLoadOutcome =
  | Readonly<{ status: "accepted"; result: BudgetGridResult }>
  | Readonly<{ status: "superseded" }>;

export type BudgetAdjustmentRowsControllerState = Readonly<{
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>;
  invalidatedCellKeys: ReadonlySet<string>;
  validationByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentDraftError>;
  errorByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentRowError>;
  operationByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentRowOperation>;
  recoveringAdjustmentIds: ReadonlySet<string>;
  protectedCellKeys: ReadonlySet<string>;
  rangeErrorByKey: ReadonlyMap<string, BudgetAdjustmentRangeError>;
  pendingMutationCount: number;
  pendingRangeCount: number;
}>;

export type BudgetAdjustmentRowsControllerCommands = Readonly<{
  addRow: (location: BudgetAdjustmentCellLocation) => string;
  replaceDraft: (adjustmentId: string, draft: BudgetAdjustmentDraft) => void;
  flushRow: (adjustmentId: string) => Promise<BudgetAdjustmentFlushOutcome>;
  recoverRow: (adjustmentId: string) => Promise<BudgetAdjustmentRecoveryOutcome>;
  requestDelete: (adjustmentId: string) => Promise<BudgetAdjustmentFlushOutcome>;
  loadRange: (monthFrom: string, monthTo: string) => Promise<BudgetAdjustmentRangeLoadOutcome>;
  refreshRow: (adjustmentId: string) => Promise<BudgetAdjustmentRangeLoadOutcome>;
  getRow: (
    adjustmentId: string,
    effectiveAllowlist: ReadonlySet<string> | null,
  ) => BudgetAdjustmentEditorRow | null;
  getCellRows: (
    location: BudgetAdjustmentCellLocation,
    effectiveAllowlist: ReadonlySet<string> | null,
  ) => ReadonlyArray<BudgetAdjustmentEditorRow>;
  getCellTotal: (
    location: BudgetAdjustmentCellLocation,
    effectiveAllowlist: ReadonlySet<string> | null,
  ) => number;
  retainCell: (
    ownerId: string,
    location: BudgetAdjustmentCellLocation,
  ) => () => void;
  applyToBudgetRows: (
    budgetRows: ReadonlyArray<BudgetRow>,
    loadedFrom: string,
    loadedTo: string,
    effectiveAllowlist: ReadonlySet<string> | null,
  ) => ReadonlyArray<BudgetRow>;
}>;

export type BudgetAdjustmentRowsController =
  BudgetAdjustmentRowsControllerState & BudgetAdjustmentRowsControllerCommands;

type TimerHandle = ReturnType<typeof setTimeout>;

export type BudgetAdjustmentRowsControllerDependencies = Readonly<{
  initialAdjustments: ReadonlyArray<BudgetAdjustment>;
  planFrom: string;
  autosaveDelayMs: number;
  createAdjustment: (params: CreateBudgetAdjustmentParams) => Promise<BudgetAdjustment>;
  patchAdjustment: (
    adjustmentId: string,
    params: PatchBudgetAdjustmentParams,
  ) => Promise<BudgetAdjustment>;
  deleteAdjustment: (adjustmentId: string) => Promise<DeleteBudgetAdjustmentOutcome>;
  fetchRange: (monthFrom: string, monthTo: string) => Promise<BudgetGridResult>;
  generateAdjustmentId: () => string;
  schedule: (callback: () => void, delayMs: number) => TimerHandle;
  cancelScheduled: (handle: TimerHandle) => void;
  invalidateYears: (years: ReadonlySet<string>) => void;
}>;

export type BudgetAdjustmentRowsControllerRuntime = Readonly<{
  getSnapshot: () => BudgetAdjustmentRowsControllerState;
  subscribe: (listener: () => void) => () => void;
  commands: BudgetAdjustmentRowsControllerCommands;
  activate: () => void;
  dispose: () => void;
}>;

const getRangeKey = (monthFrom: string, monthTo: string): string =>
  `${monthFrom}\u0000${monthTo}`;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getHttpStatus = (error: unknown): number | null =>
  error instanceof BudgetAdjustmentApiError ? error.status : null;

export const classifyBudgetAdjustmentFailure = (
  error: unknown,
): BudgetAdjustmentFailureClassification =>
  error instanceof BudgetAdjustmentApiError
    && error.status >= 400
    && error.status < 500
    ? "definitive"
    : "ambiguous";

const getAffectedYears = (months: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(months.map((month): string => month.slice(0, 4)));

const enumerateMonths = (monthFrom: string, monthTo: string): ReadonlyArray<string> => {
  const months: Array<string> = [];
  let current = monthFrom;
  while (true) {
    months.push(current);
    if (current === monthTo) return months;
    const year = Number(current.slice(0, 4));
    const month = Number(current.slice(5, 7));
    current = month === 12
      ? `${String(year + 1).padStart(4, "0")}-01`
      : `${current.slice(0, 5)}${String(month + 1).padStart(2, "0")}`;
  }
};

const isRangeFailureSuperseded = (
  state: BudgetAdjustmentRowsReconciliationState,
  requestId: number,
  monthFrom: string,
  monthTo: string,
): boolean => enumerateMonths(monthFrom, monthTo).every((month): boolean =>
  (state.acceptedRangeRequestIdByMonth.get(month) ?? 0) > requestId);

const buildValidationMap = (
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  planFrom: string,
): ReadonlyMap<string, BudgetAdjustmentDraftError> => {
  const errors = new Map<string, BudgetAdjustmentDraftError>();
  for (const row of rows) {
    const parsed = parseBudgetAdjustmentDraft(row.draft, planFrom);
    if (!parsed.ok) errors.set(row.adjustmentId, parsed.error);
  }
  return errors;
};

const hasDirtyFields = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
): boolean => state.dirtyFieldsByAdjustmentId.has(adjustmentId);

export const createBudgetAdjustmentRowsController = (
  dependencies: BudgetAdjustmentRowsControllerDependencies,
): BudgetAdjustmentRowsControllerRuntime => {
  let reconciliation = createBudgetAdjustmentRowsReconciliationState(
    dependencies.initialAdjustments,
    dependencies.planFrom,
  );
  let disposed = false;
  let snapshot: BudgetAdjustmentRowsControllerState;
  const listeners = new Set<() => void>();
  const timers = new Map<string, TimerHandle>();
  const suspendedAutosaveIds = new Set<string>();
  const suspendedInvalidationYears = new Set<string>();
  const activeFlushes = new Map<string, Promise<BudgetAdjustmentFlushOutcome>>();
  const activeRecoveries = new Map<string, Promise<BudgetAdjustmentRecoveryOutcome>>();
  const deleteRequestedIds = new Set<string>();
  const protectedCellOwners = new Map<string, Readonly<{
    cell: ProtectedBudgetAdjustmentCell;
    lease: symbol;
  }>>();
  let rowErrors = new Map<string, BudgetAdjustmentRowError>();
  let rowOperations = new Map<string, BudgetAdjustmentRowOperation>();
  let rangeFailuresByKey = new Map<string, BudgetAdjustmentRangeFailure>();
  let pendingRangeCount = 0;

  const getDisposedError = (operation: string): Error | null => disposed
    ? new Error(`Cannot ${operation}: controller is disposed`)
    : null;

  const createSnapshot = (): BudgetAdjustmentRowsControllerState => ({
    rows: reconciliation.rows,
    invalidatedCellKeys: getBudgetAdjustmentInvalidatedCellKeys(reconciliation),
    validationByAdjustmentId: buildValidationMap(reconciliation.rows, dependencies.planFrom),
    errorByAdjustmentId: new Map(rowErrors),
    operationByAdjustmentId: new Map(rowOperations),
    recoveringAdjustmentIds: new Set(activeRecoveries.keys()),
    protectedCellKeys: new Set([...protectedCellOwners.values()].map(
      (owner): string => getBudgetAdjustmentCellKey(
        owner.cell.month,
        owner.cell.direction,
        owner.cell.category,
      ),
    )),
    rangeErrorByKey: new Map([...rangeFailuresByKey].map(
      ([rangeKey, failure]): readonly [string, BudgetAdjustmentRangeError] =>
        [rangeKey, failure.error],
    )),
    pendingMutationCount: new Set([
      ...timers.keys(),
      ...activeFlushes.keys(),
    ]).size,
    pendingRangeCount,
  });

  snapshot = createSnapshot();

  const publish = (): void => {
    snapshot = createSnapshot();
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  const clearTimer = (adjustmentId: string): void => {
    const timer = timers.get(adjustmentId);
    if (timer === undefined) return;
    dependencies.cancelScheduled(timer);
    timers.delete(adjustmentId);
  };

  const invalidateYears = (months: ReadonlyArray<string>): void => {
    const years = getAffectedYears(months);
    if (disposed) {
      for (const year of years) suspendedInvalidationYears.add(year);
      return;
    }
    dependencies.invalidateYears(years);
  };

  const setRowOperation = (
    adjustmentId: string,
    operation: BudgetAdjustmentRowOperation | null,
  ): void => {
    rowOperations = new Map(rowOperations);
    if (operation === null) rowOperations.delete(adjustmentId);
    else rowOperations.set(adjustmentId, operation);
  };

  const clearRowError = (adjustmentId: string): void => {
    if (!rowErrors.has(adjustmentId)) return;
    rowErrors = new Map(rowErrors);
    rowErrors.delete(adjustmentId);
  };

  const setRowError = (
    adjustmentId: string,
    operation: BudgetAdjustmentRowError["operation"],
    error: unknown,
    requiresRefresh: boolean,
  ): void => {
    const classification = classifyBudgetAdjustmentFailure(error);
    rowErrors = new Map(rowErrors);
    rowErrors.set(adjustmentId, {
      operation,
      classification,
      message: getErrorMessage(error),
      httpStatus: getHttpStatus(error),
      action: requiresRefresh ? "refresh-range" : "retry-save",
    });
  };

  const canDiscardOptimisticRow = (adjustmentId: string): boolean => {
    const optimistic = reconciliation.optimisticCreateByAdjustmentId.get(adjustmentId);
    if (optimistic?.status === "ready") return true;
    return optimistic?.status === "failed"
      && rowErrors.get(adjustmentId)?.classification === "definitive";
  };

  const discardOptimisticRow = (adjustmentId: string): void => {
    reconciliation = discardOptimisticBudgetAdjustmentRow(
      reconciliation,
      adjustmentId,
    );
    deleteRequestedIds.delete(adjustmentId);
    suspendedAutosaveIds.delete(adjustmentId);
    clearTimer(adjustmentId);
    clearRowError(adjustmentId);
    setRowOperation(adjustmentId, null);
    publish();
  };

  const clearRemovedRowState = (
    previousRows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  ): void => {
    const currentAdjustmentIds = new Set(reconciliation.rows.map(
      (row): string => row.adjustmentId,
    ));
    for (const row of previousRows) {
      if (currentAdjustmentIds.has(row.adjustmentId)) continue;
      deleteRequestedIds.delete(row.adjustmentId);
      suspendedAutosaveIds.delete(row.adjustmentId);
      clearTimer(row.adjustmentId);
      clearRowError(row.adjustmentId);
      setRowOperation(row.adjustmentId, null);
    }
  };

  const clearRecoveredRangeErrors = (): void => {
    rangeFailuresByKey = new Map([...rangeFailuresByKey].filter(([, failure]): boolean =>
      !isRangeFailureSuperseded(
        reconciliation,
        failure.requestId,
        failure.error.monthFrom,
        failure.error.monthTo,
      )));
  };

  const runCreate = async (adjustmentId: string): Promise<boolean> => {
    const issued = issueBudgetAdjustmentCreateRequest(reconciliation, adjustmentId);
    reconciliation = issued.state;
    setRowOperation(adjustmentId, "creating");
    publish();
    try {
      const adjustment = await dependencies.createAdjustment(issued.request.params);
      reconciliation = reconcileBudgetAdjustmentCreateAcknowledgement(
        reconciliation,
        issued.request,
        adjustment,
      ).state;
      clearRowError(adjustmentId);
      invalidateYears([issued.request.params.month, adjustment.month]);
      return true;
    } catch (error: unknown) {
      reconciliation = reconcileBudgetAdjustmentCreateFailure(
        reconciliation,
        issued.request,
      );
      setRowError(adjustmentId, "create", error, false);
      return false;
    } finally {
      setRowOperation(adjustmentId, null);
      publish();
    }
  };

  const runPatch = async (adjustmentId: string): Promise<boolean> => {
    const issued = issueBudgetAdjustmentPatchRequest(reconciliation, adjustmentId);
    reconciliation = issued.state;
    setRowOperation(adjustmentId, "saving");
    publish();
    try {
      const adjustment = await dependencies.patchAdjustment(
        adjustmentId,
        issued.request.params,
      );
      reconciliation = reconcileBudgetAdjustmentPatchAcknowledgement(
        reconciliation,
        issued.request,
        adjustment,
      ).state;
      clearRowError(adjustmentId);
      invalidateYears([
        issued.request.baseline.month,
        issued.request.requested.month,
        adjustment.month,
      ]);
      return true;
    } catch (error: unknown) {
      const classification = classifyBudgetAdjustmentFailure(error);
      const requiresRefresh = classification === "ambiguous"
        || getHttpStatus(error) === 404;
      reconciliation = requiresRefresh
        ? reconcileBudgetAdjustmentPatchAmbiguousFailure(reconciliation, issued.request)
        : reconcileBudgetAdjustmentPatchDefinitiveFailure(reconciliation, issued.request);
      setRowError(adjustmentId, "patch", error, requiresRefresh);
      if (requiresRefresh) {
        invalidateYears([issued.request.baseline.month, issued.request.requested.month]);
      }
      return false;
    } finally {
      setRowOperation(adjustmentId, null);
      publish();
    }
  };

  const runDelete = async (adjustmentId: string): Promise<boolean> => {
    const issued = issueBudgetAdjustmentDeleteRequest(reconciliation, adjustmentId);
    reconciliation = issued.state;
    setRowOperation(adjustmentId, "deleting");
    publish();
    try {
      const outcome = await dependencies.deleteAdjustment(adjustmentId);
      reconciliation = reconcileBudgetAdjustmentDeleteAcknowledgement(
        reconciliation,
        issued.request,
        outcome,
      ).state;
      deleteRequestedIds.delete(adjustmentId);
      clearRowError(adjustmentId);
      invalidateYears([issued.request.confirmed.month]);
      return true;
    } catch (error: unknown) {
      const classification = classifyBudgetAdjustmentFailure(error);
      reconciliation = classification === "definitive"
        ? reconcileBudgetAdjustmentDeleteDefinitiveFailure(reconciliation, issued.request)
        : reconcileBudgetAdjustmentDeleteAmbiguousFailure(reconciliation, issued.request);
      setRowError(adjustmentId, "delete", error, classification === "ambiguous");
      if (classification === "ambiguous") {
        invalidateYears([issued.request.confirmed.month]);
      }
      return false;
    } finally {
      setRowOperation(adjustmentId, null);
      publish();
    }
  };

  const drainRow = async (
    adjustmentId: string,
  ): Promise<BudgetAdjustmentFlushOutcome> => {
    let saved = false;
    while (true) {
      clearTimer(adjustmentId);
      const row = reconciliation.rows.find((candidate): boolean =>
        candidate.adjustmentId === adjustmentId);
      if (row === undefined) return deleteRequestedIds.has(adjustmentId) ? "unchanged" : "deleted";

      const optimistic = reconciliation.optimisticCreateByAdjustmentId.get(adjustmentId);
      if (optimistic !== undefined) {
        if (!await runCreate(adjustmentId)) {
          if (deleteRequestedIds.has(adjustmentId)
            && canDiscardOptimisticRow(adjustmentId)) {
            discardOptimisticRow(adjustmentId);
            return "deleted";
          }
          return "error";
        }
        saved = true;
        continue;
      }

      if (reconciliation.ambiguousRangeRequirementByAdjustmentId.has(adjustmentId)) {
        return "refresh-required";
      }

      if (deleteRequestedIds.has(adjustmentId)) {
        if (!await runDelete(adjustmentId)) return "error";
        return "deleted";
      }

      const parsed = parseBudgetAdjustmentDraft(row.draft, dependencies.planFrom);
      if (!parsed.ok) return "invalid";
      if (!hasDirtyFields(reconciliation, adjustmentId)) {
        clearRowError(adjustmentId);
        publish();
        return saved ? "saved" : "unchanged";
      }
      if (!await runPatch(adjustmentId)) return "error";
      saved = true;
    }
  };

  const flushRow = (
    adjustmentId: string,
  ): Promise<BudgetAdjustmentFlushOutcome> => {
    const disposedError = getDisposedError(`flush budget adjustment "${adjustmentId}"`);
    if (disposedError !== null) return Promise.reject(disposedError);
    clearTimer(adjustmentId);
    const active = activeFlushes.get(adjustmentId);
    if (active !== undefined) return active;
    if (!reconciliation.rows.some((row): boolean => row.adjustmentId === adjustmentId)) {
      return Promise.reject(new Error(
        `Cannot flush missing budget adjustment "${adjustmentId}"`,
      ));
    }

    const promise = Promise.resolve()
      .then((): Promise<BudgetAdjustmentFlushOutcome> => drainRow(adjustmentId))
      .finally((): void => {
        if (activeFlushes.get(adjustmentId) === promise) {
          activeFlushes.delete(adjustmentId);
          setRowOperation(adjustmentId, null);
          publish();
        }
      });
    activeFlushes.set(adjustmentId, promise);
    publish();
    return promise;
  };

  const scheduleAutosave = (adjustmentId: string): void => {
    clearTimer(adjustmentId);
    suspendedAutosaveIds.delete(adjustmentId);
    let handle: TimerHandle | null = null;
    handle = dependencies.schedule((): void => {
      if (handle === null || timers.get(adjustmentId) !== handle) return;
      timers.delete(adjustmentId);
      if (disposed) return;
      void flushRow(adjustmentId);
    }, dependencies.autosaveDelayMs);
    timers.set(adjustmentId, handle);
  };

  const canScheduleAutosave = (adjustmentId: string): boolean => {
    const row = reconciliation.rows.find((candidate): boolean =>
      candidate.adjustmentId === adjustmentId);
    if (row === undefined) return false;
    if (reconciliation.optimisticCreateByAdjustmentId.has(adjustmentId)) return true;
    return parseBudgetAdjustmentDraft(row.draft, dependencies.planFrom).ok
      && hasDirtyFields(reconciliation, adjustmentId)
      && !reconciliation.ambiguousRangeRequirementByAdjustmentId.has(adjustmentId);
  };

  const addRow = (location: BudgetAdjustmentCellLocation): string => {
    const disposedError = getDisposedError("add budget adjustment");
    if (disposedError !== null) throw disposedError;
    const adjustmentId = dependencies.generateAdjustmentId();
    reconciliation = addOptimisticBudgetAdjustmentRow(
      reconciliation,
      adjustmentId,
      location.month,
      location.direction,
      location.category,
    );
    clearRowError(adjustmentId);
    scheduleAutosave(adjustmentId);
    publish();
    return adjustmentId;
  };

  const replaceDraft = (adjustmentId: string, draft: BudgetAdjustmentDraft): void => {
    const disposedError = getDisposedError(`edit budget adjustment "${adjustmentId}"`);
    if (disposedError !== null) throw disposedError;
    if (deleteRequestedIds.has(adjustmentId)) {
      throw new Error(
        `Cannot edit budget adjustment "${adjustmentId}" after delete was requested`,
      );
    }
    reconciliation = replaceBudgetAdjustmentReconciliationDraft(
      reconciliation,
      adjustmentId,
      draft,
    );
    if (!reconciliation.ambiguousRangeRequirementByAdjustmentId.has(adjustmentId)) {
      clearRowError(adjustmentId);
    }
    if (canScheduleAutosave(adjustmentId)) scheduleAutosave(adjustmentId);
    else clearTimer(adjustmentId);
    publish();
  };

  const requestDelete = (adjustmentId: string): Promise<BudgetAdjustmentFlushOutcome> => {
    const disposedError = getDisposedError(`delete budget adjustment "${adjustmentId}"`);
    if (disposedError !== null) return Promise.reject(disposedError);
    if (!reconciliation.rows.some((row): boolean => row.adjustmentId === adjustmentId)) {
      return Promise.reject(new Error(
        `Cannot delete missing budget adjustment "${adjustmentId}"`,
      ));
    }
    if (canDiscardOptimisticRow(adjustmentId)) {
      discardOptimisticRow(adjustmentId);
      return Promise.resolve("deleted");
    }
    deleteRequestedIds.add(adjustmentId);
    clearTimer(adjustmentId);
    return flushRow(adjustmentId);
  };

  const loadRange = async (
    monthFrom: string,
    monthTo: string,
  ): Promise<BudgetAdjustmentRangeLoadOutcome> => {
    const disposedError = getDisposedError(
      `load budget adjustment range ${monthFrom}..${monthTo}`,
    );
    if (disposedError !== null) throw disposedError;
    const issued = issueBudgetAdjustmentRangeRequest(reconciliation, monthFrom, monthTo);
    reconciliation = issued.state;
    const rangeKey = getRangeKey(monthFrom, monthTo);
    pendingRangeCount += 1;
    publish();
    try {
      const result = await dependencies.fetchRange(monthFrom, monthTo);
      const previousRows = reconciliation.rows;
      reconciliation = reconcileBudgetAdjustmentRangeResponse(
        reconciliation,
        issued.request,
        result.adjustments,
      );
      clearRemovedRowState(previousRows);
      clearRecoveredRangeErrors();
      for (const [adjustmentId, rowError] of rowErrors) {
        if (rowError.action !== "refresh-range"
          || reconciliation.ambiguousRangeRequirementByAdjustmentId.has(adjustmentId)) {
          continue;
        }
        const rowExists = reconciliation.rows.some((row): boolean =>
          row.adjustmentId === adjustmentId);
        const hasLocalWork = reconciliation.dirtyFieldsByAdjustmentId.has(adjustmentId)
          || deleteRequestedIds.has(adjustmentId);
        if (!rowExists || !hasLocalWork) {
          if (!rowExists) deleteRequestedIds.delete(adjustmentId);
          clearRowError(adjustmentId);
          continue;
        }
        rowErrors = new Map(rowErrors);
        rowErrors.set(adjustmentId, { ...rowError, action: "retry-save" });
      }
      const accepted = enumerateMonths(monthFrom, monthTo).every((month): boolean =>
        reconciliation.acceptedRangeRequestIdByMonth.get(month)
          === issued.request.requestId);
      return accepted ? { status: "accepted", result } : { status: "superseded" };
    } catch (error: unknown) {
      reconciliation = reconcileBudgetAdjustmentRangeFailure(reconciliation, issued.request);
      if (!isRangeFailureSuperseded(
        reconciliation,
        issued.request.requestId,
        monthFrom,
        monthTo,
      )) {
        const currentFailure = rangeFailuresByKey.get(rangeKey);
        if (currentFailure === undefined
          || currentFailure.requestId < issued.request.requestId) {
          rangeFailuresByKey = new Map(rangeFailuresByKey);
          rangeFailuresByKey.set(rangeKey, {
            error: {
              monthFrom,
              monthTo,
              message: getErrorMessage(error),
              httpStatus: getHttpStatus(error),
            },
            requestId: issued.request.requestId,
          });
        }
      }
      throw error;
    } finally {
      pendingRangeCount -= 1;
      publish();
    }
  };

  const refreshRow = (
    adjustmentId: string,
  ): Promise<BudgetAdjustmentRangeLoadOutcome> => {
    const requirement = reconciliation.ambiguousRangeRequirementByAdjustmentId.get(
      adjustmentId,
    );
    if (requirement !== undefined) {
      return loadRange(
        requirement.sourceMonth < requirement.targetMonth
          ? requirement.sourceMonth
          : requirement.targetMonth,
        requirement.sourceMonth > requirement.targetMonth
          ? requirement.sourceMonth
          : requirement.targetMonth,
      );
    }
    const row = reconciliation.rows.find((candidate): boolean =>
      candidate.adjustmentId === adjustmentId);
    if (row === undefined) {
      return Promise.reject(new Error(
        `Cannot refresh missing budget adjustment "${adjustmentId}"`,
      ));
    }
    const parsed = parseBudgetAdjustmentDraft(row.draft, dependencies.planFrom);
    const draftMonth = parsed.ok ? parsed.snapshot.month : row.confirmed.month;
    const monthFrom = row.confirmed.month < draftMonth
      ? row.confirmed.month
      : draftMonth;
    const monthTo = row.confirmed.month > draftMonth
      ? row.confirmed.month
      : draftMonth;
    return loadRange(monthFrom, monthTo);
  };

  const recoverRow = (
    adjustmentId: string,
  ): Promise<BudgetAdjustmentRecoveryOutcome> => {
    const disposedError = getDisposedError(`recover budget adjustment "${adjustmentId}"`);
    if (disposedError !== null) return Promise.reject(disposedError);
    const active = activeRecoveries.get(adjustmentId);
    if (active !== undefined) return active;

    const promise = Promise.resolve()
      .then(async (): Promise<BudgetAdjustmentRecoveryOutcome> => {
        const rowError = rowErrors.get(adjustmentId);
        if (rowError?.action === "refresh-range") {
          const rangeOutcome = await refreshRow(adjustmentId);
          if (rangeOutcome.status !== "accepted") return "unsuccessful";
          const rowExists = rangeOutcome.result.adjustments.some(
            (adjustment): boolean => adjustment.adjustmentId === adjustmentId,
          );
          if (!rowExists) return "recovered";
        }

        const flushOutcome = await flushRow(adjustmentId);
        return flushOutcome === "saved"
          || flushOutcome === "unchanged"
          || flushOutcome === "deleted"
          ? "recovered"
          : "unsuccessful";
      })
      .finally((): void => {
        if (activeRecoveries.get(adjustmentId) !== promise) return;
        activeRecoveries.delete(adjustmentId);
        publish();
      });
    activeRecoveries.set(adjustmentId, promise);
    publish();
    return promise;
  };

  const getVisibleRows = (
    effectiveAllowlist: ReadonlySet<string> | null,
  ): ReadonlyArray<BudgetAdjustmentEditorRow> => reconciliation.rows.filter(
    (row): boolean => isBudgetAdjustmentRowVisible(row, effectiveAllowlist),
  );

  const getCellRows = (
    location: BudgetAdjustmentCellLocation,
    effectiveAllowlist: ReadonlySet<string> | null,
  ): ReadonlyArray<BudgetAdjustmentEditorRow> => getBudgetAdjustmentCellRows(
    getVisibleRows(effectiveAllowlist),
    location.month,
    location.direction,
    location.category,
    dependencies.planFrom,
  );

  const getRow = (
    adjustmentId: string,
    effectiveAllowlist: ReadonlySet<string> | null,
  ): BudgetAdjustmentEditorRow | null =>
    getVisibleRows(effectiveAllowlist).find(
      (row): boolean => row.adjustmentId === adjustmentId,
    ) ?? null;

  const getCellTotal = (
    location: BudgetAdjustmentCellLocation,
    effectiveAllowlist: ReadonlySet<string> | null,
  ): number =>
    getBudgetAdjustmentCellTotal(
      getVisibleRows(effectiveAllowlist),
      location.month,
      location.direction,
      location.category,
      dependencies.planFrom,
    );

  const retainCell = (
    ownerId: string,
    location: BudgetAdjustmentCellLocation,
  ): (() => void) => {
    const disposedError = getDisposedError(
      `retain budget adjustment cell ${location.month}/${location.direction}/${location.category}`,
    );
    if (disposedError !== null) throw disposedError;
    if (ownerId.length === 0) {
      throw new RangeError("Budget adjustment cell ownerId must not be empty");
    }

    const lease = Symbol(ownerId);
    protectedCellOwners.set(ownerId, {
      cell: { ...location },
      lease,
    });
    publish();

    return (): void => {
      if (protectedCellOwners.get(ownerId)?.lease !== lease) return;
      protectedCellOwners.delete(ownerId);
      publish();
    };
  };

  const applyToBudgetRows = (
    budgetRows: ReadonlyArray<BudgetRow>,
    loadedFrom: string,
    loadedTo: string,
    effectiveAllowlist: ReadonlySet<string> | null,
  ): ReadonlyArray<BudgetRow> => applyBudgetAdjustmentRowsWithProtectedCells(
    budgetRows,
    getVisibleRows(effectiveAllowlist),
    loadedFrom,
    loadedTo,
    dependencies.planFrom,
    getBudgetAdjustmentInvalidatedCellKeys(reconciliation),
    [...protectedCellOwners.values()].map(
      (owner): ProtectedBudgetAdjustmentCell => owner.cell,
    ),
    effectiveAllowlist,
  );

  const commands: BudgetAdjustmentRowsControllerCommands = {
    addRow,
    replaceDraft,
    flushRow,
    recoverRow,
    requestDelete,
    loadRange,
    refreshRow,
    getRow,
    getCellRows,
    getCellTotal,
    retainCell,
    applyToBudgetRows,
  };

  return {
    getSnapshot: (): BudgetAdjustmentRowsControllerState => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    commands,
    activate: (): void => {
      if (!disposed) return;
      if (suspendedInvalidationYears.size > 0) {
        dependencies.invalidateYears(new Set(suspendedInvalidationYears));
        suspendedInvalidationYears.clear();
      }
      disposed = false;
      const autosaveIds = [...suspendedAutosaveIds];
      suspendedAutosaveIds.clear();
      for (const adjustmentId of autosaveIds) {
        if (activeFlushes.has(adjustmentId)) continue;
        if (canScheduleAutosave(adjustmentId)) scheduleAutosave(adjustmentId);
      }
      publish();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const [adjustmentId, handle] of timers) {
        suspendedAutosaveIds.add(adjustmentId);
        dependencies.cancelScheduled(handle);
      }
      timers.clear();
      publish();
      listeners.clear();
    },
  };
};
