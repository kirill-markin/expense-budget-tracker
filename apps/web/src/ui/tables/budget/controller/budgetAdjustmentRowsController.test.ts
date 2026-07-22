import assert from "node:assert/strict";
import test from "node:test";

import type {
  BudgetAdjustment,
  CreateBudgetAdjustmentParams,
  PatchBudgetAdjustmentParams,
} from "@/server/budget/budgetAdjustments";
import {
  createBudgetAdjustmentRowsController,
  type BudgetAdjustmentRowsControllerRuntime,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import type { BudgetAdjustmentDraft } from "@/ui/tables/budget/budgetAdjustmentRowsState";
import {
  BudgetAdjustmentApiError,
  type DeleteBudgetAdjustmentOutcome,
} from "@/ui/tables/budget/budgetTableApi";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}>;

type PatchCall = Readonly<{
  adjustmentId: string;
  params: PatchBudgetAdjustmentParams;
}>;

type FakeClock = Readonly<{
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel: (handle: ReturnType<typeof setTimeout>) => void;
  runNext: () => void;
  scheduledCallbackAt: (index: number) => () => void;
  size: () => number;
}>;

type ControllerHarness = Readonly<{
  runtime: BudgetAdjustmentRowsControllerRuntime;
  clock: FakeClock;
  createCalls: Array<CreateBudgetAdjustmentParams>;
  patchCalls: Array<PatchCall>;
  deleteCalls: Array<string>;
  invalidatedYears: Array<ReadonlySet<string>>;
  setCreateHandler: (
    handler: (params: CreateBudgetAdjustmentParams) => Promise<BudgetAdjustment>,
  ) => void;
  setPatchHandler: (
    handler: (adjustmentId: string, params: PatchBudgetAdjustmentParams) => Promise<BudgetAdjustment>,
  ) => void;
  setDeleteHandler: (
    handler: (adjustmentId: string) => Promise<DeleteBudgetAdjustmentOutcome>,
  ) => void;
}>;

const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_ID = "00000000-0000-4000-8000-000000000003";

const createDeferred = <T,>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = (): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  let rejectPromise: (error: Error) => void = (): void => {
    throw new Error("Deferred rejecter was used before initialization");
  };
  const promise = new Promise<T>((resolve, reject): void => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const createClock = (): FakeClock => {
  const tasks = new Map<ReturnType<typeof setTimeout>, () => void>();
  const scheduledCallbacks: Array<() => void> = [];
  return {
    schedule: (callback, _delayMs): ReturnType<typeof setTimeout> => {
      const handle = setTimeout((): void => undefined, 60_000);
      clearTimeout(handle);
      tasks.set(handle, callback);
      scheduledCallbacks.push(callback);
      return handle;
    },
    cancel: (handle): void => {
      tasks.delete(handle);
    },
    runNext: (): void => {
      const next = tasks.entries().next().value as
        | readonly [ReturnType<typeof setTimeout>, () => void]
        | undefined;
      if (next === undefined) throw new Error("No scheduled task is available");
      tasks.delete(next[0]);
      next[1]();
    },
    scheduledCallbackAt: (index): (() => void) => {
      const callback = scheduledCallbacks[index];
      if (callback === undefined) {
        throw new Error(`No scheduled callback is available at index ${index}`);
      }
      return callback;
    },
    size: (): number => tasks.size,
  };
};

const createAdjustment = (
  adjustmentId: string,
  amount: number,
  month: string,
  category: string,
  note: string | null,
): BudgetAdjustment => ({
  adjustmentId,
  amount,
  month,
  direction: "spend",
  category,
  note,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
});

const createDraft = (
  amountInput: string,
  month: string,
  category: string,
  noteInput: string,
): BudgetAdjustmentDraft => ({ amountInput, month, category, noteInput });


const applyPatch = (
  adjustment: BudgetAdjustment,
  params: PatchBudgetAdjustmentParams,
): BudgetAdjustment => ({
  ...adjustment,
  amount: params.amount ?? adjustment.amount,
  note: params.note !== undefined ? params.note : adjustment.note,
  month: params.month ?? adjustment.month,
  category: params.category ?? adjustment.category,
  updatedAt: "2026-07-03T00:00:00.000Z",
});

const fromCreateParams = (params: CreateBudgetAdjustmentParams): BudgetAdjustment => ({
  adjustmentId: params.adjustmentId,
  amount: params.amount,
  month: params.month,
  direction: params.direction,
  category: params.category,
  note: params.note,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

const createHarness = (
  initialAdjustments: ReadonlyArray<BudgetAdjustment>,
): ControllerHarness => {
  const clock = createClock();
  const createCalls: Array<CreateBudgetAdjustmentParams> = [];
  const patchCalls: Array<PatchCall> = [];
  const deleteCalls: Array<string> = [];
  const invalidatedYears: Array<ReadonlySet<string>> = [];
  let createHandler = async (params: CreateBudgetAdjustmentParams): Promise<BudgetAdjustment> =>
    fromCreateParams(params);
  let patchHandler = async (
    adjustmentId: string,
    params: PatchBudgetAdjustmentParams,
  ): Promise<BudgetAdjustment> => {
    const current = initialAdjustments.find((row): boolean =>
      row.adjustmentId === adjustmentId);
    if (current === undefined) throw new Error(`Missing test adjustment ${adjustmentId}`);
    return applyPatch(current, params);
  };
  let deleteHandler = async (_adjustmentId: string): Promise<DeleteBudgetAdjustmentOutcome> =>
    "deleted";

  const runtime = createBudgetAdjustmentRowsController({
    initialAdjustments,
    planFrom: "2026-07",
    autosaveDelayMs: 600,
    createAdjustment: async (params): Promise<BudgetAdjustment> => {
      createCalls.push({ ...params });
      return createHandler(params);
    },
    patchAdjustment: async (adjustmentId, params): Promise<BudgetAdjustment> => {
      patchCalls.push({ adjustmentId, params: { ...params } });
      return patchHandler(adjustmentId, params);
    },
    deleteAdjustment: async (adjustmentId): Promise<DeleteBudgetAdjustmentOutcome> => {
      deleteCalls.push(adjustmentId);
      return deleteHandler(adjustmentId);
    },
    generateAdjustmentId: (): string => CREATED_ID,
    schedule: clock.schedule,
    cancelScheduled: clock.cancel,
    invalidateYears: (years): void => {
      invalidatedYears.push(new Set(years));
    },
  });

  return {
    runtime,
    clock,
    createCalls,
    patchCalls,
    deleteCalls,
    invalidatedYears,
    setCreateHandler: (handler): void => {
      createHandler = handler;
    },
    setPatchHandler: (handler): void => {
      patchHandler = handler;
    },
    setDeleteHandler: (handler): void => {
      deleteHandler = handler;
    },
  };
};

const settleStart = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("debounces valid drafts, uses the same immediate flush path, and never sends invalid drafts", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const harness = createHarness([initial]);
  const { commands } = harness.runtime;

  commands.replaceDraft(FIRST_ID, createDraft("1", "2026-07", "Food", ""));
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);

  commands.replaceDraft(FIRST_ID, createDraft("2", "2026-07", "Food", ""));
  assert.equal(harness.patchCalls.length, 0);
  assert.equal(harness.clock.size(), 1);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);

  const immediate = commands.flushRow(FIRST_ID);
  await immediate;
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
  assert.deepEqual(harness.patchCalls[0]?.params, { amount: 2 });

  commands.replaceDraft(FIRST_ID, createDraft("3", "2026-07", "Food", ""));
  harness.clock.runNext();
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  assert.deepEqual(harness.patchCalls[1]?.params, { amount: 3 });

  commands.replaceDraft(FIRST_ID, createDraft("", "2026-07", "Food", ""));
  assert.equal(await commands.flushRow(FIRST_ID), "saved");
  assert.deepEqual(harness.patchCalls[2]?.params, { amount: 0 });

  commands.replaceDraft(FIRST_ID, createDraft("invalid", "2026-07", "Food", ""));
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
  assert.equal(await commands.flushRow(FIRST_ID), "invalid");
  assert.equal(harness.patchCalls.length, 3);
  assert.equal(
    harness.runtime.getSnapshot().validationByAdjustmentId.get(FIRST_ID)?.code,
    "invalidAmount",
  );
});

test("counts each row once while debounce work transitions to an active flush", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const firstPatch = createDeferred<BudgetAdjustment>();
  const secondPatch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([initial]);
  harness.setPatchHandler((_adjustmentId, _params) =>
    harness.patchCalls.length === 1 ? firstPatch.promise : secondPatch.promise);

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);

  harness.clock.runNext();
  const activeFlush = harness.runtime.commands.flushRow(FIRST_ID);
  await settleStart();
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);
  assert.equal(
    harness.runtime.getSnapshot().operationByAdjustmentId.get(FIRST_ID),
    "saving",
  );

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  assert.equal(harness.clock.size(), 1);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);

  firstPatch.resolve(applyPatch(initial, { amount: 2 }));
  await settleStart();
  assert.equal(harness.patchCalls.length, 2);
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);

  secondPatch.resolve(applyPatch(initial, { amount: 3 }));
  assert.equal(await activeFlush, "saved");
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
});

test("serializes and coalesces one row while allowing another row to save independently", async (): Promise<void> => {
  const first = createAdjustment(FIRST_ID, 1, "2026-12", "Food", null);
  const second = createAdjustment(SECOND_ID, 4, "2026-12", "Travel", null);
  const firstPatch = createDeferred<BudgetAdjustment>();
  const secondPatch = createDeferred<BudgetAdjustment>();
  const finalPatch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([first, second]);
  harness.setPatchHandler((_adjustmentId, _params) => {
    const deferred = [firstPatch, secondPatch, finalPatch][harness.patchCalls.length - 1];
    if (deferred === undefined) throw new Error("Unexpected patch call");
    return deferred.promise;
  });

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-12", "Food", ""),
  );
  const firstFlush = harness.runtime.commands.flushRow(FIRST_ID);
  await settleStart();
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2027-01", "Dining", "newer"),
  );
  assert.equal(harness.runtime.commands.flushRow(FIRST_ID), firstFlush);

  harness.runtime.commands.replaceDraft(
    SECOND_ID,
    createDraft("5", "2026-12", "Travel", ""),
  );
  const secondFlush = harness.runtime.commands.flushRow(SECOND_ID);
  await settleStart();
  assert.equal(harness.patchCalls.length, 2);
  secondPatch.resolve(applyPatch(second, { amount: 5 }));
  assert.equal(await secondFlush, "saved");

  firstPatch.resolve(applyPatch(first, { amount: 2 }));
  await settleStart();
  assert.equal(harness.patchCalls.length, 3);
  assert.deepEqual(harness.patchCalls[2], {
    adjustmentId: FIRST_ID,
    params: { amount: 3, note: "newer", month: "2027-01", category: "Dining" },
  });
  assert.equal(harness.runtime.commands.getCellTotal({
    month: "2026-12",
    direction: "spend",
    category: "Food",
  }), 0);
  assert.equal(harness.runtime.commands.getCellTotal({
    month: "2027-01",
    direction: "spend",
    category: "Dining",
  }), 3);
  finalPatch.resolve(applyPatch(first, harness.patchCalls[2]?.params ?? {}));
  assert.equal(await firstFlush, "saved");
  assert.deepEqual(
    harness.invalidatedYears.map((years) => [...years].sort()),
    [["2026"], ["2026"], ["2026", "2027"]],
  );
});

test("retries a lost create with the identical UUID and payload before patching a newer edit", async (): Promise<void> => {
  const lostCreate = createDeferred<BudgetAdjustment>();
  const retryCreate = createDeferred<BudgetAdjustment>();
  const newerPatch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([]);
  harness.setCreateHandler((_params) =>
    harness.createCalls.length === 1 ? lostCreate.promise : retryCreate.promise);
  harness.setPatchHandler((_adjustmentId, _params) => newerPatch.promise);

  const adjustmentId = harness.runtime.commands.addRow({
    month: "2026-07",
    direction: "spend",
    category: "Food",
  });
  assert.equal(adjustmentId, CREATED_ID);
  const firstFlush = harness.runtime.commands.flushRow(adjustmentId);
  await settleStart();
  harness.runtime.commands.replaceDraft(
    adjustmentId,
    createDraft("7", "2026-07", "Food", "local"),
  );
  lostCreate.reject(new Error("connection lost after request upload"));
  assert.equal(await firstFlush, "error");
  assert.equal(harness.runtime.getSnapshot().rows[0]?.draft.amountInput, "7");

  const retryFlush = harness.runtime.commands.flushRow(adjustmentId);
  await settleStart();
  assert.deepEqual(harness.createCalls, [harness.createCalls[0], harness.createCalls[0]]);
  retryCreate.resolve(fromCreateParams(harness.createCalls[1]));
  await settleStart();
  assert.deepEqual(harness.patchCalls[0]?.params, { amount: 7, note: "local" });
  newerPatch.resolve(applyPatch(
    fromCreateParams(harness.createCalls[1]),
    harness.patchCalls[0]?.params ?? {},
  ));
  assert.equal(await retryFlush, "saved");
});

test("classifies definitive patch failures and blocks after ambiguous failures", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-12", "Food", null);
  const harness = createHarness([initial]);
  let patchAttempt = 0;
  harness.setPatchHandler(async (_adjustmentId, _params): Promise<BudgetAdjustment> => {
    patchAttempt += 1;
    if (patchAttempt === 1) {
      throw new BudgetAdjustmentApiError("Budget adjustment update", 409, "conflict");
    }
    throw new BudgetAdjustmentApiError(
      "Budget adjustment update",
      503,
      "upstream unavailable",
    );
  });

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2027-01", "Food", ""),
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "error");
  assert.deepEqual(harness.runtime.getSnapshot().errorByAdjustmentId.get(FIRST_ID), {
    operation: "patch",
    classification: "definitive",
    message: "Budget adjustment update failed: 409 conflict",
    httpStatus: 409,
    action: "retry-save",
  });

  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "error");
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(FIRST_ID)?.classification,
    "ambiguous",
  );
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(FIRST_ID)?.httpStatus,
    503,
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "refresh-required");
  assert.equal(harness.patchCalls.length, 2);
});

test("records a typed PATCH 404 as a refresh requirement", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const harness = createHarness([initial]);
  harness.setPatchHandler(async (): Promise<BudgetAdjustment> => {
    throw new BudgetAdjustmentApiError(
      "Budget adjustment update",
      404,
      "not found",
    );
  });
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );

  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "error");
  assert.deepEqual(harness.runtime.getSnapshot().errorByAdjustmentId.get(FIRST_ID), {
    operation: "patch",
    classification: "definitive",
    message: "Budget adjustment update failed: 404 not found",
    httpStatus: 404,
    action: "refresh-range",
  });
  assert.equal(
    await harness.runtime.commands.flushRow(FIRST_ID),
    "refresh-required",
  );
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
});

test("keeps an ambiguous delete blocked pending reconciliation", async (): Promise<void> => {
  const first = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const second = createAdjustment(SECOND_ID, 2, "2026-08", "Travel", null);
  const harness = createHarness([first, second]);
  let secondDeleteAttempts = 0;
  harness.setDeleteHandler(async (adjustmentId): Promise<DeleteBudgetAdjustmentOutcome> => {
    if (adjustmentId === FIRST_ID) return "already-absent";
    secondDeleteAttempts += 1;
    if (secondDeleteAttempts === 1) {
      throw new BudgetAdjustmentApiError(
        "Budget adjustment delete",
        422,
        "validation failed",
      );
    }
    throw new Error("delete response lost");
  });

  assert.equal(harness.deleteCalls.length, 0);
  assert.equal(await harness.runtime.commands.requestDelete(FIRST_ID), "deleted");
  assert.equal(harness.runtime.getSnapshot().rows.some((row) =>
    row.adjustmentId === FIRST_ID), false);

  assert.equal(await harness.runtime.commands.requestDelete(SECOND_ID), "error");
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(SECOND_ID)?.classification,
    "definitive",
  );
  assert.equal(await harness.runtime.commands.requestDelete(SECOND_ID), "error");
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(SECOND_ID)?.action,
    "refresh-range",
  );
  assert.equal(
    await harness.runtime.commands.flushRow(SECOND_ID),
    "refresh-required",
  );
  assert.equal(harness.deleteCalls.length, 3);
});

test("discards unsent and definitively failed optimistic rows without network deletion", async (): Promise<void> => {
  const harness = createHarness([]);
  const unsentId = harness.runtime.commands.addRow({
    month: "2026-07",
    direction: "spend",
    category: "Food",
  });
  assert.equal(await harness.runtime.commands.requestDelete(unsentId), "deleted");
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.deleteCalls.length, 0);

  const failedId = harness.runtime.commands.addRow({
    month: "2026-07",
    direction: "spend",
    category: "Food",
  });
  harness.setCreateHandler(async (): Promise<BudgetAdjustment> => {
    throw new BudgetAdjustmentApiError("Budget adjustment create", 409, "conflict");
  });
  assert.equal(await harness.runtime.commands.flushRow(failedId), "error");
  assert.equal(await harness.runtime.commands.requestDelete(failedId), "deleted");
  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.deleteCalls.length, 0);
  assert.equal(harness.runtime.getSnapshot().rows.length, 0);
});

test("finishes create before deleting an optimistic row when create is in flight", async (): Promise<void> => {
  const create = createDeferred<BudgetAdjustment>();
  const harness = createHarness([]);
  harness.setCreateHandler((_params) => create.promise);
  const adjustmentId = harness.runtime.commands.addRow({
    month: "2026-07",
    direction: "spend",
    category: "Food",
  });
  const createFlush = harness.runtime.commands.flushRow(adjustmentId);
  await settleStart();
  assert.equal(harness.runtime.commands.requestDelete(adjustmentId), createFlush);
  create.resolve(fromCreateParams(harness.createCalls[0]));

  assert.equal(await createFlush, "deleted");
  assert.equal(harness.createCalls.length, 1);
  assert.deepEqual(harness.deleteCalls, [adjustmentId]);
});

test("publishes mutation snapshots until unsubscribed and exposes cell selectors", (): void => {
  const harness = createHarness([
    createAdjustment(FIRST_ID, 1, "2026-07", "Food", null),
  ]);
  const location = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Food",
  };
  const snapshots: Array<ReturnType<typeof harness.runtime.getSnapshot>> = [];
  const unsubscribe = harness.runtime.subscribe((): void => {
    snapshots.push(harness.runtime.getSnapshot());
  });

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.pendingMutationCount, 1);
  assert.equal(harness.runtime.commands.getCellRows(location).length, 1);
  assert.equal(harness.runtime.commands.getCellTotal(location), 2);

  unsubscribe();
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  assert.equal(snapshots.length, 1);
});

test("dispose cancels every pending autosave timer without marking a mutation complete", (): void => {
  const harness = createHarness([
    createAdjustment(FIRST_ID, 1, "2026-07", "Food", null),
    createAdjustment(SECOND_ID, 2, "2026-08", "Travel", null),
  ]);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  harness.runtime.commands.replaceDraft(
    SECOND_ID,
    createDraft("4", "2026-08", "Travel", ""),
  );
  assert.equal(harness.clock.size(), 2);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 2);

  harness.runtime.dispose();
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
  assert.equal(harness.patchCalls.length, 0);
  assert.equal(harness.runtime.getSnapshot().rows[0]?.confirmed.amount, 1);
});

test("activate replays years invalidated by a mutation that completed while disposed", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-12", "Food", null);
  const patch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([initial]);
  harness.setPatchHandler((_adjustmentId, _params) => patch.promise);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2027-01", "Food", ""),
  );
  const activeFlush = harness.runtime.commands.flushRow(FIRST_ID);
  await settleStart();

  harness.runtime.dispose();
  patch.resolve(applyPatch(initial, { amount: 2, month: "2027-01" }));
  assert.equal(await activeFlush, "saved");
  assert.deepEqual(harness.invalidatedYears, []);

  harness.runtime.activate();
  assert.deepEqual(
    harness.invalidatedYears.map((years) => [...years].sort()),
    [["2026", "2027"]],
  );
  harness.runtime.activate();
  assert.equal(harness.invalidatedYears.length, 1);
});

test("disposed mutating commands reject without state changes and work after activation", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const harness = createHarness([initial]);
  harness.runtime.dispose();
  const disposedSnapshot = harness.runtime.getSnapshot();

  assert.throws(
    () => harness.runtime.commands.addRow({
      month: "2026-07",
      direction: "spend",
      category: "Food",
    }),
    /Cannot add budget adjustment: controller is disposed/,
  );
  assert.throws(
    () => harness.runtime.commands.replaceDraft(
      FIRST_ID,
      createDraft("2", "2026-07", "Food", ""),
    ),
    /Cannot edit budget adjustment .* controller is disposed/,
  );
  await assert.rejects(
    harness.runtime.commands.flushRow(FIRST_ID),
    /Cannot flush budget adjustment .* controller is disposed/,
  );
  await assert.rejects(
    harness.runtime.commands.requestDelete(FIRST_ID),
    /Cannot delete budget adjustment .* controller is disposed/,
  );
  assert.equal(harness.runtime.getSnapshot(), disposedSnapshot);
  assert.equal(harness.runtime.getSnapshot().rows.length, 1);
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.patchCalls.length, 0);
  assert.equal(harness.deleteCalls.length, 0);

  harness.runtime.activate();
  const createdId = harness.runtime.commands.addRow({
    month: "2026-07",
    direction: "spend",
    category: "Food",
  });
  assert.equal(createdId, CREATED_ID);
  assert.equal(await harness.runtime.commands.requestDelete(createdId), "deleted");
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );
  assert.equal(await harness.runtime.commands.requestDelete(FIRST_ID), "deleted");
  assert.deepEqual(harness.deleteCalls, [FIRST_ID]);
  assert.equal(harness.runtime.getSnapshot().rows.length, 0);
});

test("activate restores suspended autosaves while canceled callbacks stay inert", async (): Promise<void> => {
  const harness = createHarness([
    createAdjustment(FIRST_ID, 1, "2026-07", "Food", null),
    createAdjustment(SECOND_ID, 2, "2026-08", "Travel", null),
  ]);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  harness.runtime.commands.replaceDraft(
    SECOND_ID,
    createDraft("4", "2026-08", "Travel", ""),
  );
  const disposedCallback = harness.clock.scheduledCallbackAt(0);
  const staleCallback = harness.clock.scheduledCallbackAt(1);
  harness.runtime.dispose();

  disposedCallback();
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  assert.equal(harness.patchCalls.length, 0);

  harness.runtime.activate();
  harness.runtime.activate();
  staleCallback();
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  assert.equal(harness.patchCalls.length, 0);
  assert.equal(harness.clock.size(), 2);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 2);

  harness.clock.runNext();
  harness.clock.runNext();
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  assert.deepEqual(harness.patchCalls, [
    { adjustmentId: FIRST_ID, params: { amount: 3 } },
    { adjustmentId: SECOND_ID, params: { amount: 4 } },
  ]);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
});

test("activate restores optimistic autosave without scheduling invalid persisted drafts", async (): Promise<void> => {
  const harness = createHarness([
    createAdjustment(FIRST_ID, 1, "2026-07", "Food", null),
  ]);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("invalid", "2026-07", "Food", ""),
  );
  const optimisticId = harness.runtime.commands.addRow({
    month: "2026-07",
    direction: "spend",
    category: "Food",
  });
  harness.runtime.commands.replaceDraft(
    optimisticId,
    createDraft("invalid", "2026-07", "Food", ""),
  );
  assert.equal(harness.clock.size(), 1);

  harness.runtime.dispose();
  harness.runtime.activate();
  assert.equal(harness.clock.size(), 1);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);
  harness.clock.runNext();
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });

  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.patchCalls.length, 0);
  assert.equal(
    harness.runtime.getSnapshot().validationByAdjustmentId.get(FIRST_ID)?.code,
    "invalidAmount",
  );
  assert.equal(
    harness.runtime.getSnapshot().validationByAdjustmentId.get(optimisticId)?.code,
    "invalidAmount",
  );
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
});

test("activate does not schedule a suspended timer beside an active row flush", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const firstPatch = createDeferred<BudgetAdjustment>();
  const secondPatch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([initial]);
  harness.setPatchHandler((_adjustmentId, _params) =>
    harness.patchCalls.length === 1 ? firstPatch.promise : secondPatch.promise);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );
  const activeFlush = harness.runtime.commands.flushRow(FIRST_ID);
  await settleStart();
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  assert.equal(harness.clock.size(), 1);

  harness.runtime.dispose();
  harness.runtime.activate();
  harness.runtime.activate();
  assert.equal(harness.clock.size(), 0);
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);

  firstPatch.resolve(applyPatch(initial, { amount: 2 }));
  await settleStart();
  assert.deepEqual(harness.patchCalls[1], {
    adjustmentId: FIRST_ID,
    params: { amount: 3 },
  });
  assert.equal(harness.clock.size(), 0);
  secondPatch.resolve(applyPatch(initial, { amount: 3 }));
  assert.equal(await activeFlush, "saved");
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 0);
});
