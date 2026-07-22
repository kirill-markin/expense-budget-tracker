import type { BudgetAdjustmentDirection } from "@/server/budget/budgetAdjustments";
import {
  budgetAdjustmentNoteFromInput,
  budgetAdjustmentNoteToInput,
  createBudgetAdjustmentEditorRow,
  parseBudgetAdjustmentAmount,
  replaceBudgetAdjustmentDraft,
  sortBudgetAdjustmentRows,
  type BudgetAdjustmentDraft,
  type BudgetAdjustmentEditorRow,
  type BudgetAdjustmentSnapshot,
} from "@/ui/tables/budget/budgetAdjustmentRowsState";
import { parseBudgetAdjustment } from "@/ui/tables/budget/budgetTableApi";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const RECENT_SETTLED_REQUEST_LIMIT = 8;

export type BudgetAdjustmentRangeRequest = Readonly<{
  requestId: number;
  monthFrom: string;
  monthTo: string;
}>;

export type BudgetAdjustmentRangeProvenance = Readonly<{
  direction: BudgetAdjustmentDirection;
  presenceRequestIdByMonth: ReadonlyMap<string, number>;
  absenceRequestIdByMonth: ReadonlyMap<string, number>;
  deletedThroughRequestId: number | null;
}>;

export type BudgetAdjustmentRangeDirtyFields = Readonly<{
  amount: boolean;
  note: boolean;
  month: boolean;
  category: boolean;
}>;

export type BudgetAdjustmentRangeReconciliationState = Readonly<{
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>;
  latestRequestId: number;
  acceptedRangeRequestIdByMonth: ReadonlyMap<string, number>;
  rangeProvenanceByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentRangeProvenance>;
  dirtyFieldsByAdjustmentId: ReadonlyMap<string, BudgetAdjustmentRangeDirtyFields>;
  requestsById: ReadonlyMap<number, BudgetAdjustmentRangeRequest>;
  settledRequestIds: ReadonlySet<number>;
}>;

export type IssuedBudgetAdjustmentRangeRequest = Readonly<{
  state: BudgetAdjustmentRangeReconciliationState;
  request: BudgetAdjustmentRangeRequest;
}>;

const validateMonth = (month: string, context: string): void => {
  if (!MONTH_PATTERN.test(month)) {
    throw new RangeError(`${context} must use YYYY-MM with a valid month; received "${month}"`);
  }
};

const validateRange = (monthFrom: string, monthTo: string, context: string): void => {
  validateMonth(monthFrom, `${context} monthFrom`);
  validateMonth(monthTo, `${context} monthTo`);
  if (monthFrom > monthTo) {
    throw new RangeError(`${context} monthFrom "${monthFrom}" must not be after monthTo "${monthTo}"`);
  }
};

const validateRequestId = (requestId: number, context: string): void => {
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    throw new RangeError(`${context} must be a positive safe integer; received ${String(requestId)}`);
  }
};

const requestsEqual = (
  left: BudgetAdjustmentRangeRequest,
  right: BudgetAdjustmentRangeRequest,
): boolean => left.requestId === right.requestId
  && left.monthFrom === right.monthFrom
  && left.monthTo === right.monthTo;

const requireIssuedRequest = (
  state: BudgetAdjustmentRangeReconciliationState,
  request: BudgetAdjustmentRangeRequest,
): BudgetAdjustmentRangeRequest => {
  validateRequestId(request.requestId, "Budget adjustment range request id");
  validateRange(request.monthFrom, request.monthTo, "Budget adjustment range acknowledgement");
  const stored = state.requestsById.get(request.requestId);
  if (stored === undefined) {
    const reason = request.requestId <= state.latestRequestId
      ? "it fell outside the recent settled request history"
      : "the request was not issued by this state";
    throw new Error(
      `Cannot acknowledge budget adjustment range request ${request.requestId}: ${reason}`,
    );
  }
  if (!requestsEqual(stored, request)) {
    throw new Error(
      `Cannot acknowledge budget adjustment range request ${request.requestId}: request fields do not match the issued request`,
    );
  }
  return stored;
};

const getNextRequestId = (state: BudgetAdjustmentRangeReconciliationState): number => {
  if (!Number.isSafeInteger(state.latestRequestId) || state.latestRequestId < 0) {
    throw new RangeError(
      `Cannot issue budget adjustment range request: latest request id must be a non-negative safe integer; received ${String(state.latestRequestId)}`,
    );
  }
  if (state.latestRequestId === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Cannot issue another budget adjustment range request: request id limit reached");
  }
  return state.latestRequestId + 1;
};

const settleRequest = (
  state: BudgetAdjustmentRangeReconciliationState,
  requestId: number,
): BudgetAdjustmentRangeReconciliationState => {
  const requestsById = new Map(state.requestsById);
  const settledRequestIds = new Set(state.settledRequestIds);
  settledRequestIds.add(requestId);
  while (settledRequestIds.size > RECENT_SETTLED_REQUEST_LIMIT) {
    const expiredRequestId = Math.min(...settledRequestIds);
    settledRequestIds.delete(expiredRequestId);
    requestsById.delete(expiredRequestId);
  }
  return { ...state, requestsById, settledRequestIds };
};

const createRangeProvenance = (
  direction: BudgetAdjustmentDirection,
): BudgetAdjustmentRangeProvenance => ({
  direction,
  presenceRequestIdByMonth: new Map(),
  absenceRequestIdByMonth: new Map(),
  deletedThroughRequestId: null,
});

const advanceDeletionCutoff = (
  current: number | null,
  candidate: number,
): number => current === null || candidate > current ? candidate : current;

const recordRangePresence = (
  provenance: BudgetAdjustmentRangeProvenance,
  month: string,
  requestId: number,
): BudgetAdjustmentRangeProvenance => {
  const presenceRequestIdByMonth = new Map(provenance.presenceRequestIdByMonth);
  const previousRequestId = presenceRequestIdByMonth.get(month);
  if (previousRequestId === undefined || requestId > previousRequestId) {
    presenceRequestIdByMonth.set(month, requestId);
  }
  const absenceRequestId = provenance.absenceRequestIdByMonth.get(month);
  const deletedThroughRequestId = absenceRequestId !== undefined && absenceRequestId > requestId
    ? advanceDeletionCutoff(provenance.deletedThroughRequestId, requestId)
    : provenance.deletedThroughRequestId;
  return { ...provenance, presenceRequestIdByMonth, deletedThroughRequestId };
};

const recordRangeAbsence = (
  provenance: BudgetAdjustmentRangeProvenance,
  month: string,
  requestId: number,
): BudgetAdjustmentRangeProvenance => {
  const absenceRequestIdByMonth = new Map(provenance.absenceRequestIdByMonth);
  const previousRequestId = absenceRequestIdByMonth.get(month);
  if (previousRequestId === undefined || requestId > previousRequestId) {
    absenceRequestIdByMonth.set(month, requestId);
  }
  const presenceRequestId = provenance.presenceRequestIdByMonth.get(month);
  const deletedThroughRequestId = presenceRequestId !== undefined && requestId > presenceRequestId
    ? advanceDeletionCutoff(provenance.deletedThroughRequestId, presenceRequestId)
    : provenance.deletedThroughRequestId;
  return { ...provenance, absenceRequestIdByMonth, deletedThroughRequestId };
};

type LiveRangePresence = Readonly<{
  requestId: number;
  month: string;
}>;

const getLatestLiveRangePresence = (
  provenance: BudgetAdjustmentRangeProvenance,
): LiveRangePresence | null => {
  let latest: LiveRangePresence | null = null;
  for (const [month, requestId] of provenance.presenceRequestIdByMonth) {
    const isDeleted = provenance.deletedThroughRequestId !== null
      && requestId <= provenance.deletedThroughRequestId;
    const isAbsent = (provenance.absenceRequestIdByMonth.get(month) ?? 0) > requestId;
    if (isDeleted || isAbsent) continue;
    if (latest === null || requestId > latest.requestId) latest = { requestId, month };
  }
  return latest;
};

const CLEAN_DIRTY_FIELDS: BudgetAdjustmentRangeDirtyFields = {
  amount: false,
  note: false,
  month: false,
  category: false,
};

const getReplacementDirtyFields = (
  row: BudgetAdjustmentEditorRow,
  draft: BudgetAdjustmentDraft,
): BudgetAdjustmentRangeDirtyFields => {
  const amount = parseBudgetAdjustmentAmount(draft.amountInput);
  return {
    amount: !amount.ok || amount.amount !== row.confirmed.amount,
    note: budgetAdjustmentNoteFromInput(draft.noteInput) !== row.confirmed.note,
    month: draft.month !== row.confirmed.month,
    category: draft.category !== row.confirmed.category,
  };
};

const hasDirtyFields = (dirtyFields: BudgetAdjustmentRangeDirtyFields): boolean =>
  dirtyFields.amount
  || dirtyFields.note
  || dirtyFields.month
  || dirtyFields.category;

const rebaseDraft = (
  row: BudgetAdjustmentEditorRow,
  confirmed: BudgetAdjustmentSnapshot,
  dirtyFields: BudgetAdjustmentRangeDirtyFields,
): BudgetAdjustmentDraft => {
  return {
    amountInput: dirtyFields.amount || confirmed.amount === row.confirmed.amount
      ? row.draft.amountInput
      : String(confirmed.amount),
    noteInput: dirtyFields.note || confirmed.note === row.confirmed.note
      ? row.draft.noteInput
      : budgetAdjustmentNoteToInput(confirmed.note),
    month: dirtyFields.month || confirmed.month === row.confirmed.month
      ? row.draft.month
      : confirmed.month,
    category: dirtyFields.category || confirmed.category === row.confirmed.category
      ? row.draft.category
      : confirmed.category,
  };
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

const parseRangeRows = (
  state: BudgetAdjustmentRangeReconciliationState,
  request: BudgetAdjustmentRangeRequest,
  inputs: ReadonlyArray<unknown>,
): ReadonlyMap<string, BudgetAdjustmentEditorRow> => {
  const existingById = new Map(
    state.rows.map((row): readonly [string, BudgetAdjustmentEditorRow] => [row.adjustmentId, row]),
  );
  const rowsById = new Map<string, BudgetAdjustmentEditorRow>();
  for (const [index, input] of inputs.entries()) {
    const adjustment = parseBudgetAdjustment(input, `Budget adjustment range response row ${index}`);
    if (adjustment.month < request.monthFrom || adjustment.month > request.monthTo) {
      throw new RangeError(
        `Budget adjustment range response row "${adjustment.adjustmentId}" month "${adjustment.month}" is outside requested range ${request.monthFrom}..${request.monthTo}`,
      );
    }
    if (rowsById.has(adjustment.adjustmentId)) {
      throw new Error(
        `Budget adjustment range response contains duplicate id "${adjustment.adjustmentId}"`,
      );
    }
    const existingDirection = existingById.get(adjustment.adjustmentId)?.direction
      ?? state.rangeProvenanceByAdjustmentId.get(adjustment.adjustmentId)?.direction;
    if (existingDirection !== undefined && existingDirection !== adjustment.direction) {
      throw new Error(
        `Budget adjustment range response changed immutable direction for "${adjustment.adjustmentId}" from ${existingDirection} to ${adjustment.direction}`,
      );
    }
    rowsById.set(adjustment.adjustmentId, createBudgetAdjustmentEditorRow(adjustment));
  }
  return rowsById;
};

export const createBudgetAdjustmentRangeReconciliationState = (
  adjustments: ReadonlyArray<unknown>,
): BudgetAdjustmentRangeReconciliationState => {
  const adjustmentIds = new Set<string>();
  const rows = adjustments.map((input, index): BudgetAdjustmentEditorRow => {
    const adjustment = parseBudgetAdjustment(input, `Initial budget adjustment at index ${index}`);
    if (adjustmentIds.has(adjustment.adjustmentId)) {
      throw new Error(`Initial budget adjustments contain duplicate id "${adjustment.adjustmentId}"`);
    }
    adjustmentIds.add(adjustment.adjustmentId);
    return createBudgetAdjustmentEditorRow(adjustment);
  });
  return {
    rows: sortBudgetAdjustmentRows(rows),
    latestRequestId: 0,
    acceptedRangeRequestIdByMonth: new Map(),
    rangeProvenanceByAdjustmentId: new Map(rows.map((row): readonly [string, BudgetAdjustmentRangeProvenance] => [
      row.adjustmentId,
      recordRangePresence(createRangeProvenance(row.direction), row.confirmed.month, 0),
    ])),
    dirtyFieldsByAdjustmentId: new Map(),
    requestsById: new Map(),
    settledRequestIds: new Set(),
  };
};

export const replaceBudgetAdjustmentRangeDraft = (
  state: BudgetAdjustmentRangeReconciliationState,
  adjustmentId: string,
  draft: BudgetAdjustmentDraft,
): BudgetAdjustmentRangeReconciliationState => {
  const row = state.rows.find((candidate) => candidate.adjustmentId === adjustmentId);
  if (row === undefined) {
    throw new Error(`Cannot replace draft for missing budget adjustment "${adjustmentId}"`);
  }
  const provenance = state.rangeProvenanceByAdjustmentId.get(adjustmentId);
  if (provenance === undefined) {
    throw new Error(
      `Cannot replace budget adjustment draft: missing provenance for "${adjustmentId}"`,
    );
  }
  const dirtyFields = getReplacementDirtyFields(row, draft);
  const dirtyFieldsByAdjustmentId = new Map(state.dirtyFieldsByAdjustmentId);
  if (hasDirtyFields(dirtyFields)) {
    dirtyFieldsByAdjustmentId.set(adjustmentId, dirtyFields);
  } else {
    dirtyFieldsByAdjustmentId.delete(adjustmentId);
  }
  const replacedRows = replaceBudgetAdjustmentDraft(state.rows, adjustmentId, { ...draft });
  const rows = !hasDirtyFields(dirtyFields) && getLatestLiveRangePresence(provenance) === null
    ? replacedRows.filter((candidate) => candidate.adjustmentId !== adjustmentId)
    : replacedRows;
  return { ...state, rows, dirtyFieldsByAdjustmentId };
};

export const issueBudgetAdjustmentRangeRequest = (
  state: BudgetAdjustmentRangeReconciliationState,
  monthFrom: string,
  monthTo: string,
): IssuedBudgetAdjustmentRangeRequest => {
  validateRange(monthFrom, monthTo, "Budget adjustment range request");
  const request: BudgetAdjustmentRangeRequest = {
    requestId: getNextRequestId(state),
    monthFrom,
    monthTo,
  };
  const requestsById = new Map(state.requestsById);
  requestsById.set(request.requestId, request);
  return {
    request,
    state: { ...state, latestRequestId: request.requestId, requestsById },
  };
};

export const reconcileBudgetAdjustmentRangeFailure = (
  state: BudgetAdjustmentRangeReconciliationState,
  request: BudgetAdjustmentRangeRequest,
): BudgetAdjustmentRangeReconciliationState => {
  const issued = requireIssuedRequest(state, request);
  if (state.settledRequestIds.has(issued.requestId)) {
    throw new Error(`Cannot fail settled budget adjustment range request ${issued.requestId}`);
  }
  return settleRequest(state, issued.requestId);
};

export const reconcileBudgetAdjustmentRangeResponse = (
  state: BudgetAdjustmentRangeReconciliationState,
  request: BudgetAdjustmentRangeRequest,
  adjustments: ReadonlyArray<unknown>,
): BudgetAdjustmentRangeReconciliationState => {
  const issued = requireIssuedRequest(state, request);
  if (state.settledRequestIds.has(issued.requestId)) {
    throw new Error(`Cannot reconcile budget adjustment range request ${issued.requestId} more than once`);
  }
  const canonicalById = parseRangeRows(state, issued, adjustments);
  const acceptedMonths = enumerateMonths(issued.monthFrom, issued.monthTo)
    .filter((month): boolean =>
      (state.acceptedRangeRequestIdByMonth.get(month) ?? 0) < issued.requestId);
  const acceptedMonthSet = new Set(acceptedMonths);
  const rangeProvenanceByAdjustmentId = new Map(state.rangeProvenanceByAdjustmentId);
  for (const [adjustmentId, row] of canonicalById) {
    let provenance = rangeProvenanceByAdjustmentId.get(adjustmentId)
      ?? createRangeProvenance(row.direction);
    provenance = recordRangePresence(provenance, row.confirmed.month, issued.requestId);
    const acceptedTargetRequestId =
      state.acceptedRangeRequestIdByMonth.get(row.confirmed.month) ?? 0;
    if (acceptedTargetRequestId > issued.requestId) {
      provenance = recordRangeAbsence(
        provenance,
        row.confirmed.month,
        acceptedTargetRequestId,
      );
    }
    rangeProvenanceByAdjustmentId.set(adjustmentId, provenance);
  }

  for (const [adjustmentId, currentProvenance] of rangeProvenanceByAdjustmentId) {
    const fetchedMonth = canonicalById.get(adjustmentId)?.confirmed.month;
    let provenance = currentProvenance;
    for (const month of acceptedMonths) {
      if (
        fetchedMonth !== month
        && provenance.presenceRequestIdByMonth.has(month)
      ) {
        provenance = recordRangeAbsence(provenance, month, issued.requestId);
      }
    }
    rangeProvenanceByAdjustmentId.set(adjustmentId, provenance);
  }

  const fetchedById = new Map<string, BudgetAdjustmentEditorRow>();
  for (const [adjustmentId, row] of canonicalById) {
    const provenance = rangeProvenanceByAdjustmentId.get(adjustmentId);
    if (provenance === undefined) {
      throw new Error(
        `Cannot reconcile budget adjustment range: missing provenance for "${adjustmentId}"`,
      );
    }
    const latestPresence = getLatestLiveRangePresence(provenance);
    if (
      acceptedMonthSet.has(row.confirmed.month)
      && latestPresence?.requestId === issued.requestId
      && latestPresence.month === row.confirmed.month
    ) {
      fetchedById.set(adjustmentId, row);
    }
  }

  const rows: Array<BudgetAdjustmentEditorRow> = [];
  for (const row of state.rows) {
    const fetched = fetchedById.get(row.adjustmentId);
    if (fetched !== undefined) {
      fetchedById.delete(row.adjustmentId);
      const dirtyFields = state.dirtyFieldsByAdjustmentId.get(row.adjustmentId)
        ?? CLEAN_DIRTY_FIELDS;
      rows.push({ ...fetched, draft: rebaseDraft(row, fetched.confirmed, dirtyFields) });
      continue;
    }
    const provenance = rangeProvenanceByAdjustmentId.get(row.adjustmentId);
    if (provenance === undefined) {
      throw new Error(
        `Cannot reconcile budget adjustment range: missing provenance for "${row.adjustmentId}"`,
      );
    }
    const dirtyFields = state.dirtyFieldsByAdjustmentId.get(row.adjustmentId)
      ?? CLEAN_DIRTY_FIELDS;
    if (getLatestLiveRangePresence(provenance) !== null || hasDirtyFields(dirtyFields)) {
      rows.push(row);
    }
  }
  rows.push(...fetchedById.values());

  const acceptedRangeRequestIdByMonth = new Map(state.acceptedRangeRequestIdByMonth);
  for (const month of acceptedMonths) {
    acceptedRangeRequestIdByMonth.set(month, issued.requestId);
  }
  return settleRequest({
    ...state,
    rows: sortBudgetAdjustmentRows(rows),
    acceptedRangeRequestIdByMonth,
    rangeProvenanceByAdjustmentId,
  }, issued.requestId);
};
