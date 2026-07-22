import type {
  BudgetAdjustmentDirection,
  CreateBudgetAdjustmentParams,
  PatchBudgetAdjustmentParams,
} from "@/server/budget/budgetAdjustments";
import {
  issueBudgetAdjustmentRangeRequest as issueRangeRequest,
  reconcileBudgetAdjustmentRangeFailure as reconcileRangeFailure,
  reconcileBudgetAdjustmentRangeResponse as reconcileRangeResponse,
  replaceBudgetAdjustmentRangeDraft,
  createBudgetAdjustmentRangeReconciliationState,
  type BudgetAdjustmentRangeDirtyFields,
  type BudgetAdjustmentRangeProvenance,
  type BudgetAdjustmentRangeReconciliationState,
  type BudgetAdjustmentRangeRequest as BaseRangeRequest,
} from "@/ui/tables/budget/budgetAdjustmentRangeReconciliation";
import {
  parseBudgetAdjustment,
  parseBudgetAdjustmentUuid,
  type DeleteBudgetAdjustmentOutcome,
} from "@/ui/tables/budget/budgetTableApi";
import {
  budgetAdjustmentNoteFromInput,
  budgetAdjustmentNoteToInput,
  clearBudgetAdjustmentCellInvalidations,
  createBudgetAdjustmentEditorRow,
  getBudgetAdjustmentCellKey,
  parseBudgetAdjustmentAmount,
  parseBudgetAdjustmentDraft,
  recordBudgetAdjustmentCellInvalidation,
  recordBudgetAdjustmentCellMove,
  sortBudgetAdjustmentRows,
  type BudgetAdjustmentDraft,
  type BudgetAdjustmentEditorRow,
  type BudgetAdjustmentSnapshot,
} from "@/ui/tables/budget/budgetAdjustmentRowsState";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const RECENT_SETTLED_MUTATION_LIMIT = 8;
const OPTIMISTIC_ROW_TIMESTAMP = "9999-12-31T23:59:59.999Z";

export type BudgetAdjustmentRangeRequest = Readonly<{
  kind: "range";
  requestId: number;
  monthFrom: string;
  monthTo: string;
  mutationRevision: number;
}>;

export type BudgetAdjustmentCreateRequest = Readonly<{
  kind: "create";
  requestId: number;
  adjustmentId: string;
  direction: BudgetAdjustmentDirection;
  draft: BudgetAdjustmentDraft;
  params: CreateBudgetAdjustmentParams;
  mutationRevision: number;
}>;

export type BudgetAdjustmentPatchRequest = Readonly<{
  kind: "patch";
  requestId: number;
  adjustmentId: string;
  direction: BudgetAdjustmentDirection;
  draft: BudgetAdjustmentDraft;
  requested: BudgetAdjustmentSnapshot;
  baseline: BudgetAdjustmentSnapshot;
  params: PatchBudgetAdjustmentParams;
  mutationRevision: number;
}>;

export type BudgetAdjustmentDeleteRequest = Readonly<{
  kind: "delete";
  requestId: number;
  adjustmentId: string;
  direction: BudgetAdjustmentDirection;
  confirmed: BudgetAdjustmentSnapshot;
  mutationRevision: number;
}>;

export type BudgetAdjustmentMutationRequest =
  BudgetAdjustmentCreateRequest
  | BudgetAdjustmentPatchRequest
  | BudgetAdjustmentDeleteRequest;

export type BudgetAdjustmentReconciliationRequest = BudgetAdjustmentRangeRequest | BudgetAdjustmentMutationRequest;

export type BudgetAdjustmentAmbiguousRangeRequirement = Readonly<{
  afterRequestId: number;
  sourceMonth: string;
  targetMonth: string;
}>;

export type BudgetAdjustmentOptimisticCreate = Readonly<{
  status: "ready" | "pending" | "failed";
  draft: BudgetAdjustmentDraft;
  params: CreateBudgetAdjustmentParams;
}>;

export type BudgetAdjustmentRowsReconciliationState =
  BudgetAdjustmentRangeReconciliationState & Readonly<{
    planFrom: string;
    latestMutationRequestId: number;
    latestMutationRevision: number;
    confirmedMutationRevisionById: ReadonlyMap<string, number>;
    deletedMutationRevisionById: ReadonlyMap<string, number>;
    cellInvalidationRevisionByKey: ReadonlyMap<string, number>;
    rangeInvalidationRequestIdByCellKey: ReadonlyMap<string, number>;
    mutationRequestsById: ReadonlyMap<number, BudgetAdjustmentMutationRequest>;
    settledMutationRequestIds: ReadonlySet<number>;
    appliedCreateRequestIds: ReadonlySet<number>;
    appliedDeleteRequestIds: ReadonlySet<number>;
    optimisticCreateByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentOptimisticCreate>;
    latestCreateRequestIdByAdjustmentId: ReadonlyMap<string, number>;
    latestPatchRequestIdByAdjustmentId: ReadonlyMap<string, number>;
    latestDeleteRequestIdByAdjustmentId: ReadonlyMap<string, number>;
    ambiguousRangeRequirementByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentAmbiguousRangeRequirement>;
    rangeMutationRevisionByRequestId: ReadonlyMap<number, number>;
  }>;

export type IssuedBudgetAdjustmentRequest<Request extends BudgetAdjustmentReconciliationRequest> = Readonly<{
  state: BudgetAdjustmentRowsReconciliationState;
  request: Request;
}>;

export type BudgetAdjustmentPatchAcknowledgement = Readonly<{
  state: BudgetAdjustmentRowsReconciliationState;
  outcome: "accepted" | "stale";
}>;

export type BudgetAdjustmentCreateAcknowledgement = Readonly<{
  state: BudgetAdjustmentRowsReconciliationState;
  outcome: "accepted" | "already-applied" | "stale";
}>;

export type BudgetAdjustmentDeleteAcknowledgement = Readonly<{
  state: BudgetAdjustmentRowsReconciliationState;
  outcome: "applied" | "already-applied" | "stale";
}>;

const validateMonth = (month: string, context: string): void => {
  if (!MONTH_PATTERN.test(month)) {
    throw new RangeError(`${context} must use YYYY-MM with a valid month; received "${month}"`);
  }
};

const validateRequestId = (requestId: number, context: string): void => {
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    throw new RangeError(`${context} must be a positive safe integer; received ${String(requestId)}`);
  }
};

const snapshotsEqual = (
  left: BudgetAdjustmentSnapshot,
  right: BudgetAdjustmentSnapshot,
): boolean => Object.keys(left).length === 4
  && Object.keys(right).length === 4
  && left.amount === right.amount
  && left.note === right.note
  && left.month === right.month
  && left.category === right.category;

const draftsEqual = (
  left: BudgetAdjustmentDraft,
  right: BudgetAdjustmentDraft,
): boolean => Object.keys(left).length === 4
  && Object.keys(right).length === 4
  && left.amountInput === right.amountInput
  && left.noteInput === right.noteInput
  && left.month === right.month
  && left.category === right.category;

const paramsEqual = (
  left: PatchBudgetAdjustmentParams,
  right: PatchBudgetAdjustmentParams,
): boolean => Object.keys(left).length === Object.keys(right).length
  && left.amount === right.amount
  && left.note === right.note
  && left.month === right.month
  && left.category === right.category;

const createParamsEqual = (
  left: CreateBudgetAdjustmentParams,
  right: CreateBudgetAdjustmentParams,
): boolean => Object.keys(left).length === 6
  && Object.keys(right).length === 6
  && left.adjustmentId === right.adjustmentId
  && left.month === right.month
  && left.direction === right.direction
  && left.category === right.category
  && left.amount === right.amount
  && left.note === right.note;

const mutationRequestsEqual = (
  left: BudgetAdjustmentMutationRequest,
  right: BudgetAdjustmentMutationRequest,
): boolean => {
  if (
    left.kind !== right.kind
    || left.requestId !== right.requestId
    || left.adjustmentId !== right.adjustmentId
    || left.direction !== right.direction
    || left.mutationRevision !== right.mutationRevision
    || Object.keys(left).length !== Object.keys(right).length
  ) return false;
  if (left.kind === "create" && right.kind === "create") {
    return draftsEqual(left.draft, right.draft)
      && createParamsEqual(left.params, right.params);
  }
  if (left.kind === "patch" && right.kind === "patch") {
    return draftsEqual(left.draft, right.draft)
      && snapshotsEqual(left.requested, right.requested)
      && snapshotsEqual(left.baseline, right.baseline)
      && paramsEqual(left.params, right.params);
  }
  return left.kind === "delete"
    && right.kind === "delete"
    && snapshotsEqual(left.confirmed, right.confirmed);
};

const getRangeState = (
  state: BudgetAdjustmentRowsReconciliationState,
): BudgetAdjustmentRangeReconciliationState => ({
  rows: state.rows,
  latestRequestId: state.latestRequestId,
  acceptedRangeRequestIdByMonth: state.acceptedRangeRequestIdByMonth,
  rangeProvenanceByAdjustmentId: state.rangeProvenanceByAdjustmentId,
  dirtyFieldsByAdjustmentId: state.dirtyFieldsByAdjustmentId,
  requestsById: state.requestsById,
  settledRequestIds: state.settledRequestIds,
});

const replaceRangeState = (
  state: BudgetAdjustmentRowsReconciliationState,
  rangeState: BudgetAdjustmentRangeReconciliationState,
): BudgetAdjustmentRowsReconciliationState => ({ ...state, ...rangeState });

const getNextMutationRequestId = (
  state: BudgetAdjustmentRowsReconciliationState,
): number => {
  if (!Number.isSafeInteger(state.latestMutationRequestId) || state.latestMutationRequestId < 0) {
    throw new RangeError(
      `Cannot issue budget adjustment mutation: latest request id must be a non-negative safe integer; received ${String(state.latestMutationRequestId)}`,
    );
  }
  if (state.latestMutationRequestId === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Cannot issue another budget adjustment mutation: request id limit reached");
  }
  return state.latestMutationRequestId + 1;
};

const getNextMutationRevision = (
  state: BudgetAdjustmentRowsReconciliationState,
): number => {
  if (!Number.isSafeInteger(state.latestMutationRevision) || state.latestMutationRevision < 0) {
    throw new RangeError(
      `Cannot confirm budget adjustment mutation: latest revision must be a non-negative safe integer; received ${String(state.latestMutationRevision)}`,
    );
  }
  if (state.latestMutationRevision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Cannot confirm budget adjustment mutation: revision limit reached");
  }
  return state.latestMutationRevision + 1;
};

const requireRow = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
  operation: string,
): BudgetAdjustmentEditorRow => {
  const row = state.rows.find((candidate) => candidate.adjustmentId === adjustmentId);
  if (row === undefined) {
    throw new Error(`Cannot ${operation} missing budget adjustment "${adjustmentId}"`);
  }
  return row;
};

const addMutationRequest = <Request extends BudgetAdjustmentMutationRequest>(
  state: BudgetAdjustmentRowsReconciliationState,
  request: Request,
): BudgetAdjustmentRowsReconciliationState => {
  const mutationRequestsById = new Map(state.mutationRequestsById);
  mutationRequestsById.set(request.requestId, request);
  return { ...state, latestMutationRequestId: request.requestId, mutationRequestsById };
};

const pruneMutationLifecycle = (
  state: BudgetAdjustmentRowsReconciliationState,
): BudgetAdjustmentRowsReconciliationState => {
  const pendingRangeRevisions = [...state.requestsById]
    .filter(([requestId]): boolean => !state.settledRequestIds.has(requestId))
    .map(([requestId]): number => {
      const revision = state.rangeMutationRevisionByRequestId.get(requestId);
      if (revision === undefined) {
        throw new Error(`Cannot prune mutation lifecycle: pending range request ${requestId} has no captured mutation revision`);
      }
      return revision;
    });
  const deletedMutationRevisionById = new Map(state.deletedMutationRevisionById);
  for (const [adjustmentId, revision] of deletedMutationRevisionById) {
    if (pendingRangeRevisions.every((pendingRevision) => pendingRevision >= revision)) {
      deletedMutationRevisionById.delete(adjustmentId);
    }
  }
  const appliedDeleteRequestIds = new Set([...state.appliedDeleteRequestIds]
    .filter((requestId): boolean => state.mutationRequestsById.has(requestId)));
  const appliedCreateRequestIds = new Set([...state.appliedCreateRequestIds]
    .filter((requestId): boolean => state.mutationRequestsById.has(requestId)));
  if (deletedMutationRevisionById.size === state.deletedMutationRevisionById.size
    && appliedCreateRequestIds.size === state.appliedCreateRequestIds.size
    && appliedDeleteRequestIds.size === state.appliedDeleteRequestIds.size) return state;
  return {
    ...state,
    deletedMutationRevisionById,
    appliedCreateRequestIds,
    appliedDeleteRequestIds,
  };
};

const settleMutationRequest = (
  state: BudgetAdjustmentRowsReconciliationState,
  requestId: number,
): BudgetAdjustmentRowsReconciliationState => {
  if (state.settledMutationRequestIds.has(requestId)) return state;
  const mutationRequestsById = new Map(state.mutationRequestsById);
  const settledMutationRequestIds = new Set(state.settledMutationRequestIds);
  settledMutationRequestIds.add(requestId);
  while (settledMutationRequestIds.size > RECENT_SETTLED_MUTATION_LIMIT) {
    const expiredRequestId = Math.min(...settledMutationRequestIds);
    settledMutationRequestIds.delete(expiredRequestId);
    mutationRequestsById.delete(expiredRequestId);
  }
  return pruneMutationLifecycle({ ...state, mutationRequestsById, settledMutationRequestIds });
};

const requireMutationRequest = <Kind extends BudgetAdjustmentMutationRequest["kind"]>(
  state: BudgetAdjustmentRowsReconciliationState,
  request: Extract<BudgetAdjustmentMutationRequest, Readonly<{ kind: Kind }>>,
  kind: Kind,
): Extract<BudgetAdjustmentMutationRequest, Readonly<{ kind: Kind }>> => {
  validateRequestId(request.requestId, `Budget adjustment ${kind} request id`);
  const stored = state.mutationRequestsById.get(request.requestId);
  if (stored === undefined) {
    const reason = request.requestId <= state.latestMutationRequestId
      ? "it fell outside the recent settled request history"
      : "the request was not issued by this state";
    throw new Error(`Cannot acknowledge budget adjustment ${kind} request ${request.requestId}: ${reason}`);
  }
  if (stored.kind !== kind) {
    throw new Error(
      `Cannot acknowledge budget adjustment ${kind} request ${request.requestId}: it was issued as ${stored.kind}`,
    );
  }
  if (!mutationRequestsEqual(stored, request)) {
    throw new Error(
      `Cannot acknowledge budget adjustment ${kind} request ${request.requestId}: request fields do not match the issued request`,
    );
  }
  return stored as Extract<BudgetAdjustmentMutationRequest, Readonly<{ kind: Kind }>>;
};

const getDirtyFields = (
  row: BudgetAdjustmentEditorRow,
): BudgetAdjustmentRangeDirtyFields => {
  const amount = parseBudgetAdjustmentAmount(row.draft.amountInput);
  return {
    amount: !amount.ok || amount.amount !== row.confirmed.amount,
    note: budgetAdjustmentNoteFromInput(row.draft.noteInput) !== row.confirmed.note,
    month: row.draft.month !== row.confirmed.month,
    category: row.draft.category !== row.confirmed.category,
  };
};

const hasDirtyFields = (fields: BudgetAdjustmentRangeDirtyFields): boolean =>
  fields.amount || fields.note || fields.month || fields.category;

const replaceDirtyFields = (
  current: ReadonlyMap<string, BudgetAdjustmentRangeDirtyFields>,
  row: BudgetAdjustmentEditorRow,
): ReadonlyMap<string, BudgetAdjustmentRangeDirtyFields> => {
  const next = new Map(current);
  const fields = getDirtyFields(row);
  if (hasDirtyFields(fields)) next.set(row.adjustmentId, fields);
  else next.delete(row.adjustmentId);
  return next;
};

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

export const createBudgetAdjustmentRowsReconciliationState = (
  adjustments: ReadonlyArray<unknown>,
  planFrom: string,
): BudgetAdjustmentRowsReconciliationState => {
  validateMonth(planFrom, "Budget adjustment plan boundary");
  return {
    ...createBudgetAdjustmentRangeReconciliationState(adjustments),
    planFrom,
    latestMutationRequestId: 0,
    latestMutationRevision: 0,
    confirmedMutationRevisionById: new Map(),
    deletedMutationRevisionById: new Map(),
    cellInvalidationRevisionByKey: new Map(),
    rangeInvalidationRequestIdByCellKey: new Map(),
    mutationRequestsById: new Map(),
    settledMutationRequestIds: new Set(),
    appliedCreateRequestIds: new Set(),
    appliedDeleteRequestIds: new Set(),
    optimisticCreateByAdjustmentId: new Map(),
    latestCreateRequestIdByAdjustmentId: new Map(),
    latestPatchRequestIdByAdjustmentId: new Map(),
    latestDeleteRequestIdByAdjustmentId: new Map(),
    ambiguousRangeRequirementByAdjustmentId: new Map(),
    rangeMutationRevisionByRequestId: new Map(),
  };
};

const createOptimisticRangeProvenance = (
  direction: BudgetAdjustmentDirection,
  month: string,
  requestId: number,
): BudgetAdjustmentRangeProvenance => ({
  direction,
  presenceRequestIdByMonth: new Map([[month, requestId]]),
  absenceRequestIdByMonth: new Map(),
  deletedThroughRequestId: null,
});

export const addOptimisticBudgetAdjustmentRow = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
  month: string,
  direction: BudgetAdjustmentDirection,
  category: string,
): BudgetAdjustmentRowsReconciliationState => {
  const parsedAdjustmentId = parseBudgetAdjustmentUuid(
    adjustmentId,
    "Optimistic budget adjustment ID",
  );
  if (direction !== "income" && direction !== "spend") {
    throw new Error(
      `Cannot add optimistic budget adjustment "${parsedAdjustmentId}": direction must be income or spend`,
    );
  }
  if (state.rows.some((row) => row.adjustmentId === parsedAdjustmentId)) {
    throw new Error(
      `Cannot add optimistic budget adjustment "${parsedAdjustmentId}": the ID already exists`,
    );
  }

  const draft: BudgetAdjustmentDraft = {
    amountInput: "",
    noteInput: "",
    month,
    category,
  };
  const parsed = parseBudgetAdjustmentDraft(draft, state.planFrom);
  if (!parsed.ok) {
    throw new Error(
      `Cannot add optimistic budget adjustment "${parsedAdjustmentId}": ${parsed.error.message}`,
    );
  }
  const params: CreateBudgetAdjustmentParams = {
    adjustmentId: parsedAdjustmentId,
    month: parsed.snapshot.month,
    direction,
    category: parsed.snapshot.category,
    amount: parsed.snapshot.amount,
    note: parsed.snapshot.note,
  };
  const row: BudgetAdjustmentEditorRow = {
    adjustmentId: parsedAdjustmentId,
    direction,
    draft: { ...draft },
    confirmed: { ...parsed.snapshot },
    createdAt: OPTIMISTIC_ROW_TIMESTAMP,
    updatedAt: OPTIMISTIC_ROW_TIMESTAMP,
  };
  const optimisticCreateByAdjustmentId = new Map(
    state.optimisticCreateByAdjustmentId,
  );
  optimisticCreateByAdjustmentId.set(parsedAdjustmentId, {
    status: "ready",
    draft: { ...draft },
    params: { ...params },
  });
  const rangeProvenanceByAdjustmentId = new Map(
    state.rangeProvenanceByAdjustmentId,
  );
  rangeProvenanceByAdjustmentId.set(
    parsedAdjustmentId,
    createOptimisticRangeProvenance(direction, month, state.latestRequestId),
  );
  return {
    ...state,
    rows: sortBudgetAdjustmentRows([...state.rows, row]),
    optimisticCreateByAdjustmentId,
    rangeProvenanceByAdjustmentId,
  };
};

export const discardOptimisticBudgetAdjustmentRow = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
): BudgetAdjustmentRowsReconciliationState => {
  const optimistic = state.optimisticCreateByAdjustmentId.get(adjustmentId);
  if (optimistic === undefined) {
    throw new Error(
      `Cannot discard budget adjustment "${adjustmentId}": the row is not optimistic`,
    );
  }
  if (optimistic.status === "pending"
    || state.latestCreateRequestIdByAdjustmentId.has(adjustmentId)) {
    throw new Error(
      `Cannot discard budget adjustment "${adjustmentId}" while its create request is pending`,
    );
  }
  const optimisticCreateByAdjustmentId = new Map(
    state.optimisticCreateByAdjustmentId,
  );
  optimisticCreateByAdjustmentId.delete(adjustmentId);
  const rangeProvenanceByAdjustmentId = new Map(
    state.rangeProvenanceByAdjustmentId,
  );
  rangeProvenanceByAdjustmentId.delete(adjustmentId);
  const dirtyFieldsByAdjustmentId = new Map(state.dirtyFieldsByAdjustmentId);
  dirtyFieldsByAdjustmentId.delete(adjustmentId);
  return {
    ...state,
    rows: state.rows.filter((row): boolean => row.adjustmentId !== adjustmentId),
    optimisticCreateByAdjustmentId,
    rangeProvenanceByAdjustmentId,
    dirtyFieldsByAdjustmentId,
  };
};

export const replaceBudgetAdjustmentReconciliationDraft = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
  draft: BudgetAdjustmentDraft,
): BudgetAdjustmentRowsReconciliationState => replaceRangeState(
  state,
  replaceBudgetAdjustmentRangeDraft(
    getRangeState(state),
    adjustmentId,
    { ...draft },
  ),
);

export const getBudgetAdjustmentInvalidatedCellKeys = (
  state: BudgetAdjustmentRowsReconciliationState,
): ReadonlySet<string> => {
  const keys = new Set([
    ...state.cellInvalidationRevisionByKey.keys(),
    ...state.rangeInvalidationRequestIdByCellKey.keys(),
  ]);
  for (const row of state.rows) {
    if (
      row.draft.month !== row.confirmed.month
      || row.draft.category !== row.confirmed.category
    ) {
      keys.add(getBudgetAdjustmentCellKey(
        row.confirmed.month,
        row.direction,
        row.confirmed.category,
      ));
    }
  }
  return keys;
};

export const issueBudgetAdjustmentRangeRequest = (
  state: BudgetAdjustmentRowsReconciliationState,
  monthFrom: string,
  monthTo: string,
): IssuedBudgetAdjustmentRequest<BudgetAdjustmentRangeRequest> => {
  const issued = issueRangeRequest(getRangeState(state), monthFrom, monthTo);
  const rangeMutationRevisionByRequestId = new Map(state.rangeMutationRevisionByRequestId);
  rangeMutationRevisionByRequestId.set(issued.request.requestId, state.latestMutationRevision);
  return {
    state: {
      ...replaceRangeState(state, issued.state),
      rangeMutationRevisionByRequestId,
    },
    request: {
      kind: "range",
      ...issued.request,
      mutationRevision: state.latestMutationRevision,
    },
  };
};

const requireRangeRequest = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentRangeRequest,
): BaseRangeRequest => {
  validateRequestId(request.requestId, "Budget adjustment range request id");
  if (request.kind !== "range" || Object.keys(request).length !== 5) {
    throw new Error(`Cannot acknowledge budget adjustment range request ${request.requestId}: invalid request shape`);
  }
  const revision = state.rangeMutationRevisionByRequestId.get(request.requestId);
  if (revision === undefined) {
    const reason = request.requestId <= state.latestRequestId
      ? "it fell outside the recent settled request history"
      : "the request was not issued by this state";
    throw new Error(`Cannot acknowledge budget adjustment range request ${request.requestId}: ${reason}`);
  }
  if (revision !== request.mutationRevision) {
    throw new Error(
      `Cannot acknowledge budget adjustment range request ${request.requestId}: mutation revision does not match the issued request`,
    );
  }
  return {
    requestId: request.requestId,
    monthFrom: request.monthFrom,
    monthTo: request.monthTo,
  };
};

const pruneRangeRevisionHistory = (
  current: ReadonlyMap<number, number>,
  rangeState: BudgetAdjustmentRangeReconciliationState,
): ReadonlyMap<number, number> => new Map([...current]
  .filter(([requestId]): boolean => rangeState.requestsById.has(requestId)));

export const reconcileBudgetAdjustmentRangeFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentRangeRequest,
): BudgetAdjustmentRowsReconciliationState => {
  const failed = reconcileRangeFailure(getRangeState(state), requireRangeRequest(state, request));
  return pruneMutationLifecycle({
    ...replaceRangeState(state, failed),
    rangeMutationRevisionByRequestId: pruneRangeRevisionHistory(
      state.rangeMutationRevisionByRequestId,
      failed,
    ),
  });
};

export const issueBudgetAdjustmentCreateRequest = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
): IssuedBudgetAdjustmentRequest<BudgetAdjustmentCreateRequest> => {
  const row = requireRow(state, adjustmentId, "create");
  const optimistic = state.optimisticCreateByAdjustmentId.get(adjustmentId);
  if (optimistic === undefined) {
    throw new Error(
      `Cannot create budget adjustment "${adjustmentId}": the row is not optimistic`,
    );
  }
  if (optimistic.status === "pending") {
    throw new Error(
      `Cannot issue a second create for budget adjustment "${adjustmentId}" while its create request is pending`,
    );
  }
  if (row.direction !== optimistic.params.direction) {
    throw new Error(
      `Cannot create budget adjustment "${adjustmentId}": row direction does not match its immutable create payload`,
    );
  }
  const request: BudgetAdjustmentCreateRequest = {
    kind: "create",
    requestId: getNextMutationRequestId(state),
    adjustmentId,
    direction: row.direction,
    draft: { ...optimistic.draft },
    params: { ...optimistic.params },
    mutationRevision: state.latestMutationRevision,
  };
  const optimisticCreateByAdjustmentId = new Map(
    state.optimisticCreateByAdjustmentId,
  );
  optimisticCreateByAdjustmentId.set(adjustmentId, {
    ...optimistic,
    status: "pending",
  });
  const latestCreateRequestIdByAdjustmentId = new Map(
    state.latestCreateRequestIdByAdjustmentId,
  );
  latestCreateRequestIdByAdjustmentId.set(adjustmentId, request.requestId);
  return {
    state: {
      ...addMutationRequest(state, request),
      optimisticCreateByAdjustmentId,
      latestCreateRequestIdByAdjustmentId,
    },
    request,
  };
};

export const buildBudgetAdjustmentPatch = (
  requested: BudgetAdjustmentSnapshot,
  baseline: BudgetAdjustmentSnapshot,
): PatchBudgetAdjustmentParams => {
  const params: {
    amount?: number;
    note?: string | null;
    month?: string;
    category?: string;
  } = {};
  if (requested.amount !== baseline.amount) params.amount = requested.amount;
  if (requested.note !== baseline.note) params.note = requested.note;
  if (requested.month !== baseline.month) params.month = requested.month;
  if (requested.category !== baseline.category) params.category = requested.category;
  return params;
};

const hasPatchFields = (params: PatchBudgetAdjustmentParams): boolean =>
  params.amount !== undefined
  || params.note !== undefined
  || params.month !== undefined
  || params.category !== undefined;

export const issueBudgetAdjustmentPatchRequest = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
): IssuedBudgetAdjustmentRequest<BudgetAdjustmentPatchRequest> => {
  const row = requireRow(state, adjustmentId, "patch");
  const optimisticCreate = state.optimisticCreateByAdjustmentId.get(adjustmentId);
  if (optimisticCreate !== undefined) {
    throw new Error(
      `Cannot patch budget adjustment "${adjustmentId}" until its create request is acknowledged; create status is ${optimisticCreate.status}`,
    );
  }
  if (state.latestDeleteRequestIdByAdjustmentId.has(adjustmentId)) {
    throw new Error(`Cannot patch budget adjustment "${adjustmentId}" while its delete request is pending`);
  }
  if (state.latestPatchRequestIdByAdjustmentId.has(adjustmentId)) {
    throw new Error(`Cannot issue a second patch for budget adjustment "${adjustmentId}" while its patch request is pending`);
  }
  if (state.ambiguousRangeRequirementByAdjustmentId.has(adjustmentId)) {
    throw new Error(
      `Cannot patch budget adjustment "${adjustmentId}" until a range issued after its ambiguous failure is reconciled`,
    );
  }
  const parsed = parseBudgetAdjustmentDraft(row.draft, state.planFrom);
  if (!parsed.ok) {
    throw new Error(`Cannot patch budget adjustment "${adjustmentId}": ${parsed.error.message}`);
  }
  const params = buildBudgetAdjustmentPatch(parsed.snapshot, row.confirmed);
  if (!hasPatchFields(params)) {
    throw new Error(`Cannot patch budget adjustment "${adjustmentId}" without changed fields`);
  }
  const request: BudgetAdjustmentPatchRequest = {
    kind: "patch",
    requestId: getNextMutationRequestId(state),
    adjustmentId,
    direction: row.direction,
    draft: { ...row.draft },
    requested: { ...parsed.snapshot },
    baseline: { ...row.confirmed },
    params,
    mutationRevision: state.latestMutationRevision,
  };
  const latestPatchRequestIdByAdjustmentId = new Map(
    state.latestPatchRequestIdByAdjustmentId,
  );
  latestPatchRequestIdByAdjustmentId.set(adjustmentId, request.requestId);
  return {
    state: {
      ...addMutationRequest(state, request),
      latestPatchRequestIdByAdjustmentId,
    },
    request,
  };
};

export const issueBudgetAdjustmentDeleteRequest = (
  state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string,
): IssuedBudgetAdjustmentRequest<BudgetAdjustmentDeleteRequest> => {
  const row = requireRow(state, adjustmentId, "delete");
  const optimisticCreate = state.optimisticCreateByAdjustmentId.get(adjustmentId);
  if (optimisticCreate !== undefined) {
    throw new Error(
      `Cannot delete budget adjustment "${adjustmentId}" until its create request is acknowledged; create status is ${optimisticCreate.status}`,
    );
  }
  if (state.latestPatchRequestIdByAdjustmentId.has(adjustmentId)) {
    throw new Error(`Cannot delete budget adjustment "${adjustmentId}" while its patch request is pending`);
  }
  if (state.latestDeleteRequestIdByAdjustmentId.has(adjustmentId)) {
    throw new Error(`Cannot issue a second delete for budget adjustment "${adjustmentId}" while its delete request is pending`);
  }
  if (state.ambiguousRangeRequirementByAdjustmentId.has(adjustmentId)) {
    throw new Error(
      `Cannot delete budget adjustment "${adjustmentId}" until a range issued after its ambiguous failure is reconciled`,
    );
  }
  const request: BudgetAdjustmentDeleteRequest = {
    kind: "delete",
    requestId: getNextMutationRequestId(state),
    adjustmentId,
    direction: row.direction,
    confirmed: { ...row.confirmed },
    mutationRevision: state.latestMutationRevision,
  };
  const latestDeleteRequestIdByAdjustmentId = new Map(
    state.latestDeleteRequestIdByAdjustmentId,
  );
  latestDeleteRequestIdByAdjustmentId.set(adjustmentId, request.requestId);
  return {
    state: {
      ...addMutationRequest(state, request),
      latestDeleteRequestIdByAdjustmentId,
    },
    request,
  };
};

const getRangeProtectedIds = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentRangeRequest,
  resolvedAmbiguityIds: ReadonlySet<string>,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const adjustmentId of state.optimisticCreateByAdjustmentId.keys()) ids.add(adjustmentId);
  for (const adjustmentId of state.latestPatchRequestIdByAdjustmentId.keys()) ids.add(adjustmentId);
  for (const adjustmentId of state.latestDeleteRequestIdByAdjustmentId.keys()) ids.add(adjustmentId);
  for (const [adjustmentId, revision] of state.confirmedMutationRevisionById) {
    if (revision > request.mutationRevision) ids.add(adjustmentId);
  }
  for (const [adjustmentId, revision] of state.deletedMutationRevisionById) {
    if (revision > request.mutationRevision) ids.add(adjustmentId);
  }
  for (const adjustmentId of state.ambiguousRangeRequirementByAdjustmentId.keys()) {
    if (!resolvedAmbiguityIds.has(adjustmentId)) ids.add(adjustmentId);
  }
  return ids;
};

const restoreProtectedRangeData = (
  state: BudgetAdjustmentRowsReconciliationState,
  delegated: BudgetAdjustmentRangeReconciliationState,
  protectedIds: ReadonlySet<string>,
): BudgetAdjustmentRangeReconciliationState => {
  const originalRowsById = new Map(state.rows
    .filter((row): boolean => protectedIds.has(row.adjustmentId))
    .map((row): readonly [string, BudgetAdjustmentEditorRow] => [row.adjustmentId, row]));
  const rows = delegated.rows.filter((row): boolean => !protectedIds.has(row.adjustmentId));
  rows.push(...originalRowsById.values());
  const rangeProvenanceByAdjustmentId = new Map(delegated.rangeProvenanceByAdjustmentId);
  const dirtyFieldsByAdjustmentId = new Map(delegated.dirtyFieldsByAdjustmentId);
  for (const adjustmentId of protectedIds) {
    const provenance = state.rangeProvenanceByAdjustmentId.get(adjustmentId);
    const dirtyFields = state.dirtyFieldsByAdjustmentId.get(adjustmentId);
    if (provenance === undefined) rangeProvenanceByAdjustmentId.delete(adjustmentId);
    else rangeProvenanceByAdjustmentId.set(adjustmentId, provenance);
    if (dirtyFields === undefined) dirtyFieldsByAdjustmentId.delete(adjustmentId);
    else dirtyFieldsByAdjustmentId.set(adjustmentId, dirtyFields);
  }
  return {
    ...delegated,
    rows: sortBudgetAdjustmentRows(rows),
    rangeProvenanceByAdjustmentId,
    dirtyFieldsByAdjustmentId,
  };
};

export const reconcileBudgetAdjustmentRangeResponse = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentRangeRequest,
  adjustments: ReadonlyArray<unknown>,
): BudgetAdjustmentRowsReconciliationState => {
  const delegated = reconcileRangeResponse(
    getRangeState(state),
    requireRangeRequest(state, request),
    adjustments,
  );
  const canonicalById = new Map(adjustments.map((input, index): readonly [string, BudgetAdjustmentEditorRow] => {
    const adjustment = parseBudgetAdjustment(input, `Budget adjustment range response row ${index}`);
    return [adjustment.adjustmentId, createBudgetAdjustmentEditorRow(adjustment)];
  }));
  const acceptedMonths = new Set(enumerateMonths(request.monthFrom, request.monthTo)
    .filter((month): boolean =>
      delegated.acceptedRangeRequestIdByMonth.get(month) === request.requestId
      && (state.acceptedRangeRequestIdByMonth.get(month) ?? 0) < request.requestId));
  const acceptedCanonicalIds = new Set([...canonicalById]
    .filter(([, row]): boolean => acceptedMonths.has(row.confirmed.month))
    .map(([adjustmentId]): string => adjustmentId));
  const resolvedAmbiguityIds = new Set<string>();
  for (const [adjustmentId, requirement] of state.ambiguousRangeRequirementByAdjustmentId) {
    if (
      (request.requestId > requirement.afterRequestId && acceptedCanonicalIds.has(adjustmentId))
      || ((delegated.acceptedRangeRequestIdByMonth.get(requirement.sourceMonth) ?? 0)
          > requirement.afterRequestId
        && (delegated.acceptedRangeRequestIdByMonth.get(requirement.targetMonth) ?? 0)
          > requirement.afterRequestId)
    ) resolvedAmbiguityIds.add(adjustmentId);
  }
  const protectedIds = getRangeProtectedIds(state, request, resolvedAmbiguityIds);
  const restored = restoreProtectedRangeData(state, delegated, protectedIds);
  let rows = restored.rows;
  const ambiguousRangeRequirementByAdjustmentId = new Map(
    state.ambiguousRangeRequirementByAdjustmentId,
  );
  const dirtyFieldsByAdjustmentId = new Map(restored.dirtyFieldsByAdjustmentId);
  for (const adjustmentId of resolvedAmbiguityIds) {
    if (protectedIds.has(adjustmentId)) continue;
    ambiguousRangeRequirementByAdjustmentId.delete(adjustmentId);
    if (!acceptedCanonicalIds.has(adjustmentId)) {
      rows = rows.filter((row): boolean => row.adjustmentId !== adjustmentId);
      dirtyFieldsByAdjustmentId.delete(adjustmentId);
    } else {
      const refreshed = rows.find((row) => row.adjustmentId === adjustmentId);
      if (refreshed !== undefined) {
        const fields = getDirtyFields(refreshed);
        if (hasDirtyFields(fields)) dirtyFieldsByAdjustmentId.set(adjustmentId, fields);
        else dirtyFieldsByAdjustmentId.delete(adjustmentId);
      }
    }
  }

  const rowIds = new Set(rows.map((row) => row.adjustmentId));
  for (const row of state.rows) {
    if (
      rowIds.has(row.adjustmentId)
      || !state.confirmedMutationRevisionById.has(row.adjustmentId)
      || acceptedMonths.has(row.confirmed.month)
      || acceptedCanonicalIds.has(row.adjustmentId)
    ) continue;
    rows = [...rows, row];
    rowIds.add(row.adjustmentId);
  }

  const confirmedMutationRevisionById = new Map(state.confirmedMutationRevisionById);
  for (const row of state.rows) {
    const revision = confirmedMutationRevisionById.get(row.adjustmentId);
    if (revision !== undefined && revision <= request.mutationRevision
      && acceptedMonths.has(row.confirmed.month) && !protectedIds.has(row.adjustmentId)) {
      confirmedMutationRevisionById.delete(row.adjustmentId);
    }
  }

  let cellInvalidationRevisionByKey = state.cellInvalidationRevisionByKey;
  const rangeInvalidationRequestIdByCellKey = new Map(
    state.rangeInvalidationRequestIdByCellKey,
  );
  for (const month of acceptedMonths) {
    cellInvalidationRevisionByKey = clearBudgetAdjustmentCellInvalidations(
      cellInvalidationRevisionByKey,
      month,
      month,
      request.mutationRevision,
    );
    for (const [cellKey, invalidationRequestId] of rangeInvalidationRequestIdByCellKey) {
      if (cellKey.slice(0, 7) === month && invalidationRequestId < request.requestId) {
        rangeInvalidationRequestIdByCellKey.delete(cellKey);
      }
    }
  }
  const rowsById = new Map(rows.map((row): readonly [string, BudgetAdjustmentEditorRow] => [
    row.adjustmentId,
    row,
  ]));
  for (const previous of state.rows) {
    const current = rowsById.get(previous.adjustmentId);
    if (
      protectedIds.has(previous.adjustmentId)
      || current === undefined
      || (previous.confirmed.month === current.confirmed.month
        && previous.confirmed.category === current.confirmed.category)
      || acceptedMonths.has(previous.confirmed.month)
    ) continue;
    const cellKey = getBudgetAdjustmentCellKey(
      previous.confirmed.month,
      previous.direction,
      previous.confirmed.category,
    );
    if ((rangeInvalidationRequestIdByCellKey.get(cellKey) ?? 0) < request.requestId) {
      rangeInvalidationRequestIdByCellKey.set(cellKey, request.requestId);
    }
  }
  const rangeState: BudgetAdjustmentRangeReconciliationState = {
    ...restored,
    rows: sortBudgetAdjustmentRows(rows),
    dirtyFieldsByAdjustmentId,
  };
  return pruneMutationLifecycle({
    ...replaceRangeState(state, rangeState),
    confirmedMutationRevisionById,
    cellInvalidationRevisionByKey,
    rangeInvalidationRequestIdByCellKey,
    ambiguousRangeRequirementByAdjustmentId,
    rangeMutationRevisionByRequestId: pruneRangeRevisionHistory(
      state.rangeMutationRevisionByRequestId,
      rangeState,
    ),
  });
};

const rebaseDraftAfterCreate = (
  row: BudgetAdjustmentEditorRow,
  request: BudgetAdjustmentCreateRequest,
  confirmed: BudgetAdjustmentSnapshot,
): BudgetAdjustmentDraft => {
  const amount = parseBudgetAdjustmentAmount(row.draft.amountInput);
  const hasNewerAmount = !amount.ok || amount.amount !== request.params.amount;
  return {
    amountInput: hasNewerAmount
      ? row.draft.amountInput
      : request.params.amount === confirmed.amount
        ? row.draft.amountInput
        : String(confirmed.amount),
    noteInput: budgetAdjustmentNoteFromInput(row.draft.noteInput) !== request.params.note
      ? row.draft.noteInput
      : budgetAdjustmentNoteToInput(confirmed.note),
    month: row.draft.month !== request.params.month ? row.draft.month : confirmed.month,
    category: row.draft.category !== request.params.category
      ? row.draft.category
      : confirmed.category,
  };
};

export const reconcileBudgetAdjustmentCreateAcknowledgement = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentCreateRequest,
  input: unknown,
): BudgetAdjustmentCreateAcknowledgement => {
  const issued = requireMutationRequest(state, request, "create");
  const adjustment = parseBudgetAdjustment(input, "Budget adjustment create acknowledgement");
  if (adjustment.adjustmentId !== issued.adjustmentId) {
    throw new Error(
      `Budget adjustment create acknowledgement id "${adjustment.adjustmentId}" does not match requested id "${issued.adjustmentId}"`,
    );
  }
  if (adjustment.direction !== issued.direction) {
    throw new Error(
      `Budget adjustment create acknowledgement changed immutable direction for "${issued.adjustmentId}" from ${issued.direction} to ${adjustment.direction}`,
    );
  }
  if (state.settledMutationRequestIds.has(issued.requestId)) {
    const alreadyApplied = state.appliedCreateRequestIds.has(issued.requestId)
      && state.rows.some((row) => row.adjustmentId === issued.adjustmentId);
    return { state, outcome: alreadyApplied ? "already-applied" : "stale" };
  }
  const isStale = state.latestCreateRequestIdByAdjustmentId.get(issued.adjustmentId)
    !== issued.requestId
    || (state.confirmedMutationRevisionById.get(issued.adjustmentId) ?? 0)
      > issued.mutationRevision
    || (state.deletedMutationRevisionById.get(issued.adjustmentId) ?? 0)
      > issued.mutationRevision;
  if (isStale) {
    return { state: settleMutationRequest(state, issued.requestId), outcome: "stale" };
  }
  const optimistic = state.optimisticCreateByAdjustmentId.get(issued.adjustmentId);
  if (
    optimistic === undefined
    || optimistic.status !== "pending"
    || !draftsEqual(optimistic.draft, issued.draft)
    || !createParamsEqual(optimistic.params, issued.params)
  ) {
    throw new Error(
      `Cannot acknowledge create for "${issued.adjustmentId}": optimistic create state does not match the request`,
    );
  }
  const row = requireRow(state, issued.adjustmentId, "acknowledge create for");
  if (row.direction !== issued.direction) {
    throw new Error(
      `Cannot acknowledge create for "${issued.adjustmentId}": row direction does not match the request`,
    );
  }

  const canonical = createBudgetAdjustmentEditorRow(adjustment);
  const reconciled: BudgetAdjustmentEditorRow = {
    ...canonical,
    draft: rebaseDraftAfterCreate(row, issued, canonical.confirmed),
  };
  const latestMutationRevision = getNextMutationRevision(state);
  const confirmedMutationRevisionById = new Map(state.confirmedMutationRevisionById);
  confirmedMutationRevisionById.set(issued.adjustmentId, latestMutationRevision);
  const deletedMutationRevisionById = new Map(state.deletedMutationRevisionById);
  deletedMutationRevisionById.delete(issued.adjustmentId);
  const appliedCreateRequestIds = new Set(state.appliedCreateRequestIds);
  appliedCreateRequestIds.add(issued.requestId);
  const optimisticCreateByAdjustmentId = new Map(
    state.optimisticCreateByAdjustmentId,
  );
  optimisticCreateByAdjustmentId.delete(issued.adjustmentId);
  const latestCreateRequestIdByAdjustmentId = new Map(
    state.latestCreateRequestIdByAdjustmentId,
  );
  latestCreateRequestIdByAdjustmentId.delete(issued.adjustmentId);
  const rows = sortBudgetAdjustmentRows(state.rows.map((candidate): BudgetAdjustmentEditorRow =>
    candidate.adjustmentId === issued.adjustmentId ? reconciled : candidate));
  const rangeProvenanceByAdjustmentId = new Map(state.rangeProvenanceByAdjustmentId);
  rangeProvenanceByAdjustmentId.set(
    issued.adjustmentId,
    createOptimisticRangeProvenance(
      issued.direction,
      canonical.confirmed.month,
      state.latestRequestId,
    ),
  );
  const next = settleMutationRequest({
    ...state,
    rows,
    latestMutationRevision,
    confirmedMutationRevisionById,
    deletedMutationRevisionById,
    appliedCreateRequestIds,
    optimisticCreateByAdjustmentId,
    latestCreateRequestIdByAdjustmentId,
    rangeProvenanceByAdjustmentId,
    dirtyFieldsByAdjustmentId: replaceDirtyFields(
      state.dirtyFieldsByAdjustmentId,
      reconciled,
    ),
    cellInvalidationRevisionByKey: recordBudgetAdjustmentCellInvalidation(
      state.cellInvalidationRevisionByKey,
      issued.direction,
      canonical.confirmed,
      latestMutationRevision,
    ),
  }, issued.requestId);
  return { state: next, outcome: "accepted" };
};

export const reconcileBudgetAdjustmentCreateFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentCreateRequest,
): BudgetAdjustmentRowsReconciliationState => {
  const issued = requireMutationRequest(state, request, "create");
  if (state.settledMutationRequestIds.has(issued.requestId)) {
    throw new Error(`Cannot fail settled budget adjustment create request ${issued.requestId}`);
  }
  if (state.latestCreateRequestIdByAdjustmentId.get(issued.adjustmentId)
    !== issued.requestId) {
    throw new Error(
      `Cannot fail budget adjustment create request ${issued.requestId}: it is not pending for "${issued.adjustmentId}"`,
    );
  }
  const optimistic = state.optimisticCreateByAdjustmentId.get(issued.adjustmentId);
  if (
    optimistic === undefined
    || optimistic.status !== "pending"
    || !draftsEqual(optimistic.draft, issued.draft)
    || !createParamsEqual(optimistic.params, issued.params)
  ) {
    throw new Error(
      `Cannot fail create for "${issued.adjustmentId}": optimistic create state does not match the request`,
    );
  }
  const row = requireRow(state, issued.adjustmentId, "fail create for");
  if (row.direction !== issued.direction) {
    throw new Error(
      `Cannot fail create for "${issued.adjustmentId}": row direction does not match the request`,
    );
  }
  const optimisticCreateByAdjustmentId = new Map(
    state.optimisticCreateByAdjustmentId,
  );
  optimisticCreateByAdjustmentId.set(issued.adjustmentId, {
    ...optimistic,
    status: "failed",
  });
  const latestCreateRequestIdByAdjustmentId = new Map(
    state.latestCreateRequestIdByAdjustmentId,
  );
  latestCreateRequestIdByAdjustmentId.delete(issued.adjustmentId);
  return settleMutationRequest({
    ...state,
    optimisticCreateByAdjustmentId,
    latestCreateRequestIdByAdjustmentId,
  }, issued.requestId);
};

const rebaseDraftAfterPatch = (
  row: BudgetAdjustmentEditorRow,
  request: BudgetAdjustmentPatchRequest,
  confirmed: BudgetAdjustmentSnapshot,
): BudgetAdjustmentDraft => {
  const amount = parseBudgetAdjustmentAmount(row.draft.amountInput);
  const hasNewerAmount = !amount.ok || amount.amount !== request.requested.amount;
  return {
    amountInput: hasNewerAmount
      ? row.draft.amountInput
      : amount.amount === confirmed.amount ? row.draft.amountInput : String(confirmed.amount),
    noteInput: budgetAdjustmentNoteFromInput(row.draft.noteInput) !== request.requested.note
      ? row.draft.noteInput
      : budgetAdjustmentNoteToInput(confirmed.note),
    month: row.draft.month !== request.requested.month ? row.draft.month : confirmed.month,
    category: row.draft.category !== request.requested.category
      ? row.draft.category
      : confirmed.category,
  };
};

export const reconcileBudgetAdjustmentPatchAcknowledgement = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentPatchRequest,
  input: unknown,
): BudgetAdjustmentPatchAcknowledgement => {
  const issued = requireMutationRequest(state, request, "patch");
  const adjustment = parseBudgetAdjustment(input, "Budget adjustment patch acknowledgement");
  if (adjustment.adjustmentId !== issued.adjustmentId) {
    throw new Error(
      `Budget adjustment patch acknowledgement id "${adjustment.adjustmentId}" does not match requested id "${issued.adjustmentId}"`,
    );
  }
  if (adjustment.direction !== issued.direction) {
    throw new Error(
      `Budget adjustment patch acknowledgement changed immutable direction for "${issued.adjustmentId}" from ${issued.direction} to ${adjustment.direction}`,
    );
  }
  const isStale = state.settledMutationRequestIds.has(issued.requestId)
    || state.latestPatchRequestIdByAdjustmentId.get(issued.adjustmentId) !== issued.requestId
    || (state.confirmedMutationRevisionById.get(issued.adjustmentId) ?? 0) > issued.mutationRevision
    || (state.deletedMutationRevisionById.get(issued.adjustmentId) ?? 0) > issued.mutationRevision;
  if (isStale) {
    return { state: settleMutationRequest(state, issued.requestId), outcome: "stale" };
  }
  const row = requireRow(state, issued.adjustmentId, "acknowledge patch for");
  if (row.direction !== issued.direction || !snapshotsEqual(row.confirmed, issued.baseline)) {
    throw new Error(
      `Cannot acknowledge patch for "${issued.adjustmentId}": current confirmed row does not match the request baseline`,
    );
  }
  const canonical = createBudgetAdjustmentEditorRow(adjustment);
  const reconciled: BudgetAdjustmentEditorRow = {
    ...canonical,
    draft: rebaseDraftAfterPatch(row, issued, canonical.confirmed),
  };
  const latestMutationRevision = getNextMutationRevision(state);
  const confirmedMutationRevisionById = new Map(state.confirmedMutationRevisionById);
  confirmedMutationRevisionById.set(issued.adjustmentId, latestMutationRevision);
  const deletedMutationRevisionById = new Map(state.deletedMutationRevisionById);
  deletedMutationRevisionById.delete(issued.adjustmentId);
  const latestPatchRequestIdByAdjustmentId = new Map(
    state.latestPatchRequestIdByAdjustmentId,
  );
  latestPatchRequestIdByAdjustmentId.delete(issued.adjustmentId);
  const ambiguousRangeRequirementByAdjustmentId = new Map(
    state.ambiguousRangeRequirementByAdjustmentId,
  );
  ambiguousRangeRequirementByAdjustmentId.delete(issued.adjustmentId);
  const rows = sortBudgetAdjustmentRows(state.rows.map((candidate): BudgetAdjustmentEditorRow =>
    candidate.adjustmentId === issued.adjustmentId ? reconciled : candidate));
  const rangeProvenanceByAdjustmentId = new Map(state.rangeProvenanceByAdjustmentId);
  if (issued.baseline.month !== canonical.confirmed.month) {
    rangeProvenanceByAdjustmentId.set(issued.adjustmentId, {
      direction: issued.direction,
      presenceRequestIdByMonth: new Map([[canonical.confirmed.month, state.latestRequestId]]),
      absenceRequestIdByMonth: new Map(), deletedThroughRequestId: null,
    });
  }
  const next = settleMutationRequest({
    ...state,
    rows,
    latestMutationRevision,
    confirmedMutationRevisionById,
    deletedMutationRevisionById,
    rangeProvenanceByAdjustmentId,
    dirtyFieldsByAdjustmentId: replaceDirtyFields(state.dirtyFieldsByAdjustmentId, reconciled),
    latestPatchRequestIdByAdjustmentId,
    ambiguousRangeRequirementByAdjustmentId,
    cellInvalidationRevisionByKey: recordBudgetAdjustmentCellMove(
      state.cellInvalidationRevisionByKey,
      {
        direction: issued.direction,
        previous: issued.baseline,
        current: canonical.confirmed,
      },
      latestMutationRevision,
      state.planFrom,
    ),
  }, issued.requestId);
  return { state: next, outcome: "accepted" };
};

const settlePatchFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentPatchRequest,
): BudgetAdjustmentRowsReconciliationState => {
  const issued = requireMutationRequest(state, request, "patch");
  if (state.settledMutationRequestIds.has(issued.requestId)) {
    throw new Error(`Cannot fail settled budget adjustment patch request ${issued.requestId}`);
  }
  if (state.latestPatchRequestIdByAdjustmentId.get(issued.adjustmentId) !== issued.requestId) {
    throw new Error(
      `Cannot fail budget adjustment patch request ${issued.requestId}: it is not pending for "${issued.adjustmentId}"`,
    );
  }
  const row = requireRow(state, issued.adjustmentId, "fail patch for");
  if (row.direction !== issued.direction || !snapshotsEqual(row.confirmed, issued.baseline)) {
    throw new Error(
      `Cannot fail patch for "${issued.adjustmentId}": current confirmed row does not match the request baseline`,
    );
  }
  const latestPatchRequestIdByAdjustmentId = new Map(
    state.latestPatchRequestIdByAdjustmentId,
  );
  latestPatchRequestIdByAdjustmentId.delete(issued.adjustmentId);
  return settleMutationRequest({ ...state, latestPatchRequestIdByAdjustmentId }, issued.requestId);
};

export const reconcileBudgetAdjustmentPatchDefinitiveFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentPatchRequest,
): BudgetAdjustmentRowsReconciliationState => settlePatchFailure(state, request);

export const reconcileBudgetAdjustmentPatchAmbiguousFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentPatchRequest,
): BudgetAdjustmentRowsReconciliationState => {
  const failed = settlePatchFailure(state, request);
  const ambiguousRangeRequirementByAdjustmentId = new Map(
    failed.ambiguousRangeRequirementByAdjustmentId,
  );
  ambiguousRangeRequirementByAdjustmentId.set(request.adjustmentId, {
    afterRequestId: state.latestRequestId,
    sourceMonth: request.baseline.month,
    targetMonth: request.requested.month,
  });
  return { ...failed, ambiguousRangeRequirementByAdjustmentId };
};

const settleDeleteFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentDeleteRequest,
): BudgetAdjustmentRowsReconciliationState => {
  const issued = requireMutationRequest(state, request, "delete");
  if (state.settledMutationRequestIds.has(issued.requestId)) {
    throw new Error(`Cannot fail settled budget adjustment delete request ${issued.requestId}`);
  }
  if (state.latestDeleteRequestIdByAdjustmentId.get(issued.adjustmentId) !== issued.requestId) {
    throw new Error(
      `Cannot fail budget adjustment delete request ${issued.requestId}: it is not pending for "${issued.adjustmentId}"`,
    );
  }
  const row = requireRow(state, issued.adjustmentId, "fail delete for");
  if (row.direction !== issued.direction || !snapshotsEqual(row.confirmed, issued.confirmed)) {
    throw new Error(
      `Cannot fail delete for "${issued.adjustmentId}": current confirmed row does not match the request`,
    );
  }
  const latestDeleteRequestIdByAdjustmentId = new Map(
    state.latestDeleteRequestIdByAdjustmentId,
  );
  latestDeleteRequestIdByAdjustmentId.delete(issued.adjustmentId);
  return settleMutationRequest({ ...state, latestDeleteRequestIdByAdjustmentId }, issued.requestId);
};

export const reconcileBudgetAdjustmentDeleteDefinitiveFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentDeleteRequest,
): BudgetAdjustmentRowsReconciliationState => settleDeleteFailure(state, request);

export const reconcileBudgetAdjustmentDeleteAmbiguousFailure = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentDeleteRequest,
): BudgetAdjustmentRowsReconciliationState => {
  const failed = settleDeleteFailure(state, request);
  const ambiguousRangeRequirementByAdjustmentId = new Map(
    failed.ambiguousRangeRequirementByAdjustmentId,
  );
  ambiguousRangeRequirementByAdjustmentId.set(request.adjustmentId, {
    afterRequestId: state.latestRequestId,
    sourceMonth: request.confirmed.month,
    targetMonth: request.confirmed.month,
  });
  return { ...failed, ambiguousRangeRequirementByAdjustmentId };
};

export const reconcileBudgetAdjustmentDeleteAcknowledgement = (
  state: BudgetAdjustmentRowsReconciliationState,
  request: BudgetAdjustmentDeleteRequest,
  deleteOutcome: DeleteBudgetAdjustmentOutcome,
): BudgetAdjustmentDeleteAcknowledgement => {
  const issued = requireMutationRequest(state, request, "delete");
  if (deleteOutcome !== "deleted" && deleteOutcome !== "already-absent") {
    throw new Error(
      `Cannot acknowledge budget adjustment delete request ${issued.requestId}: invalid outcome "${String(deleteOutcome)}"`,
    );
  }
  if (state.settledMutationRequestIds.has(issued.requestId)) {
    const alreadyApplied = !state.rows.some((row) => row.adjustmentId === issued.adjustmentId)
      && state.appliedDeleteRequestIds.has(issued.requestId);
    return { state, outcome: alreadyApplied ? "already-applied" : "stale" };
  }
  const isStale = state.latestDeleteRequestIdByAdjustmentId.get(issued.adjustmentId)
    !== issued.requestId
    || (state.confirmedMutationRevisionById.get(issued.adjustmentId) ?? 0) > issued.mutationRevision
    || (state.deletedMutationRevisionById.get(issued.adjustmentId) ?? 0) > issued.mutationRevision;
  if (isStale) {
    return { state: settleMutationRequest(state, issued.requestId), outcome: "stale" };
  }
  const row = requireRow(state, issued.adjustmentId, "acknowledge delete for");
  if (row.direction !== issued.direction || !snapshotsEqual(row.confirmed, issued.confirmed)) {
    throw new Error(
      `Cannot acknowledge delete for "${issued.adjustmentId}": current confirmed row does not match the request`,
    );
  }
  const latestMutationRevision = getNextMutationRevision(state);
  const confirmedMutationRevisionById = new Map(state.confirmedMutationRevisionById);
  confirmedMutationRevisionById.delete(issued.adjustmentId);
  const deletedMutationRevisionById = new Map(state.deletedMutationRevisionById);
  deletedMutationRevisionById.set(issued.adjustmentId, latestMutationRevision);
  const appliedDeleteRequestIds = new Set(state.appliedDeleteRequestIds);
  appliedDeleteRequestIds.add(issued.requestId);
  const latestDeleteRequestIdByAdjustmentId = new Map(
    state.latestDeleteRequestIdByAdjustmentId,
  );
  latestDeleteRequestIdByAdjustmentId.delete(issued.adjustmentId);
  const ambiguousRangeRequirementByAdjustmentId = new Map(
    state.ambiguousRangeRequirementByAdjustmentId,
  );
  ambiguousRangeRequirementByAdjustmentId.delete(issued.adjustmentId);
  const dirtyFieldsByAdjustmentId = new Map(state.dirtyFieldsByAdjustmentId);
  dirtyFieldsByAdjustmentId.delete(issued.adjustmentId);
  const next = settleMutationRequest({
    ...state,
    rows: state.rows.filter((candidate): boolean => candidate.adjustmentId !== issued.adjustmentId),
    latestMutationRevision,
    confirmedMutationRevisionById,
    deletedMutationRevisionById,
    appliedDeleteRequestIds,
    dirtyFieldsByAdjustmentId,
    latestDeleteRequestIdByAdjustmentId,
    ambiguousRangeRequirementByAdjustmentId,
    cellInvalidationRevisionByKey: recordBudgetAdjustmentCellInvalidation(
      state.cellInvalidationRevisionByKey,
      issued.direction,
      issued.confirmed,
      latestMutationRevision,
    ),
  }, issued.requestId);
  return { state: next, outcome: "applied" };
};
