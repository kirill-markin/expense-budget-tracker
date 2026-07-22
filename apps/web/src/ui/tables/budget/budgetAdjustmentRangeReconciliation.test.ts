import assert from "node:assert/strict";
import test from "node:test";

import type {
  BudgetAdjustment,
  BudgetAdjustmentDirection,
} from "@/server/budget/budgetAdjustments";
import {
  createBudgetAdjustmentRangeReconciliationState,
  issueBudgetAdjustmentRangeRequest,
  reconcileBudgetAdjustmentRangeFailure,
  reconcileBudgetAdjustmentRangeResponse,
  replaceBudgetAdjustmentRangeDraft,
  type BudgetAdjustmentRangeProvenance,
  type BudgetAdjustmentRangeReconciliationState,
  type BudgetAdjustmentRangeRequest,
} from "@/ui/tables/budget/budgetAdjustmentRangeReconciliation";
import type { BudgetAdjustmentDraft } from "@/ui/tables/budget/budgetAdjustmentRowsState";

const createAdjustment = (
  adjustmentId: string,
  amount: number,
  month: string,
  direction: BudgetAdjustmentDirection,
  category: string,
  note: string | null,
  updatedDay: number,
): BudgetAdjustment => ({
  adjustmentId,
  amount,
  month,
  direction,
  category,
  note,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: `2026-07-${String(updatedDay).padStart(2, "0")}T00:00:00.000Z`,
});

const createDraft = (
  amountInput: string,
  noteInput: string,
  month: string,
  category: string,
): BudgetAdjustmentDraft => ({ amountInput, noteInput, month, category });

const replaceDraft = (
  state: BudgetAdjustmentRangeReconciliationState,
  adjustmentId: string,
  draft: BudgetAdjustmentDraft,
): BudgetAdjustmentRangeReconciliationState =>
  replaceBudgetAdjustmentRangeDraft(state, adjustmentId, draft);

type MoveThenDeleteScenario = Readonly<{
  adjustment: BudgetAdjustment;
  state: BudgetAdjustmentRangeReconciliationState;
  julyRequest: BudgetAdjustmentRangeRequest;
  augustMoveRequest: BudgetAdjustmentRangeRequest;
  augustDeleteRequest: BudgetAdjustmentRangeRequest;
}>;

const createMoveThenDeleteScenario = (): MoveThenDeleteScenario => {
  const adjustment = createAdjustment("move-delete", 10, "2026-07", "spend", "A", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([]);
  const july = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  const augustMove = issueBudgetAdjustmentRangeRequest(july.state, "2026-08", "2026-08");
  const augustDelete = issueBudgetAdjustmentRangeRequest(
    augustMove.state,
    "2026-08",
    "2026-08",
  );
  return {
    adjustment,
    state: augustDelete.state,
    julyRequest: july.request,
    augustMoveRequest: augustMove.request,
    augustDeleteRequest: augustDelete.request,
  };
};

const getExpectedMoveThenDeleteProvenance = (
  scenario: MoveThenDeleteScenario,
): BudgetAdjustmentRangeProvenance => ({
  direction: "spend",
  presenceRequestIdByMonth: new Map([
    ["2026-07", scenario.julyRequest.requestId],
    ["2026-08", scenario.augustMoveRequest.requestId],
  ]),
  absenceRequestIdByMonth: new Map([
    ["2026-08", scenario.augustDeleteRequest.requestId],
  ]),
  deletedThroughRequestId: scenario.augustMoveRequest.requestId,
});

test("a newer same-month response applies A to B to C when the older response arrives first", (): void => {
  const adjustment = createAdjustment("move", 10, "2026-07", "spend", "A", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const first = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  const second = issueBudgetAdjustmentRangeRequest(first.state, "2026-07", "2026-07");

  const afterFirst = reconcileBudgetAdjustmentRangeResponse(second.state, first.request, [
    { ...adjustment, category: "B", updatedAt: "2026-07-02T00:00:00.000Z" },
  ]);
  const final = reconcileBudgetAdjustmentRangeResponse(afterFirst, second.request, [
    { ...adjustment, category: "C", updatedAt: "2026-07-03T00:00:00.000Z" },
  ]);

  assert.equal(afterFirst.rows[0].confirmed.category, "B");
  assert.equal(final.rows[0].confirmed.category, "C");
  assert.equal(final.rows[0].draft.category, "C");
});

test("an older same-month response cannot regress A to C back to B when it arrives last", (): void => {
  const adjustment = createAdjustment("move", 10, "2026-07", "spend", "A", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const first = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  const second = issueBudgetAdjustmentRangeRequest(first.state, "2026-07", "2026-07");

  const afterSecond = reconcileBudgetAdjustmentRangeResponse(second.state, second.request, [
    { ...adjustment, category: "C", updatedAt: "2026-07-03T00:00:00.000Z" },
  ]);
  const final = reconcileBudgetAdjustmentRangeResponse(afterSecond, first.request, [
    { ...adjustment, category: "B", updatedAt: "2026-07-02T00:00:00.000Z" },
  ]);

  assert.equal(afterSecond.rows[0].confirmed.category, "C");
  assert.equal(final.rows[0].confirmed.category, "C");
  assert.equal(final.acceptedRangeRequestIdByMonth.get("2026-07"), second.request.requestId);
});

test("range response order cannot clear local field edits that temporarily match the server", (): void => {
  const adjustment = createAdjustment(
    "dirty-order",
    10,
    "2026-07",
    "spend",
    "Initial category",
    "Initial note",
    1,
  );
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const edited = replaceDraft(initial, adjustment.adjustmentId, createDraft(
    "20",
    "Local note",
    "2026-08",
    "Local category",
  ));
  const oldRequest = issueBudgetAdjustmentRangeRequest(edited, "2026-07", "2026-09");
  const newRequest = issueBudgetAdjustmentRangeRequest(
    oldRequest.state,
    "2026-07",
    "2026-09",
  );
  const oldResponse = createAdjustment(
    adjustment.adjustmentId,
    20,
    "2026-08",
    "spend",
    "Local category",
    "Local note",
    2,
  );
  const newResponse = createAdjustment(
    adjustment.adjustmentId,
    30,
    "2026-09",
    "spend",
    "Server category",
    "Server note",
    3,
  );

  const afterOld = reconcileBudgetAdjustmentRangeResponse(
    newRequest.state,
    oldRequest.request,
    [oldResponse],
  );
  const chronological = reconcileBudgetAdjustmentRangeResponse(
    afterOld,
    newRequest.request,
    [newResponse],
  );
  const afterNew = reconcileBudgetAdjustmentRangeResponse(
    newRequest.state,
    newRequest.request,
    [newResponse],
  );
  const reversed = reconcileBudgetAdjustmentRangeResponse(
    afterNew,
    oldRequest.request,
    [oldResponse],
  );

  assert.deepEqual(chronological.rows[0].confirmed, reversed.rows[0].confirmed);
  assert.deepEqual(chronological.rows[0].draft, reversed.rows[0].draft);
  assert.deepEqual(chronological.rows[0].confirmed, {
    amount: 30,
    note: "Server note",
    month: "2026-09",
    category: "Server category",
  });
  assert.deepEqual(chronological.rows[0].draft, createDraft(
    "20",
    "Local note",
    "2026-08",
    "Local category",
  ));
  const expectedDirtyFields = {
    amount: true,
    note: true,
    month: true,
    category: true,
  };
  assert.deepEqual(
    chronological.dirtyFieldsByAdjustmentId.get(adjustment.adjustmentId),
    expectedDirtyFields,
  );
  assert.deepEqual(
    reversed.dirtyFieldsByAdjustmentId.get(adjustment.adjustmentId),
    expectedDirtyFields,
  );
  const partiallyReverted = replaceDraft(
    chronological,
    adjustment.adjustmentId,
    createDraft("20", "Server note", "2026-09", "Server category"),
  );
  assert.deepEqual(partiallyReverted.dirtyFieldsByAdjustmentId.get(adjustment.adjustmentId), {
    amount: true,
    note: false,
    month: false,
    category: false,
  });
  const fullyReverted = replaceDraft(
    partiallyReverted,
    adjustment.adjustmentId,
    createDraft("30", "Server note", "2026-09", "Server category"),
  );
  assert.equal(fullyReverted.dirtyFieldsByAdjustmentId.has(adjustment.adjustmentId), false);
  assert.equal(fullyReverted.rows.length, 1);
});

test("July to August to deleted stays deleted in chronological response order", (): void => {
  const scenario = createMoveThenDeleteScenario();
  const afterJuly = reconcileBudgetAdjustmentRangeResponse(
    scenario.state,
    scenario.julyRequest,
    [scenario.adjustment],
  );
  const afterMove = reconcileBudgetAdjustmentRangeResponse(
    afterJuly,
    scenario.augustMoveRequest,
    [{ ...scenario.adjustment, month: "2026-08", category: "B" }],
  );
  const final = reconcileBudgetAdjustmentRangeResponse(
    afterMove,
    scenario.augustDeleteRequest,
    [],
  );

  assert.deepEqual(final.rows, []);
  assert.deepEqual(
    final.rangeProvenanceByAdjustmentId.get(scenario.adjustment.adjustmentId),
    getExpectedMoveThenDeleteProvenance(scenario),
  );
});

test("July to August to deleted stays deleted in reversed response order", (): void => {
  const scenario = createMoveThenDeleteScenario();
  const afterDelete = reconcileBudgetAdjustmentRangeResponse(
    scenario.state,
    scenario.augustDeleteRequest,
    [],
  );
  const afterMove = reconcileBudgetAdjustmentRangeResponse(
    afterDelete,
    scenario.augustMoveRequest,
    [{ ...scenario.adjustment, month: "2026-08", category: "B" }],
  );
  assert.deepEqual(
    afterMove.rangeProvenanceByAdjustmentId.get(scenario.adjustment.adjustmentId),
    {
      direction: "spend",
      presenceRequestIdByMonth: new Map([
        ["2026-08", scenario.augustMoveRequest.requestId],
      ]),
      absenceRequestIdByMonth: new Map([
        ["2026-08", scenario.augustDeleteRequest.requestId],
      ]),
      deletedThroughRequestId: scenario.augustMoveRequest.requestId,
    },
  );
  const final = reconcileBudgetAdjustmentRangeResponse(
    afterMove,
    scenario.julyRequest,
    [scenario.adjustment],
  );

  assert.deepEqual(final.rows, []);
  assert.deepEqual(
    final.rangeProvenanceByAdjustmentId.get(scenario.adjustment.adjustmentId),
    getExpectedMoveThenDeleteProvenance(scenario),
  );
});

test("a non-overlapping source absence and destination move converge in both response orders", (): void => {
  const adjustment = createAdjustment("non-overlap-move", 10, "2026-07", "spend", "A", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const august = issueBudgetAdjustmentRangeRequest(initial, "2026-08", "2026-08");
  const july = issueBudgetAdjustmentRangeRequest(august.state, "2026-07", "2026-07");
  const moved = { ...adjustment, month: "2026-08", category: "B" };

  const chronologicalMove = reconcileBudgetAdjustmentRangeResponse(
    july.state,
    august.request,
    [moved],
  );
  const chronological = reconcileBudgetAdjustmentRangeResponse(
    chronologicalMove,
    july.request,
    [],
  );
  const reversedAbsence = reconcileBudgetAdjustmentRangeResponse(
    july.state,
    july.request,
    [],
  );
  const reversed = reconcileBudgetAdjustmentRangeResponse(
    reversedAbsence,
    august.request,
    [moved],
  );

  assert.deepEqual(reversed.rows, chronological.rows);
  assert.deepEqual(
    reversed.rangeProvenanceByAdjustmentId,
    chronological.rangeProvenanceByAdjustmentId,
  );
  assert.deepEqual(reversed.rangeProvenanceByAdjustmentId.get(adjustment.adjustmentId), {
    direction: "spend",
    presenceRequestIdByMonth: new Map([
      ["2026-07", 0],
      ["2026-08", august.request.requestId],
    ]),
    absenceRequestIdByMonth: new Map([
      ["2026-07", july.request.requestId],
    ]),
    deletedThroughRequestId: 0,
  });
  assert.deepEqual(reversed.rows.map((row) => row.confirmed), [{
    amount: 10,
    note: null,
    month: "2026-08",
    category: "B",
  }]);
});

test("overlapping ranges accept each month from its newest issued request", (): void => {
  const initial = createBudgetAdjustmentRangeReconciliationState([]);
  const first = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-08");
  const second = issueBudgetAdjustmentRangeRequest(first.state, "2026-08", "2026-09");
  const afterSecond = reconcileBudgetAdjustmentRangeResponse(second.state, second.request, [
    createAdjustment("august", 20, "2026-08", "spend", "August", null, 2),
    createAdjustment("september", 30, "2026-09", "spend", "September", null, 2),
  ]);
  const final = reconcileBudgetAdjustmentRangeResponse(afterSecond, first.request, [
    createAdjustment("july", 10, "2026-07", "spend", "July", null, 1),
    createAdjustment("august", 11, "2026-08", "spend", "August", null, 1),
  ]);

  assert.deepEqual(
    final.rows.map((row) => [row.adjustmentId, row.confirmed.amount]),
    [["july", 10], ["august", 20], ["september", 30]],
  );
  assert.equal(final.acceptedRangeRequestIdByMonth.get("2026-07"), first.request.requestId);
  assert.equal(final.acceptedRangeRequestIdByMonth.get("2026-08"), second.request.requestId);
  assert.equal(final.acceptedRangeRequestIdByMonth.get("2026-09"), second.request.requestId);
});

test("non-overlapping ranges merge regardless of response order", (): void => {
  const initial = createBudgetAdjustmentRangeReconciliationState([]);
  const july = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  const september = issueBudgetAdjustmentRangeRequest(july.state, "2026-09", "2026-09");
  const afterSeptember = reconcileBudgetAdjustmentRangeResponse(
    september.state,
    september.request,
    [createAdjustment("september", 30, "2026-09", "income", "Salary", null, 2)],
  );
  const final = reconcileBudgetAdjustmentRangeResponse(
    afterSeptember,
    july.request,
    [createAdjustment("july", 10, "2026-07", "spend", "Food", null, 1)],
  );

  assert.deepEqual(final.rows.map((row) => row.adjustmentId), ["july", "september"]);
});

test("range refreshes preserve dirty fields and rebase untouched fields", (): void => {
  const adjustment = createAdjustment(
    "dirty",
    10,
    "2026-07",
    "spend",
    "Saved",
    "Original",
    1,
  );
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const dirty = replaceDraft(initial, adjustment.adjustmentId, createDraft(
    "25",
    "Original",
    "2026-07",
    "Local category",
  ));
  const range = issueBudgetAdjustmentRangeRequest(dirty, "2026-07", "2026-08");
  const final = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, [
    createAdjustment("dirty", 99, "2026-08", "spend", "Server category", "Server note", 2),
  ]);

  assert.deepEqual(final.rows[0].draft, createDraft(
    "25",
    "Server note",
    "2026-08",
    "Local category",
  ));
  assert.deepEqual(final.rows[0].confirmed, {
    amount: 99,
    note: "Server note",
    month: "2026-08",
    category: "Server category",
  });
});

test("invalid draft fields survive while clean fields still rebase", (): void => {
  const adjustment = createAdjustment("invalid", 10, "2026-07", "spend", "Saved", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const dirty = replaceDraft(initial, adjustment.adjustmentId, createDraft(
    "not-an-integer",
    "local note",
    "2026-07",
    "Saved",
  ));
  const range = issueBudgetAdjustmentRangeRequest(dirty, "2026-07", "2026-07");
  const final = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, [
    { ...adjustment, amount: 99, category: "Server", updatedAt: "2026-07-02T00:00:00.000Z" },
  ]);

  assert.deepEqual(
    final.rows[0].draft,
    createDraft("not-an-integer", "local note", "2026-07", "Server"),
  );
  assert.equal(final.rows[0].confirmed.amount, 99);
  assert.equal(final.rows[0].confirmed.category, "Server");
});

test("an absent clean row is removed without discarding an absent dirty row", (): void => {
  const clean = createAdjustment("clean", 10, "2026-07", "spend", "Clean", null, 1);
  const dirty = createAdjustment("dirty", 20, "2026-07", "spend", "Dirty", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([clean, dirty]);
  const edited = replaceDraft(
    initial,
    dirty.adjustmentId,
    createDraft("invalid", "", "2026-07", "Dirty"),
  );
  const range = issueBudgetAdjustmentRangeRequest(edited, "2026-07", "2026-07");
  const final = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, []);

  assert.deepEqual(final.rows.map((row) => row.adjustmentId), ["dirty"]);
  assert.equal(final.rows[0].draft.amountInput, "invalid");
  assert.deepEqual(final.dirtyFieldsByAdjustmentId.get(dirty.adjustmentId), {
    amount: true,
    note: false,
    month: false,
    category: false,
  });
  const reverted = replaceDraft(
    final,
    dirty.adjustmentId,
    createDraft("20", "", "2026-07", "Dirty"),
  );
  assert.deepEqual(reverted.rows, []);
  assert.equal(reverted.dirtyFieldsByAdjustmentId.has(dirty.adjustmentId), false);
});

test("semantically equal blank, signed, zero, and formatted amounts retain raw input", (): void => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["", 0],
    ["   ", 0],
    ["+0", 0],
    ["-0", 0],
    ["00", 0],
    [" 0 ", 0],
    ["+10", 10],
    ["010", 10],
    [" 10 ", 10],
    ["-10", -10],
  ];

  for (const [amountInput, canonicalAmount] of cases) {
    const adjustment = createAdjustment(
      `raw-${amountInput || "blank"}`,
      canonicalAmount,
      "2026-07",
      "spend",
      "Raw",
      "Old",
      1,
    );
    const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
    const edited = replaceDraft(
      initial,
      adjustment.adjustmentId,
      createDraft(amountInput, "Old", "2026-07", "Raw"),
    );
    const unchangedRange = issueBudgetAdjustmentRangeRequest(edited, "2026-07", "2026-07");
    const unchanged = reconcileBudgetAdjustmentRangeResponse(
      unchangedRange.state,
      unchangedRange.request,
      [{ ...adjustment, note: "Server" }],
    );
    assert.equal(unchanged.rows[0].draft.amountInput, amountInput);
    assert.equal(unchanged.rows[0].draft.noteInput, "Server");

    const changedRange = issueBudgetAdjustmentRangeRequest(unchanged, "2026-07", "2026-07");
    const changed = reconcileBudgetAdjustmentRangeResponse(
      changedRange.state,
      changedRange.request,
      [{ ...adjustment, amount: canonicalAmount + 1, note: "Later" }],
    );
    assert.equal(changed.rows[0].draft.amountInput, String(canonicalAmount + 1));
  }
});

test("initial and range rows use the strict browser adjustment contract", (): void => {
  const adjustment = createAdjustment("strict", 0, "2026-07", "spend", "Strict", null, 1);
  assert.throws(
    () => createBudgetAdjustmentRangeReconciliationState([{ ...adjustment, adjustmentId: "" }]),
    /Initial budget adjustment[\s\S]*adjustmentId[\s\S]*between 1 and 200/,
  );
  assert.throws(
    () => createBudgetAdjustmentRangeReconciliationState([{ ...adjustment, extra: true }]),
    /Initial budget adjustment[\s\S]*Unrecognized key/,
  );

  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const range = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  const invalidRows: ReadonlyArray<readonly [unknown, RegExp]> = [
    [{ ...adjustment, category: undefined }, /category/],
    [{ ...adjustment, adjustmentId: "x".repeat(201) }, /adjustmentId[\s\S]*between 1 and 200/],
    [{ ...adjustment, note: 1 }, /note/],
    [{ ...adjustment, note: "n".repeat(2001) }, /note[\s\S]*at most 2000/],
    [{ ...adjustment, createdAt: "2026-07-01" }, /createdAt/],
    [{ ...adjustment, updatedAt: "not-a-timestamp" }, /updatedAt/],
    [{ ...adjustment, extra: true }, /Unrecognized key/],
  ];
  for (const [input, expected] of invalidRows) {
    assert.throws(
      () => reconcileBudgetAdjustmentRangeResponse(range.state, range.request, [input]),
      expected,
    );
  }
});

test("range responses reject out-of-range months, duplicate ids, and direction changes", (): void => {
  const adjustment = createAdjustment("row", 10, "2026-07", "spend", "Food", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const range = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");

  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(range.state, range.request, [
      { ...adjustment, month: "2026-08" },
    ]),
    /outside requested range 2026-07\.\.2026-07/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(
      range.state,
      range.request,
      [adjustment, { ...adjustment }],
    ),
    /duplicate id "row"/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(range.state, range.request, [
      { ...adjustment, direction: "income" },
    ]),
    /changed immutable direction.*spend to income/,
  );
  const removed = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, []);
  const refresh = issueBudgetAdjustmentRangeRequest(removed, "2026-07", "2026-07");
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(refresh.state, refresh.request, [
      { ...adjustment, direction: "income" },
    ]),
    /changed immutable direction.*spend to income/,
  );
});

test("request acknowledgements reject unknown, mismatched, repeated, and invalid requests", (): void => {
  const initial = createBudgetAdjustmentRangeReconciliationState([]);
  assert.throws(
    () => issueBudgetAdjustmentRangeRequest(initial, "2026-08", "2026-07"),
    /must not be after/,
  );
  assert.throws(
    () => issueBudgetAdjustmentRangeRequest(
      { ...initial, latestRequestId: Number.MAX_SAFE_INTEGER },
      "2026-07",
      "2026-07",
    ),
    /request id limit reached/,
  );
  const issued = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(issued.state, {
      ...issued.request,
      requestId: issued.request.requestId + 1,
    }, []),
    /not issued by this state/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(
      issued.state,
      { ...issued.request, monthTo: "2026-08" },
      [],
    ),
    /fields do not match the issued request/,
  );
  const invalidRequest: BudgetAdjustmentRangeRequest = {
    requestId: 0,
    monthFrom: "2026-07",
    monthTo: "2026-07",
  };
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(initial, invalidRequest, []),
    /request id.*positive safe integer/,
  );
  const settled = reconcileBudgetAdjustmentRangeResponse(issued.state, issued.request, []);
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(settled, issued.request, []),
    /more than once/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeFailure(settled, issued.request),
    /fail settled/,
  );
  assert.throws(
    () => replaceBudgetAdjustmentRangeDraft(
      initial,
      "missing",
      createDraft("0", "", "2026-07", "Missing"),
    ),
    /missing budget adjustment/,
  );
});

test("range failure settles only the exact network or validation request without accepting data", (): void => {
  const adjustment = createAdjustment("failure", 10, "2026-07", "spend", "Food", null, 1);
  const initial = createBudgetAdjustmentRangeReconciliationState([adjustment]);
  const first = issueBudgetAdjustmentRangeRequest(initial, "2026-07", "2026-07");
  const pending = issueBudgetAdjustmentRangeRequest(first.state, "2026-08", "2026-08");
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(pending.state, first.request, [
      { ...adjustment, note: 1 },
    ]),
    /range response row 0[\s\S]*note/,
  );
  const failed = reconcileBudgetAdjustmentRangeFailure(pending.state, first.request);

  assert.equal(failed.rows, pending.state.rows);
  assert.equal(
    failed.acceptedRangeRequestIdByMonth,
    pending.state.acceptedRangeRequestIdByMonth,
  );
  assert.equal(
    failed.rangeProvenanceByAdjustmentId,
    pending.state.rangeProvenanceByAdjustmentId,
  );
  assert.equal(failed.acceptedRangeRequestIdByMonth.size, 0);
  assert.equal(failed.requestsById.has(pending.request.requestId), true);
  assert.equal(failed.settledRequestIds.has(pending.request.requestId), false);
  assert.throws(
    () => reconcileBudgetAdjustmentRangeFailure(
      failed,
      { ...pending.request, monthFrom: "2026-07" },
    ),
    /fields do not match the issued request/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeFailure(failed, first.request),
    /fail settled/,
  );
});

test("success and failure history is bounded while every pending request is retained", (): void => {
  let state = createBudgetAdjustmentRangeReconciliationState([]);
  const pending = issueBudgetAdjustmentRangeRequest(state, "2026-07", "2026-07");
  state = pending.state;
  const succeeded: Array<BudgetAdjustmentRangeRequest> = [];
  const failed: Array<BudgetAdjustmentRangeRequest> = [];
  for (let index = 0; index < 12; index += 1) {
    const issued = issueBudgetAdjustmentRangeRequest(state, "2026-08", "2026-08");
    if (index % 2 === 0) {
      succeeded.push(issued.request);
      state = reconcileBudgetAdjustmentRangeResponse(issued.state, issued.request, []);
    } else {
      failed.push(issued.request);
      state = reconcileBudgetAdjustmentRangeFailure(issued.state, issued.request);
    }
  }

  assert.equal(state.settledRequestIds.size, 8);
  assert.equal(state.requestsById.size, 9);
  assert.equal(state.requestsById.has(pending.request.requestId), true);
  assert.equal(state.settledRequestIds.has(pending.request.requestId), false);
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(state, succeeded[0], []),
    /outside the recent settled request history/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeResponse(state, succeeded.at(-1)!, []),
    /more than once/,
  );
  assert.throws(
    () => reconcileBudgetAdjustmentRangeFailure(state, failed.at(-1)!),
    /fail settled/,
  );
});

test("range transitions sort deterministically without mutating any inputs", (): void => {
  const adjustments = [
    createAdjustment("z", 1, "2026-08", "spend", "Same", null, 1),
    createAdjustment("a", 2, "2026-08", "spend", "Same", null, 1),
    createAdjustment("income", 3, "2026-07", "income", "Income", null, 1),
  ];
  const originalAdjustments = structuredClone(adjustments);
  const initial = createBudgetAdjustmentRangeReconciliationState(adjustments);
  const originalRows = structuredClone(initial.rows);
  const originalProvenance = structuredClone(initial.rangeProvenanceByAdjustmentId);
  const draft = createDraft("4", "local", "2026-07", "Income");
  const originalDraft = structuredClone(draft);
  const edited = replaceDraft(initial, "income", draft);
  const range = issueBudgetAdjustmentRangeRequest(edited, "2026-07", "2026-08");
  const response = [...adjustments].reverse();
  const originalResponse = structuredClone(response);
  const final = reconcileBudgetAdjustmentRangeResponse(range.state, range.request, response);

  assert.deepEqual(final.rows.map((row) => row.adjustmentId), ["income", "a", "z"]);
  assert.deepEqual(adjustments, originalAdjustments);
  assert.deepEqual(response, originalResponse);
  assert.deepEqual(draft, originalDraft);
  assert.deepEqual(initial.rows, originalRows);
  assert.deepEqual(initial.rangeProvenanceByAdjustmentId, originalProvenance);
  assert.equal(initial.latestRequestId, 0);
  assert.equal(initial.requestsById.size, 0);
  assert.equal(edited.requestsById.size, 0);
  assert.equal(range.state.settledRequestIds.size, 0);
});
