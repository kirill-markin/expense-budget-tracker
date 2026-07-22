import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetAdjustment, BudgetAdjustmentDirection } from "@/server/budget/budgetAdjustments";
import {
  addOptimisticBudgetAdjustmentRow,
  buildBudgetAdjustmentPatch,
  createBudgetAdjustmentRowsReconciliationState,
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
  type BudgetAdjustmentCreateRequest,
  type BudgetAdjustmentPatchRequest,
  type BudgetAdjustmentRowsReconciliationState,
} from "@/ui/tables/budget/budgetAdjustmentRowsReconciliation";
import { getBudgetAdjustmentCellKey, type BudgetAdjustmentDraft } from "@/ui/tables/budget/budgetAdjustmentRowsState";

const createAdjustment = (adjustmentId: string, amount: number, month: string,
  direction: BudgetAdjustmentDirection, category: string, note: string | null, updatedDay: number,
): BudgetAdjustment => ({
  adjustmentId, amount, month, direction, category, note,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: `2026-07-${String(updatedDay).padStart(2, "0")}T00:00:00.000Z`,
});

const createDraft = (amountInput: string, month: string, category: string,
  noteInput: string): BudgetAdjustmentDraft => ({ amountInput, month, category, noteInput });

const editDraft = (state: BudgetAdjustmentRowsReconciliationState,
  adjustmentId: string, draft: BudgetAdjustmentDraft,
): BudgetAdjustmentRowsReconciliationState => replaceBudgetAdjustmentReconciliationDraft(state, adjustmentId, draft);

const createUuid = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("optimistic create installs a blank final-ID row and issues one immutable request", (): void => {
  const adjustmentId = createUuid(1);
  const initial = createBudgetAdjustmentRowsReconciliationState([], "2026-07");
  const optimistic = addOptimisticBudgetAdjustmentRow(
    initial,
    adjustmentId,
    "2026-07",
    "spend",
    "Food",
  );

  assert.deepEqual(optimistic.rows[0], {
    adjustmentId,
    direction: "spend",
    draft: createDraft("", "2026-07", "Food", ""),
    confirmed: { amount: 0, note: null, month: "2026-07", category: "Food" },
    createdAt: "9999-12-31T23:59:59.999Z",
    updatedAt: "9999-12-31T23:59:59.999Z",
  });
  const issued = issueBudgetAdjustmentCreateRequest(optimistic, adjustmentId);
  assert.deepEqual(initial.rows, []);
  assert.equal(initial.optimisticCreateByAdjustmentId.size, 0);
  assert.equal(
    optimistic.optimisticCreateByAdjustmentId.get(adjustmentId)?.status,
    "ready",
  );
  assert.equal(
    issued.state.optimisticCreateByAdjustmentId.get(adjustmentId)?.status,
    "pending",
  );
  assert.deepEqual(issued.request.params, {
    adjustmentId,
    month: "2026-07",
    direction: "spend",
    category: "Food",
    amount: 0,
    note: null,
  });
  assert.throws(
    () => issueBudgetAdjustmentCreateRequest(issued.state, adjustmentId),
    /second create.*pending/,
  );
  assert.throws(
    () => issueBudgetAdjustmentPatchRequest(issued.state, adjustmentId),
    /until its create request is acknowledged.*pending/,
  );
  assert.throws(
    () => issueBudgetAdjustmentDeleteRequest(issued.state, adjustmentId),
    /until its create request is acknowledged.*pending/,
  );
  assert.throws(
    () => addOptimisticBudgetAdjustmentRow(initial, "temporary-1", "2026-07", "spend", "Food"),
    /must be a UUID/,
  );
});

test("create acknowledgement preserves newer edits and survives ranges issued before it", (): void => {
  const adjustmentId = createUuid(2);
  const optimistic = addOptimisticBudgetAdjustmentRow(
    createBudgetAdjustmentRowsReconciliationState([], "2026-07"),
    adjustmentId,
    "2026-07",
    "spend",
    "Food",
  );
  const create = issueBudgetAdjustmentCreateRequest(optimistic, adjustmentId);
  const beforeAcknowledgement = issueBudgetAdjustmentRangeRequest(
    create.state,
    "2026-07",
    "2026-07",
  );
  const preservedBefore = reconcileBudgetAdjustmentRangeResponse(
    beforeAcknowledgement.state,
    beforeAcknowledgement.request,
    [],
  );
  assert.equal(preservedBefore.rows[0]?.adjustmentId, adjustmentId);

  const staleAfterAcknowledgement = issueBudgetAdjustmentRangeRequest(
    preservedBefore,
    "2026-07",
    "2026-07",
  );
  const edited = editDraft(
    staleAfterAcknowledgement.state,
    adjustmentId,
    createDraft("7", "2026-07", "Food", "local"),
  );
  const serverRow = createAdjustment(
    adjustmentId,
    0,
    "2026-07",
    "spend",
    "Food",
    null,
    2,
  );
  const acknowledged = reconcileBudgetAdjustmentCreateAcknowledgement(
    edited,
    create.request,
    serverRow,
  );
  assert.equal(acknowledged.outcome, "accepted");
  assert.deepEqual(
    acknowledged.state.rows[0]?.draft,
    createDraft("7", "2026-07", "Food", "local"),
  );
  assert.equal(acknowledged.state.rows[0]?.confirmed.amount, 0);
  assert.deepEqual(
    issueBudgetAdjustmentPatchRequest(acknowledged.state, adjustmentId).request.params,
    { amount: 7, note: "local" },
  );

  const stale = reconcileBudgetAdjustmentRangeResponse(
    acknowledged.state,
    staleAfterAcknowledgement.request,
    [{ ...serverRow, amount: 99 }],
  );
  assert.equal(stale.rows[0]?.confirmed.amount, 0);
  assert.equal(stale.rows[0]?.draft.amountInput, "7");
});

test("a clean acknowledged create is removable only by a later authoritative range", (): void => {
  const adjustmentId = createUuid(3);
  const optimistic = addOptimisticBudgetAdjustmentRow(
    createBudgetAdjustmentRowsReconciliationState([], "2026-07"),
    adjustmentId,
    "2026-07",
    "income",
    "Bonus",
  );
  const create = issueBudgetAdjustmentCreateRequest(optimistic, adjustmentId);
  const staleRange = issueBudgetAdjustmentRangeRequest(create.state, "2026-07", "2026-07");
  const serverRow = createAdjustment(
    adjustmentId,
    0,
    "2026-07",
    "income",
    "Bonus",
    null,
    2,
  );
  const acknowledged = reconcileBudgetAdjustmentCreateAcknowledgement(
    staleRange.state,
    create.request,
    serverRow,
  );
  const stale = reconcileBudgetAdjustmentRangeResponse(
    acknowledged.state,
    staleRange.request,
    [],
  );
  assert.equal(stale.rows.length, 1);
  const freshRange = issueBudgetAdjustmentRangeRequest(stale, "2026-07", "2026-07");
  const absent = reconcileBudgetAdjustmentRangeResponse(
    freshRange.state,
    freshRange.request,
    [],
  );
  assert.deepEqual(absent.rows, []);
  assert.equal(absent.confirmedMutationRevisionById.has(adjustmentId), false);
});

test("failed create retains its exact payload for retry while newer drafts stay local", (): void => {
  const adjustmentId = createUuid(4);
  const optimistic = addOptimisticBudgetAdjustmentRow(
    createBudgetAdjustmentRowsReconciliationState([], "2026-07"),
    adjustmentId,
    "2026-07",
    "spend",
    "Food",
  );
  const first = issueBudgetAdjustmentCreateRequest(optimistic, adjustmentId);
  const edited = editDraft(
    first.state,
    adjustmentId,
    createDraft("9", "2026-08", "Dining", "newer"),
  );
  const failed = reconcileBudgetAdjustmentCreateFailure(edited, first.request);
  assert.equal(failed.optimisticCreateByAdjustmentId.get(adjustmentId)?.status, "failed");
  assert.deepEqual(failed.rows[0]?.draft, createDraft("9", "2026-08", "Dining", "newer"));
  assert.throws(
    () => issueBudgetAdjustmentDeleteRequest(failed, adjustmentId),
    /until its create request is acknowledged.*failed/,
  );
  const range = issueBudgetAdjustmentRangeRequest(failed, "2026-07", "2026-07");
  const rangePreserved = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, []);
  assert.equal(rangePreserved.rows.length, 1);

  const retry = issueBudgetAdjustmentCreateRequest(rangePreserved, adjustmentId);
  assert.deepEqual(retry.request.params, first.request.params);
  assert.deepEqual(retry.request.draft, first.request.draft);
  const serverRow = createAdjustment(
    adjustmentId,
    0,
    "2026-07",
    "spend",
    "Food",
    null,
    1,
  );
  const acknowledged = reconcileBudgetAdjustmentCreateAcknowledgement(
    retry.state,
    retry.request,
    serverRow,
  );
  assert.deepEqual(
    acknowledged.state.rows[0]?.draft,
    createDraft("9", "2026-08", "Dining", "newer"),
  );
  assert.deepEqual(
    issueBudgetAdjustmentPatchRequest(acknowledged.state, adjustmentId).request.params,
    { amount: 9, note: "newer", month: "2026-08", category: "Dining" },
  );
  assert.equal(
    reconcileBudgetAdjustmentCreateAcknowledgement(
      acknowledged.state,
      first.request,
      serverRow,
    ).outcome,
    "stale",
  );
  assert.equal(
    reconcileBudgetAdjustmentCreateAcknowledgement(
      acknowledged.state,
      retry.request,
      serverRow,
    ).outcome,
    "already-applied",
  );
});

test("create acknowledgements require exact provenance and strict matching rows", (): void => {
  const adjustmentId = createUuid(5);
  const optimistic = addOptimisticBudgetAdjustmentRow(
    createBudgetAdjustmentRowsReconciliationState([], "2026-07"),
    adjustmentId,
    "2026-07",
    "spend",
    "Food",
  );
  const create = issueBudgetAdjustmentCreateRequest(optimistic, adjustmentId);
  const serverRow = createAdjustment(adjustmentId, 0, "2026-07", "spend", "Food", null, 1);
  assert.throws(
    () => reconcileBudgetAdjustmentCreateAcknowledgement(
      create.state,
      { ...create.request, params: { ...create.request.params, amount: 1 } },
      serverRow,
    ),
    /fields do not match/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentCreateAcknowledgement(
      create.state,
      create.request,
      { ...serverRow, adjustmentId: createUuid(6) },
    ),
    /does not match requested id/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentCreateAcknowledgement(
      create.state,
      create.request,
      { ...serverRow, direction: "income" },
    ),
    /immutable direction/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentCreateAcknowledgement(
      create.state,
      create.request,
      { ...serverRow, unexpected: true },
    ),
    /create acknowledgement is invalid/,
  );
});

test("settled create acknowledgement history is bounded", (): void => {
  let state = createBudgetAdjustmentRowsReconciliationState([], "2026-07");
  const requests: Array<BudgetAdjustmentCreateRequest> = [];
  for (let index = 10; index < 22; index += 1) {
    const adjustmentId = createUuid(index);
    state = addOptimisticBudgetAdjustmentRow(
      state,
      adjustmentId,
      "2026-07",
      "income",
      `Income ${index}`,
    );
    const create = issueBudgetAdjustmentCreateRequest(state, adjustmentId);
    requests.push(create.request);
    state = reconcileBudgetAdjustmentCreateAcknowledgement(
      create.state,
      create.request,
      createAdjustment(
        adjustmentId,
        0,
        "2026-07",
        "income",
        `Income ${index}`,
        null,
        1,
      ),
    ).state;
  }

  assert.equal(state.settledMutationRequestIds.size, 8);
  assert.equal(state.mutationRequestsById.size, 8);
  assert.equal(state.appliedCreateRequestIds.size, 8);
  assert.throws(
    () => reconcileBudgetAdjustmentCreateAcknowledgement(
      state,
      requests[0]!,
      createAdjustment(createUuid(10), 0, "2026-07", "income", "Income 10", null, 1),
    ),
    /outside the recent settled request history/,
  );
  const latest = requests.at(-1)!;
  assert.equal(
    reconcileBudgetAdjustmentCreateAcknowledgement(
      state,
      latest,
      createAdjustment(latest.adjustmentId, 0, "2026-07", "income", "Income 21", null, 1),
    ).outcome,
    "already-applied",
  );
});

test("patch params are minimal and blank amount parses as zero", (): void => {
  const adjustment = createAdjustment("minimal", 5, "2026-07", "spend", "Food", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const edited = editDraft(initial, adjustment.adjustmentId, createDraft("", "2026-08", "Dining", "note"));
  const issued = issueBudgetAdjustmentPatchRequest(edited, adjustment.adjustmentId);
  assert.deepEqual(issued.request.params, { amount: 0, note: "note", month: "2026-08", category: "Dining" });
  assert.deepEqual(buildBudgetAdjustmentPatch(issued.request.requested,
    { ...issued.request.baseline, amount: 0, note: "note" }), { month: "2026-08", category: "Dining" });
});

test("raw zero formats survive only while semantically equal to the canonical amount", (): void => {
  for (const amountInput of ["", "0", "+0", "-0", "00", "+00", "-00", " 0 "]) {
    const adjustment = createAdjustment("raw-zero", 0, "2026-07", "spend", "Zero", "Old", 1);
    const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
    const edited = editDraft(initial, adjustment.adjustmentId, createDraft(amountInput, "2026-07", "Zero", "New"));
    const patch = issueBudgetAdjustmentPatchRequest(edited, adjustment.adjustmentId);
    assert.deepEqual(patch.request.params, { note: "New" });
    const acknowledged = reconcileBudgetAdjustmentPatchAcknowledgement(patch.state, patch.request,
      { ...adjustment, note: "New", updatedAt: "2026-07-02T00:00:00.000Z" });
    assert.equal(acknowledged.state.rows[0].draft.amountInput, amountInput);
  }
});

test("a note-only raw-zero race accepts a changed canonical server amount", (): void => {
  const adjustment = createAdjustment("zero-race", 0, "2026-07", "spend", "Zero", "Old", 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const requested = editDraft(initial, adjustment.adjustmentId, createDraft("+0", "2026-07", "Zero", "New"));
  const patch = issueBudgetAdjustmentPatchRequest(requested, adjustment.adjustmentId);
  const reformatted = editDraft(patch.state, adjustment.adjustmentId, createDraft("00", "2026-07", "Zero", "New"));
  const acknowledged = reconcileBudgetAdjustmentPatchAcknowledgement(reformatted, patch.request,
    { ...adjustment, amount: 5, note: "New", updatedAt: "2026-07-02T00:00:00.000Z" },
  );
  assert.equal(acknowledged.state.rows[0].confirmed.amount, 5);
  assert.equal(acknowledged.state.rows[0].draft.amountInput, "5");
  const noteEdited = editDraft(acknowledged.state, adjustment.adjustmentId, createDraft("5", "2026-07", "Zero", "Again"));
  assert.deepEqual(issueBudgetAdjustmentPatchRequest(noteEdited, adjustment.adjustmentId).request.params,
    { note: "Again" });
});

test("invalid and genuinely newer semantic amount edits remain visible after acknowledgement", (): void => {
  for (const amountInput of ["invalid", "7"]) {
    const adjustment = createAdjustment("newer", 0, "2026-07", "spend", "Zero", "Old", 1);
    const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
    const edited = editDraft(initial, adjustment.adjustmentId, createDraft("0", "2026-07", "Zero", "New"));
    const patch = issueBudgetAdjustmentPatchRequest(edited, adjustment.adjustmentId);
    const newer = editDraft(patch.state, adjustment.adjustmentId, createDraft(amountInput, "2026-07", "Zero", "New"));
    const acknowledged = reconcileBudgetAdjustmentPatchAcknowledgement(newer, patch.request,
      { ...adjustment, amount: 5, note: "New", updatedAt: "2026-07-02T00:00:00.000Z" });
    assert.equal(acknowledged.state.rows[0].draft.amountInput, amountInput);
    assert.equal(acknowledged.state.rows[0].confirmed.amount, 5);
  }
});

test("patches serialize newer drafts and retire protection after authoritative absence", (): void => {
  const adjustment = createAdjustment("serial", 0, "2026-07", "spend", "Food", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const first = issueBudgetAdjustmentPatchRequest(editDraft(initial, adjustment.adjustmentId,
    createDraft("1", "2026-07", "Food", "")), adjustment.adjustmentId);
  const newer = editDraft(first.state, adjustment.adjustmentId, createDraft("2", "2026-07", "Food", "local"));
  assert.throws(() => issueBudgetAdjustmentPatchRequest(newer, adjustment.adjustmentId), /second patch.*pending/);
  assert.throws(() => issueBudgetAdjustmentDeleteRequest(newer, adjustment.adjustmentId), /patch request is pending/);
  const acknowledged = reconcileBudgetAdjustmentPatchAcknowledgement(newer, first.request,
    { ...adjustment, amount: 1, note: "server", updatedAt: "2026-07-02T00:00:00.000Z" },
  );
  assert.deepEqual(acknowledged.state.rows[0].draft, createDraft("2", "2026-07", "Food", "local"));
  assert.deepEqual(issueBudgetAdjustmentPatchRequest(acknowledged.state,
    adjustment.adjustmentId).request.params, { amount: 2, note: "local" });
  const range = issueBudgetAdjustmentRangeRequest(acknowledged.state, "2026-07", "2026-07");
  const hidden = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, []);
  assert.equal(hidden.confirmedMutationRevisionById.has(adjustment.adjustmentId), false);
  const reset = editDraft(hidden, adjustment.adjustmentId, createDraft("1", "2026-07", "Food", "server"));
  assert.deepEqual(reset.rows, []);
});

test("patch requests and acknowledgements are strict, exact, and repeat-safe", (): void => {
  const adjustment = createAdjustment("strict", 1, "2026-07", "spend", "Food", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const patch = issueBudgetAdjustmentPatchRequest(editDraft(initial, adjustment.adjustmentId,
    createDraft("2", "2026-07", "Food", "")), adjustment.adjustmentId);
  assert.throws(() => reconcileBudgetAdjustmentPatchAcknowledgement(patch.state,
    { ...patch.request, params: { amount: 3 } }, { ...adjustment, amount: 2 }), /fields do not match/);
  assert.throws(() => reconcileBudgetAdjustmentPatchAcknowledgement(patch.state,
    { ...patch.request, requestId: 99 }, { ...adjustment, amount: 2 }), /not issued/);
  for (const malformed of [
    { ...adjustment, amount: 2, note: 4 },
    { ...adjustment, amount: 2, extra: true },
    { ...adjustment, amount: 2, updatedAt: "invalid" },
  ]) {
    assert.throws(() => reconcileBudgetAdjustmentPatchAcknowledgement(patch.state,
      patch.request, malformed), /patch acknowledgement is invalid/);
  }
  assert.throws(() => reconcileBudgetAdjustmentPatchAcknowledgement(patch.state,
    patch.request, { ...adjustment, adjustmentId: "other", amount: 2 }), /does not match requested id/);
  assert.throws(() => reconcileBudgetAdjustmentPatchAcknowledgement(patch.state,
    patch.request, { ...adjustment, direction: "income", amount: 2 }), /immutable direction/);
  const accepted = reconcileBudgetAdjustmentPatchAcknowledgement(patch.state, patch.request, { ...adjustment, amount: 2 });
  const repeated = reconcileBudgetAdjustmentPatchAcknowledgement(accepted.state, patch.request, { ...adjustment, amount: 2 });
  assert.equal(repeated.outcome, "stale");
  assert.equal(repeated.state, accepted.state);
  const deletion = issueBudgetAdjustmentDeleteRequest(accepted.state, adjustment.adjustmentId);
  const deleted = reconcileBudgetAdjustmentDeleteAcknowledgement(deletion.state, deletion.request, "deleted");
  const staleAfterDelete = reconcileBudgetAdjustmentPatchAcknowledgement(deleted.state,
    patch.request, { ...adjustment, amount: 2 });
  assert.equal(staleAfterDelete.outcome, "stale");
  assert.deepEqual(staleAfterDelete.state.rows, []);
});

test("definitive patch failure retries, while ambiguity needs a later authoritative range", (): void => {
  const adjustment = createAdjustment("failure", 0, "2026-07", "spend", "Food", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const edited = editDraft(initial, adjustment.adjustmentId, createDraft("1", "2026-07", "Food", ""));
  const definitiveRequest = issueBudgetAdjustmentPatchRequest(edited, adjustment.adjustmentId);
  const newer = editDraft(definitiveRequest.state, adjustment.adjustmentId, createDraft("2", "2026-07", "Food", ""));
  const definitive = reconcileBudgetAdjustmentPatchDefinitiveFailure(newer, definitiveRequest.request);
  assert.deepEqual(issueBudgetAdjustmentPatchRequest(definitive,
    adjustment.adjustmentId).request.params, { amount: 2 });

  const ambiguousRequest = issueBudgetAdjustmentPatchRequest(edited, adjustment.adjustmentId);
  const oldRange = issueBudgetAdjustmentRangeRequest(ambiguousRequest.state, "2026-07", "2026-07");
  const ambiguous = reconcileBudgetAdjustmentPatchAmbiguousFailure(oldRange.state, ambiguousRequest.request);
  const stale = reconcileBudgetAdjustmentRangeResponse(ambiguous, oldRange.request, [{ ...adjustment, amount: 1 }]);
  assert.equal(stale.rows[0].confirmed.amount, 0);
  assert.throws(() => issueBudgetAdjustmentPatchRequest(stale, adjustment.adjustmentId),
    /range issued after.*ambiguous failure/);
  const freshRange = issueBudgetAdjustmentRangeRequest(stale, "2026-07", "2026-07");
  const refreshed = reconcileBudgetAdjustmentRangeResponse(freshRange.state,
    freshRange.request, [{ ...adjustment, amount: 1 }]);
  assert.equal(refreshed.rows[0].confirmed.amount, 1);
  assert.equal(refreshed.rows[0].draft.amountInput, "1");
  assert.equal(refreshed.ambiguousRangeRequirementByAdjustmentId.size, 0);
});

test("ambiguous moves require a found row or accepted source and target coverage", (): void => {
  const adjustment = createAdjustment("ambiguous-move", 0, "2026-07", "spend", "Source", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const patch = issueBudgetAdjustmentPatchRequest(editDraft(initial, adjustment.adjustmentId, createDraft("0", "2026-08", "Target", "")), adjustment.adjustmentId);
  const preFailure = issueBudgetAdjustmentRangeRequest(patch.state, "2026-07", "2026-08");
  const ambiguous = reconcileBudgetAdjustmentPatchAmbiguousFailure(preFailure.state, patch.request);
  const target = { ...adjustment, month: "2026-08", category: "Target" };
  const stale = reconcileBudgetAdjustmentRangeResponse(ambiguous, preFailure.request, [target]);
  assert.deepEqual([stale.rows[0].confirmed.month, stale.ambiguousRangeRequirementByAdjustmentId.size], ["2026-07", 1]);
  const sourceOnly = issueBudgetAdjustmentRangeRequest(stale, "2026-07", "2026-07");
  const unresolved = reconcileBudgetAdjustmentRangeResponse(sourceOnly.state, sourceOnly.request, []);
  assert.deepEqual(unresolved.rows[0].draft, createDraft("0", "2026-08", "Target", ""));
  assert.equal(unresolved.ambiguousRangeRequirementByAdjustmentId.size, 1);
  assert.throws(() => issueBudgetAdjustmentPatchRequest(unresolved, adjustment.adjustmentId), /range issued after.*ambiguous failure/);
  assert.throws(() => issueBudgetAdjustmentDeleteRequest(unresolved, adjustment.adjustmentId), /Cannot delete.*range issued after.*ambiguous failure/);
  for (const months of [["2026-07", "2026-08"], ["2026-08", "2026-07"]]) {
    let split = stale;
    for (const month of months) {
      const range = issueBudgetAdjustmentRangeRequest(split, month, month);
      split = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, []);
    }
    assert.deepEqual([split.rows, split.ambiguousRangeRequirementByAdjustmentId.size], [[], 0]);
  }
  const targetRange = issueBudgetAdjustmentRangeRequest(unresolved, "2026-08", "2026-08");
  const found = reconcileBudgetAdjustmentRangeResponse(targetRange.state, targetRange.request, [target]);
  assert.deepEqual([found.rows[0].confirmed.month, found.ambiguousRangeRequirementByAdjustmentId.size], ["2026-08", 0]);
  assert.equal(issueBudgetAdjustmentDeleteRequest(found, adjustment.adjustmentId).request.confirmed.month, "2026-08");
  const combined = issueBudgetAdjustmentRangeRequest(ambiguous, "2026-07", "2026-08");
  const absent = reconcileBudgetAdjustmentRangeResponse(combined.state, combined.request, []);
  assert.deepEqual([absent.rows, absent.ambiguousRangeRequirementByAdjustmentId.size], [[], 0]);
  const olderTarget = issueBudgetAdjustmentRangeRequest(ambiguous, "2026-08", "2026-08");
  const newerTarget = issueBudgetAdjustmentRangeRequest(olderTarget.state, "2026-08", "2026-08");
  const newestAbsent = reconcileBudgetAdjustmentRangeResponse(newerTarget.state, newerTarget.request, []);
  const staleFound = reconcileBudgetAdjustmentRangeResponse(newestAbsent, olderTarget.request, [target]);
  assert.deepEqual([staleFound.rows[0].confirmed.month, staleFound.ambiguousRangeRequirementByAdjustmentId.size], ["2026-07", 1]);
});

test("zero and invalid moved drafts provisionally invalidate their confirmed source", (): void => {
  const adjustment = createAdjustment("provisional", 0, "2026-07", "spend", "Source", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07");
  const sourceKey = getBudgetAdjustmentCellKey("2026-07", "spend", "Source");
  for (const [amountInput, noteInput] of [["0", ""], ["invalid", ""], ["0", "x".repeat(2001)]]) {
    const moved = editDraft(initial, adjustment.adjustmentId,
      createDraft(amountInput, "invalid-month", "", noteInput));
    assert.equal(getBudgetAdjustmentInvalidatedCellKeys(moved).has(sourceKey), true);
    assert.equal(moved.cellInvalidationRevisionByKey.size, 0);
  }
});

test("confirmed zero moves and both delete outcomes invalidate source cells", (): void => {
  for (const outcome of ["deleted", "already-absent"] as const) {
    const move = createAdjustment(`move-${outcome}`, 0, "2026-07", "spend", "Move", null, 1);
    const remove = createAdjustment(`delete-${outcome}`, 0, "2026-08", "spend", "Delete", null, 1);
    const initial = createBudgetAdjustmentRowsReconciliationState([remove, move], "2026-07");
    const patch = issueBudgetAdjustmentPatchRequest(editDraft(initial, move.adjustmentId,
      createDraft("0", "2026-09", "Target", "")), move.adjustmentId);
    const moved = reconcileBudgetAdjustmentPatchAcknowledgement(patch.state, patch.request,
      { ...move, month: "2026-09", category: "Target", updatedAt: "2026-07-02T00:00:00.000Z" },
    );
    const deletion = issueBudgetAdjustmentDeleteRequest(moved.state, remove.adjustmentId);
    assert.throws(() => issueBudgetAdjustmentPatchRequest(deletion.state,
      remove.adjustmentId), /delete request is pending/);
    const deleted = reconcileBudgetAdjustmentDeleteAcknowledgement(deletion.state, deletion.request, outcome);
    assert.equal(deleted.state.deletedMutationRevisionById.has(remove.adjustmentId), false);
    assert.equal(deleted.state.cellInvalidationRevisionByKey.has(
      getBudgetAdjustmentCellKey("2026-07", "spend", "Move")), true);
    assert.equal(deleted.state.cellInvalidationRevisionByKey.has(
      getBudgetAdjustmentCellKey("2026-08", "spend", "Delete")), true);
    const repeated = reconcileBudgetAdjustmentDeleteAcknowledgement(deleted.state, deletion.request, outcome);
    assert.equal(repeated.outcome, "already-applied");
    assert.equal(repeated.state, deleted.state);
  }
});

test("delete failures preserve drafts, permit retry, and mark ambiguity only when needed", (): void => {
  const adjustment = createAdjustment("delete-retry", 4, "2026-07", "spend", "Food", null, 1);
  const dirty = editDraft(
    createBudgetAdjustmentRowsReconciliationState([adjustment], "2026-07"),
    adjustment.adjustmentId,
    createDraft("5", "2026-07", "Food", "local"),
  );
  const definitiveRequest = issueBudgetAdjustmentDeleteRequest(dirty, adjustment.adjustmentId);
  const definitive = reconcileBudgetAdjustmentDeleteDefinitiveFailure(
    definitiveRequest.state, definitiveRequest.request,
  );
  assert.deepEqual(definitive.rows[0].draft, dirty.rows[0].draft);
  assert.doesNotThrow(() => issueBudgetAdjustmentDeleteRequest(definitive, adjustment.adjustmentId));
  assert.equal(definitive.ambiguousRangeRequirementByAdjustmentId.size, 0);

  const ambiguousRequest = issueBudgetAdjustmentDeleteRequest(dirty, adjustment.adjustmentId);
  const oldRange = issueBudgetAdjustmentRangeRequest(ambiguousRequest.state, "2026-07", "2026-07");
  const ambiguous = reconcileBudgetAdjustmentDeleteAmbiguousFailure(oldRange.state, ambiguousRequest.request);
  const stale = reconcileBudgetAdjustmentRangeResponse(ambiguous, oldRange.request, []);
  assert.equal(stale.rows.length, 1);
  assert.throws(() => issueBudgetAdjustmentDeleteRequest(
    stale, adjustment.adjustmentId,
  ), /range issued after.*ambiguous failure/);
  const freshRange = issueBudgetAdjustmentRangeRequest(stale, "2026-07", "2026-07");
  const absent = reconcileBudgetAdjustmentRangeResponse(freshRange.state, freshRange.request, []);
  assert.deepEqual(absent.rows, []);
  assert.equal(absent.ambiguousRangeRequirementByAdjustmentId.size, 0);
});

test("range ordering owns moves, deletion, and off-range source invalidations", (): void => {
  const original = createAdjustment("range-row", 0, "2026-07", "spend", "A", null, 1);
  const movedB = { ...original, month: "2026-08", category: "B" };
  const movedC = { ...original, month: "2026-09", category: "C" };
  for (const newerFirst of [false, true]) {
    const initial = createBudgetAdjustmentRowsReconciliationState([original], "2026-07");
    const older = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-08");
    const newer = issueBudgetAdjustmentRangeRequest(older.state, "2026-07", "2026-09");
    const first = newerFirst
      ? reconcileBudgetAdjustmentRangeResponse(newer.state, newer.request, [movedC])
      : reconcileBudgetAdjustmentRangeResponse(newer.state, older.request, [movedB]);
    const final = newerFirst
      ? reconcileBudgetAdjustmentRangeResponse(first, older.request, [movedB])
      : reconcileBudgetAdjustmentRangeResponse(first, newer.request, [movedC]);
    assert.deepEqual(final.rows.map((row) => [row.confirmed.month, row.confirmed.category]), [
      ["2026-09", "C"],
    ]);
    assert.deepEqual([
      final.latestMutationRevision,
      final.confirmedMutationRevisionById.size,
      final.deletedMutationRevisionById.size,
    ], [0, 0, 0]);
  }

  const initial = createBudgetAdjustmentRowsReconciliationState([original], "2026-07");
  const move = issueBudgetAdjustmentRangeRequest(initial, "2026-08", "2026-08");
  const moved = reconcileBudgetAdjustmentRangeResponse(move.state, move.request, [movedB]);
  const sourceKey = getBudgetAdjustmentCellKey("2026-07", "spend", "A");
  assert.equal(getBudgetAdjustmentInvalidatedCellKeys(moved).has(sourceKey), true);
  const deletion = issueBudgetAdjustmentRangeRequest(moved, "2026-08", "2026-08");
  const deleted = reconcileBudgetAdjustmentRangeResponse(deletion.state, deletion.request, []);
  assert.deepEqual(deleted.rows, []);
  assert.equal(deleted.latestMutationRevision, 0);
  const source = issueBudgetAdjustmentRangeRequest(deleted, "2026-07", "2026-07");
  const cleared = reconcileBudgetAdjustmentRangeResponse(source.state, source.request, []);
  assert.equal(getBudgetAdjustmentInvalidatedCellKeys(cleared).has(sourceKey), false);
});

test("stale ranges cannot regress patch/delete, while later source ranges clear invalidations", (): void => {
  const move = createAdjustment("patched", 0, "2026-07", "spend", "Move", null, 1);
  const remove = createAdjustment("deleted", 0, "2026-07", "spend", "Delete", null, 1);
  const initial = createBudgetAdjustmentRowsReconciliationState([remove, move], "2026-07");
  const staleRange = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-08");
  const patch = issueBudgetAdjustmentPatchRequest(
    editDraft(staleRange.state, move.adjustmentId, createDraft("0", "2026-08", "Target", "")),
    move.adjustmentId,
  );
  const pendingRange = issueBudgetAdjustmentRangeRequest(patch.state, "2026-07", "2026-07");
  const protectedPending = reconcileBudgetAdjustmentRangeResponse(
    pendingRange.state, pendingRange.request, [{ ...move, amount: 99 }, remove],
  );
  assert.equal(protectedPending.rows.find((row) => row.adjustmentId === move.adjustmentId)?.confirmed.amount, 0);
  const patched = reconcileBudgetAdjustmentPatchAcknowledgement(
    protectedPending,
    patch.request,
    { ...move, month: "2026-08", category: "Target", updatedAt: "2026-07-02T00:00:00.000Z" },
  );
  const deletion = issueBudgetAdjustmentDeleteRequest(patched.state, remove.adjustmentId);
  const deleted = reconcileBudgetAdjustmentDeleteAcknowledgement(
    deletion.state, deletion.request, "deleted",
  );
  assert.equal(deleted.state.deletedMutationRevisionById.has(remove.adjustmentId), true);
  const failedStale = reconcileBudgetAdjustmentRangeFailure(deleted.state, staleRange.request);
  assert.equal(failedStale.deletedMutationRevisionById.has(remove.adjustmentId), false);
  assert.deepEqual(failedStale.rows.map((row) => row.adjustmentId), ["patched"]);
  const target = { ...move, month: "2026-08", category: "Target" };
  const targetRange = issueBudgetAdjustmentRangeRequest(deleted.state, "2026-08", "2026-08");
  const canonical = reconcileBudgetAdjustmentRangeResponse(targetRange.state, targetRange.request, [target]);
  const stale = reconcileBudgetAdjustmentRangeResponse(canonical, staleRange.request, [move, remove]);
  assert.deepEqual(stale.rows.map((row) => [row.adjustmentId, row.confirmed.month]), [
    ["patched", "2026-08"],
  ]);
  assert.equal(stale.confirmedMutationRevisionById.has(move.adjustmentId), false);
  assert.equal(stale.deletedMutationRevisionById.has(remove.adjustmentId), false);
  const repeated = reconcileBudgetAdjustmentDeleteAcknowledgement(stale, deletion.request, "deleted");
  assert.equal(repeated.outcome, "already-applied");
  assert.equal(repeated.state, stale);
  const emptyRange = issueBudgetAdjustmentRangeRequest(deleted.state, "2026-08", "2026-08");
  const empty = reconcileBudgetAdjustmentRangeResponse(emptyRange.state, emptyRange.request, []);
  assert.deepEqual(reconcileBudgetAdjustmentRangeResponse(
    empty, staleRange.request, [move, remove],
  ).rows, []);
  const moveKey = getBudgetAdjustmentCellKey("2026-07", "spend", "Move");
  const deleteKey = getBudgetAdjustmentCellKey("2026-07", "spend", "Delete");
  assert.equal(stale.cellInvalidationRevisionByKey.has(moveKey), true);
  assert.equal(stale.cellInvalidationRevisionByKey.has(deleteKey), true);
  const sourceRange = issueBudgetAdjustmentRangeRequest(stale, "2026-07", "2026-07");
  assert.equal(sourceRange.request.mutationRevision, stale.latestMutationRevision);
  const refreshed = reconcileBudgetAdjustmentRangeResponse(sourceRange.state, sourceRange.request, []);
  assert.equal(refreshed.cellInvalidationRevisionByKey.has(moveKey), false);
  assert.equal(refreshed.cellInvalidationRevisionByKey.has(deleteKey), false);
  assert.equal(refreshed.rows[0].confirmed.month, "2026-08");
});

test("mutation history is bounded, retains pending requests, and transitions are immutable", (): void => {
  const pendingRow = createAdjustment("pending", 0, "2026-08", "spend", "B", null, 1);
  const retryRow = createAdjustment("retry", 0, "2026-07", "income", "A", null, 1);
  const adjustments = [pendingRow, retryRow];
  const originalAdjustments = structuredClone(adjustments);
  const initial = createBudgetAdjustmentRowsReconciliationState(adjustments, "2026-07");
  const originalRows = structuredClone(initial.rows);
  const pending = issueBudgetAdjustmentDeleteRequest(initial, pendingRow.adjustmentId);
  let state = pending.state;
  const settled: Array<BudgetAdjustmentPatchRequest> = [];
  for (let index = 1; index <= 12; index += 1) {
    state = editDraft(state, retryRow.adjustmentId, createDraft(String(index), "2026-07", "A", ""));
    const issued = issueBudgetAdjustmentPatchRequest(state, retryRow.adjustmentId);
    settled.push(issued.request);
    state = reconcileBudgetAdjustmentPatchDefinitiveFailure(issued.state, issued.request);
  }
  assert.equal(state.settledMutationRequestIds.size, 8);
  assert.equal(state.mutationRequestsById.size, 9);
  assert.equal(state.mutationRequestsById.has(pending.request.requestId), true);
  assert.throws(
    () => reconcileBudgetAdjustmentPatchDefinitiveFailure(state, settled[0]),
    /outside the recent settled request history/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentPatchDefinitiveFailure(state, settled.at(-1)!),
    /Cannot fail settled/,
  );
  assert.deepEqual(state.rows.map((row) => row.adjustmentId), ["retry", "pending"]);
  assert.deepEqual(adjustments, originalAdjustments);
  assert.deepEqual(initial.rows, originalRows);
  assert.equal(initial.latestMutationRequestId, 0);
  assert.equal(initial.mutationRequestsById.size, 0);
});
