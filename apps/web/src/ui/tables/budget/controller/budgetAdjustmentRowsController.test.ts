import assert from "node:assert/strict";
import test from "node:test";

import type {
  BudgetAdjustment,
  CreateBudgetAdjustmentParams,
  PatchBudgetAdjustmentParams,
} from "@/server/budget/budgetAdjustments";
import type { BudgetGridResult, BudgetRow } from "@/server/budget/getBudgetGrid";
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

type RangeCall = Readonly<{
  monthFrom: string;
  monthTo: string;
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
  rangeCalls: Array<RangeCall>;
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
  setRangeHandler: (
    handler: (monthFrom: string, monthTo: string) => Promise<BudgetGridResult>,
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

const createGrid = (
  adjustments: ReadonlyArray<BudgetAdjustment>,
  rows: ReadonlyArray<BudgetRow>,
): BudgetGridResult => ({
  rows,
  adjustments,
  conversionWarnings: [],
  cumulativeBefore: { incomeActual: 0, spendActual: 0, transferActual: 0 },
  monthEndBalances: {},
  monthEndBalancesByLiquidity: {},
  businessPersonalTransfers: {},
  hasBusinessAccount: false,
});

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
  const rangeCalls: Array<RangeCall> = [];
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
  let rangeHandler = async (
    _monthFrom: string,
    _monthTo: string,
  ): Promise<BudgetGridResult> => createGrid(initialAdjustments, []);

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
    fetchRange: async (monthFrom, monthTo): Promise<BudgetGridResult> => {
      rangeCalls.push({ monthFrom, monthTo });
      return rangeHandler(monthFrom, monthTo);
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
    rangeCalls,
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
    setRangeHandler: (handler): void => {
      rangeHandler = handler;
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
  }, null), 0);
  assert.equal(harness.runtime.commands.getCellTotal({
    month: "2027-01",
    direction: "spend",
    category: "Dining",
  }, null), 3);
  finalPatch.resolve(applyPatch(first, harness.patchCalls[2]?.params ?? {}));
  assert.equal(await firstFlush, "saved");
  assert.deepEqual(
    harness.invalidatedYears.map((years) => [...years].sort()),
    [["2026"], ["2026"], ["2026", "2027"]],
  );
});

test("keeps an acknowledged move anchored while a newer invalid draft is unresolved", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const moved = applyPatch(initial, { month: "2026-08" });
  const firstPatch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([initial]);
  harness.setPatchHandler((_adjustmentId, _params) => firstPatch.promise);
  const source = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Food",
  };
  const destination = {
    month: "2026-08",
    direction: "spend" as const,
    category: "Food",
  };
  const editorAnchors = new Map([[FIRST_ID, source]]);

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("1", "2026-08", "Food", ""),
  );
  const flush = harness.runtime.commands.flushRow(FIRST_ID);
  await settleStart();
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("1", "2026-08", "", ""),
  );
  firstPatch.resolve(moved);

  assert.equal(await flush, "invalid");
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      source,
      null,
      editorAnchors,
    ).map((row) => row.adjustmentId),
    [FIRST_ID],
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      destination,
      null,
      editorAnchors,
    ),
    [],
  );

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("1", "2026-08", "Food", ""),
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "unchanged");
  assert.deepEqual(
    harness.runtime.commands.getCellRows(source, null, editorAnchors),
    [],
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      destination,
      null,
      editorAnchors,
    ).map((row) => row.adjustmentId),
    [FIRST_ID],
  );
});

test("keeps an acknowledged move anchored through a failed follow-up patch", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const moved = applyPatch(initial, { month: "2026-08" });
  const firstPatch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([initial]);
  let patchAttempt = 0;
  harness.setPatchHandler(async (_adjustmentId, params): Promise<BudgetAdjustment> => {
    patchAttempt += 1;
    if (patchAttempt === 1) return firstPatch.promise;
    if (patchAttempt === 2) {
      throw new BudgetAdjustmentApiError(
        "Budget adjustment update",
        409,
        "forced follow-up conflict",
      );
    }
    return applyPatch(moved, params);
  });
  const source = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Food",
  };
  const destination = {
    month: "2026-08",
    direction: "spend" as const,
    category: "Food",
  };
  const editorAnchors = new Map([[FIRST_ID, source]]);

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("1", "2026-08", "Food", ""),
  );
  const flush = harness.runtime.commands.flushRow(FIRST_ID);
  await settleStart();
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-08", "Food", ""),
  );
  firstPatch.resolve(moved);

  assert.equal(await flush, "error");
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(FIRST_ID)?.classification,
    "definitive",
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      source,
      null,
      editorAnchors,
    ).map((row) => row.adjustmentId),
    [FIRST_ID],
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      destination,
      null,
      editorAnchors,
    ),
    [],
  );

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-08", "Food", ""),
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "saved");
  assert.deepEqual(
    harness.runtime.commands.getCellRows(source, null, editorAnchors),
    [],
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      destination,
      null,
      editorAnchors,
    ).map((row) => row.adjustmentId),
    [FIRST_ID],
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

test("classifies definitive patch failures and reconciles ambiguous failures by range", async (): Promise<void> => {
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
  assert.deepEqual(
    harness.invalidatedYears.map((years) => [...years].sort()),
    [["2026", "2027"]],
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "refresh-required");
  assert.equal(harness.patchCalls.length, 2);

  const canonical = applyPatch(initial, { amount: 2, month: "2027-01" });
  const rangeResult = createGrid([canonical], []);
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => rangeResult);
  assert.deepEqual(
    await harness.runtime.commands.loadRange("2026-12", "2027-01"),
    { status: "accepted", result: rangeResult },
  );
  assert.deepEqual(harness.rangeCalls, [{ monthFrom: "2026-12", monthTo: "2027-01" }]);
  assert.deepEqual(
    harness.invalidatedYears.map((years) => [...years].sort()),
    [["2026", "2027"], ["2026", "2027"]],
  );
  assert.equal(harness.runtime.getSnapshot().errorByAdjustmentId.has(FIRST_ID), false);
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "unchanged");
});

test("rolls definitive patch projections back while keeping the failed draft editable", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-12", "Food", null);
  const harness = createHarness([initial]);
  const source = {
    month: "2026-12",
    direction: "spend" as const,
    category: "Food",
  };
  const destination = {
    month: "2027-01",
    direction: "spend" as const,
    category: "Dining",
  };
  harness.setPatchHandler(async (): Promise<BudgetAdjustment> => {
    throw new BudgetAdjustmentApiError(
      "Budget adjustment update",
      409,
      "conflict",
    );
  });
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("9", "2027-01", "Dining", "retry me"),
  );

  assert.equal(harness.runtime.commands.getCellTotal(source, null), 0);
  assert.equal(harness.runtime.commands.getCellTotal(destination, null), 9);
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "error");

  const failed = harness.runtime.getSnapshot();
  assert.equal(failed.rows[0]?.draft.amountInput, "9");
  assert.equal(failed.rows[0]?.draft.month, "2027-01");
  assert.equal(failed.rows[0]?.draft.category, "Dining");
  assert.equal(failed.rows[0]?.draft.noteInput, "retry me");
  assert.equal(harness.runtime.commands.getCellTotal(source, null), 1);
  assert.equal(harness.runtime.commands.getCellTotal(destination, null), 0);
  assert.equal(
    harness.runtime.commands.getCellTotal(source, new Set(["Food"])),
    1,
  );
  assert.equal(
    harness.runtime.commands.getCellTotal(destination, new Set(["Food"])),
    0,
  );
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows(
      [
        {
          month: "2026-12",
          direction: "spend",
          category: "Food",
          plannedBase: 100,
          plannedModifier: 1,
          planned: 101,
          actual: 0,
          hasUnconvertible: false,
        },
        {
          month: "2027-01",
          direction: "spend",
          category: "Dining",
          plannedBase: 200,
          plannedModifier: 0,
          planned: 200,
          actual: 0,
          hasUnconvertible: false,
        },
      ],
      "2026-12",
      "2027-01",
      null,
    ).map((row) => [
      row.month,
      row.category,
      row.plannedModifier,
      row.planned,
    ]),
    [
      ["2026-12", "Food", 1, 101],
      ["2027-01", "Dining", 0, 200],
    ],
  );
  assert.deepEqual(harness.invalidatedYears, []);
});

test("rolls definitive delete projections back and permits editing before an explicit retry", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-12", "Food", null);
  const harness = createHarness([initial]);
  const source = {
    month: "2026-12",
    direction: "spend" as const,
    category: "Food",
  };
  const destination = {
    month: "2027-01",
    direction: "spend" as const,
    category: "Dining",
  };
  harness.setDeleteHandler(async (): Promise<DeleteBudgetAdjustmentOutcome> => {
    throw new BudgetAdjustmentApiError(
      "Budget adjustment delete",
      409,
      "conflict",
    );
  });
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("9", "2027-01", "Dining", "retry me"),
  );

  assert.equal(harness.runtime.commands.getCellTotal(source, null), 0);
  assert.equal(harness.runtime.commands.getCellTotal(destination, null), 9);
  assert.equal(
    await harness.runtime.commands.requestDelete(FIRST_ID),
    "error",
  );

  const failed = harness.runtime.getSnapshot();
  assert.equal(
    failed.errorByAdjustmentId.get(FIRST_ID)?.classification,
    "definitive",
  );
  assert.equal(failed.errorByAdjustmentId.get(FIRST_ID)?.operation, "delete");
  assert.equal(failed.rows[0]?.draft.amountInput, "9");
  assert.equal(failed.rows[0]?.draft.month, "2027-01");
  assert.equal(failed.rows[0]?.draft.category, "Dining");
  assert.equal(failed.rows[0]?.draft.noteInput, "retry me");
  assert.equal(harness.runtime.commands.getCellTotal(source, null), 1);
  assert.equal(harness.runtime.commands.getCellTotal(destination, null), 0);

  assert.doesNotThrow(() => harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("10", "2027-01", "Dining", "editable"),
  ));
  const edited = harness.runtime.getSnapshot();
  assert.equal(edited.errorByAdjustmentId.has(FIRST_ID), false);
  assert.equal(edited.rows[0]?.draft.amountInput, "10");
  assert.equal(edited.rows[0]?.draft.noteInput, "editable");
  assert.equal(harness.runtime.commands.getCellTotal(source, null), 0);
  assert.equal(harness.runtime.commands.getCellTotal(destination, null), 10);

  harness.setDeleteHandler(
    async (): Promise<DeleteBudgetAdjustmentOutcome> => "deleted",
  );
  assert.equal(
    await harness.runtime.commands.requestDelete(FIRST_ID),
    "deleted",
  );
  assert.deepEqual(harness.deleteCalls, [FIRST_ID, FIRST_ID]);
  assert.equal(harness.runtime.getSnapshot().rows.length, 0);
});

test("removes a definitively failed optimistic create from projections without losing its editor", async (): Promise<void> => {
  const harness = createHarness([]);
  harness.setCreateHandler(async (): Promise<BudgetAdjustment> => {
    throw new BudgetAdjustmentApiError(
      "Budget adjustment create",
      409,
      "conflict",
    );
  });
  const location = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Adjustment only",
  };
  const adjustmentId = harness.runtime.commands.addRow(location);
  harness.runtime.commands.replaceDraft(
    adjustmentId,
    createDraft("5", "2026-07", "Adjustment only", "retry me"),
  );

  assert.equal(harness.runtime.commands.getCellTotal(location, null), 5);
  assert.equal(await harness.runtime.commands.flushRow(adjustmentId), "error");
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(adjustmentId)?.classification,
    "definitive",
  );
  assert.equal(
    harness.runtime.commands.getRow(adjustmentId, null)?.draft.amountInput,
    "5",
  );
  assert.equal(harness.runtime.commands.getCellTotal(location, null), 0);
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows(
      [],
      "2026-07",
      "2026-07",
      null,
    ),
    [],
  );
});

test("keeps an ambiguous patch retryable when refresh returns the unchanged row", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const harness = createHarness([initial]);
  let patchAttempt = 0;
  harness.setPatchHandler(async (_adjustmentId, params): Promise<BudgetAdjustment> => {
    patchAttempt += 1;
    if (patchAttempt === 1) throw new Error("patch response lost");
    return applyPatch(initial, params);
  });
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "error");
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([initial], []));

  await harness.runtime.commands.refreshRow(FIRST_ID);
  const refreshed = harness.runtime.getSnapshot();
  assert.equal(refreshed.rows[0]?.confirmed.amount, 1);
  assert.equal(refreshed.rows[0]?.draft.amountInput, "2");
  assert.equal(refreshed.errorByAdjustmentId.get(FIRST_ID)?.action, "retry-save");
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "saved");
  assert.equal(harness.runtime.getSnapshot().errorByAdjustmentId.has(FIRST_ID), false);
});

test("coalesces recovery for one adjustment and publishes shared pending state", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const range = createDeferred<BudgetGridResult>();
  const harness = createHarness([initial]);
  let patchAttempt = 0;
  harness.setPatchHandler(async (_adjustmentId, params): Promise<BudgetAdjustment> => {
    patchAttempt += 1;
    if (patchAttempt === 1) throw new Error("patch response lost");
    return applyPatch(initial, params);
  });
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("2", "2026-07", "Food", ""),
  );
  assert.equal(await harness.runtime.commands.flushRow(FIRST_ID), "error");
  harness.setRangeHandler((_monthFrom, _monthTo) => range.promise);

  const popoverRecovery = harness.runtime.commands.recoverRow(FIRST_ID);
  const tableRecovery = harness.runtime.commands.recoverRow(FIRST_ID);
  assert.equal(tableRecovery, popoverRecovery);
  assert.equal(harness.runtime.getSnapshot().recoveringAdjustmentIds.has(FIRST_ID), true);
  await settleStart();
  assert.deepEqual(harness.rangeCalls, [{ monthFrom: "2026-07", monthTo: "2026-07" }]);

  range.resolve(createGrid([initial], []));
  assert.equal(await popoverRecovery, "recovered");
  assert.equal(await tableRecovery, "recovered");
  const snapshot = harness.runtime.getSnapshot();
  assert.equal(snapshot.recoveringAdjustmentIds.has(FIRST_ID), false);
  assert.equal(snapshot.errorByAdjustmentId.has(FIRST_ID), false);
  assert.equal(snapshot.rows[0]?.confirmed.amount, 2);
  assert.equal(harness.rangeCalls.length, 1);
  assert.equal(harness.patchCalls.length, 2);
});

test("reconciles a typed PATCH 404 as authoritative absence", async (): Promise<void> => {
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

  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([], []));
  await harness.runtime.commands.refreshRow(FIRST_ID);
  assert.equal(harness.runtime.getSnapshot().rows.length, 0);
  assert.equal(harness.runtime.getSnapshot().errorByAdjustmentId.has(FIRST_ID), false);
});

test("clears timer and row state when authoritative reconciliation removes a row", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const patch = createDeferred<BudgetAdjustment>();
  const harness = createHarness([initial]);
  harness.setPatchHandler((_adjustmentId, _params) => patch.promise);
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

  patch.reject(new BudgetAdjustmentApiError(
    "Budget adjustment update",
    404,
    "not found",
  ));
  assert.equal(await activeFlush, "error");
  assert.equal(harness.runtime.getSnapshot().pendingMutationCount, 1);
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([], []));

  await harness.runtime.commands.refreshRow(FIRST_ID);
  const snapshot = harness.runtime.getSnapshot();
  assert.equal(harness.clock.size(), 0);
  assert.equal(snapshot.pendingMutationCount, 0);
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.errorByAdjustmentId.has(FIRST_ID), false);
  assert.equal(snapshot.operationByAdjustmentId.has(FIRST_ID), false);
});

test("keeps an ambiguous delete retryable when refresh returns the unchanged row", async (): Promise<void> => {
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
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([second], []));
  await harness.runtime.commands.refreshRow(SECOND_ID);
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(SECOND_ID)?.action,
    "retry-save",
  );
  harness.setDeleteHandler(async (): Promise<DeleteBudgetAdjustmentOutcome> => "deleted");
  assert.equal(await harness.runtime.commands.flushRow(SECOND_ID), "deleted");
  assert.equal(harness.runtime.getSnapshot().rows.length, 0);
});

test("reconciles an ambiguous delete as authoritative absence", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const harness = createHarness([initial]);
  harness.setDeleteHandler(async (): Promise<DeleteBudgetAdjustmentOutcome> => {
    throw new Error("delete response lost");
  });
  assert.equal(await harness.runtime.commands.requestDelete(FIRST_ID), "error");
  assert.equal(
    harness.runtime.getSnapshot().errorByAdjustmentId.get(FIRST_ID)?.action,
    "refresh-range",
  );
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([], []));

  await harness.runtime.commands.refreshRow(FIRST_ID);
  const snapshot = harness.runtime.getSnapshot();
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.errorByAdjustmentId.has(FIRST_ID), false);
  assert.equal(snapshot.operationByAdjustmentId.has(FIRST_ID), false);
  assert.equal(snapshot.pendingMutationCount, 0);
  assert.deepEqual(harness.deleteCalls, [FIRST_ID]);
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
  assert.equal(harness.runtime.commands.getRow(FIRST_ID, null)?.draft.amountInput, "2");
  assert.equal(harness.runtime.commands.getRow(SECOND_ID, null), null);
  assert.equal(
    harness.runtime.commands.getCellRows(location, null, new Map()).length,
    1,
  );
  assert.equal(harness.runtime.commands.getCellTotal(location, null), 2);

  unsubscribe();
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("3", "2026-07", "Food", ""),
  );
  assert.equal(snapshots.length, 1);
});

test("keeps filtered editor ownership private while projected budget rows stay masked", (): void => {
  const harness = createHarness([
    createAdjustment(FIRST_ID, 47, "2026-07", "Masked", "private note"),
  ]);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("47", "2026-07", "Allowed", "private note"),
  );
  const allowlist = new Set(["Allowed"]);
  const destination = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Allowed",
  };
  const source = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Masked",
  };
  const protectedPrivateCell = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Masked",
  };
  const release = harness.runtime.commands.retainCell(
    "filtered-presentation",
    protectedPrivateCell,
  );
  const budgetRows: ReadonlyArray<BudgetRow> = [{
    month: "2026-07",
    direction: "spend",
    category: "Allowed",
    plannedBase: 100,
    plannedModifier: 47,
    planned: 147,
    actual: 0,
    hasUnconvertible: false,
  }];

  assert.deepEqual(
    harness.runtime.commands.getCellRows(destination, allowlist, new Map()),
    [],
  );
  assert.equal(harness.runtime.commands.getCellTotal(destination, allowlist), 0);
  assert.equal(harness.runtime.commands.getRow(FIRST_ID, allowlist), null);
  assert.equal(
    harness.runtime.commands.getRow(FIRST_ID, null)?.confirmed.category,
    "Masked",
  );
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows(
      budgetRows,
      "2026-07",
      "2026-07",
      allowlist,
    ),
    [{
      ...budgetRows[0],
      plannedModifier: 0,
      planned: 100,
    }],
  );
  assert.deepEqual(
    [...harness.runtime.getSnapshot().protectedCellKeys],
    ["2026-07\u0000spend\u0000Masked"],
  );
  assert.equal(
    harness.runtime.commands.getCellRows(source, null, new Map()).length,
    1,
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      source,
      allowlist,
      new Map([[FIRST_ID, source]]),
    ),
    [],
  );
  assert.equal(
    harness.runtime.commands.applyToBudgetRows(
      budgetRows,
      "2026-07",
      "2026-07",
      null,
    ).some((row): boolean => row.category === protectedPrivateCell.category),
    true,
  );
  release();
});

test("reveals invalid filtered drafts only in their owning confirmed editor cell", (): void => {
  const harness = createHarness([
    createAdjustment(FIRST_ID, 12, "2026-07", "Allowed", null),
  ]);
  const source = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Allowed",
  };
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("12", "2026-07", "Unknown", ""),
  );
  const allowlist = new Set(["Allowed"]);

  assert.equal(harness.runtime.commands.getRow(FIRST_ID, allowlist), null);
  assert.deepEqual(
    harness.runtime.commands.getCellRows(source, allowlist, new Map()),
    [],
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      source,
      allowlist,
      new Map([[FIRST_ID, source]]),
    ).map((row) => row.adjustmentId),
    [FIRST_ID],
  );
  assert.equal(
    harness.runtime.commands.getRow(FIRST_ID, null)?.draft.category,
    "Unknown",
  );

  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("12", "2026-07", "", ""),
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(source, allowlist, new Map()),
    [],
  );
  assert.deepEqual(
    harness.runtime.commands.getCellRows(
      source,
      allowlist,
      new Map([[FIRST_ID, source]]),
    ).map((row) => row.adjustmentId),
    [FIRST_ID],
  );
});

test("retains protected adjustment cells by explicit remount-safe owner identity", (): void => {
  const harness = createHarness([]);
  const location = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Adjustment only",
  };
  const projectedRow: BudgetRow = {
    month: "2026-07",
    direction: "spend",
    category: "Adjustment only",
    plannedBase: 0,
    plannedModifier: 0,
    planned: 0,
    actual: 0,
    hasUnconvertible: false,
  };
  const releaseFirst = harness.runtime.commands.retainCell("first-editor", location);
  const releaseSecond = harness.runtime.commands.retainCell("second-editor", location);

  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows([], "2026-07", "2026-07", null),
    [projectedRow],
  );
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows(
      [],
      "2026-07",
      "2026-07",
      new Set(["Allowed"]),
    ),
    [],
  );
  assert.deepEqual(
    [...harness.runtime.getSnapshot().protectedCellKeys],
    ["2026-07\u0000spend\u0000Adjustment only"],
  );
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows([], "2026-07", "2026-07", null),
    [projectedRow],
  );

  releaseFirst();
  assert.equal(harness.runtime.getSnapshot().protectedCellKeys.size, 1);
  releaseFirst();
  assert.equal(harness.runtime.getSnapshot().protectedCellKeys.size, 1);
  releaseSecond();
  assert.equal(harness.runtime.getSnapshot().protectedCellKeys.size, 0);

  const releaseStaleMount = harness.runtime.commands.retainCell("remounted-editor", location);
  const releaseCurrentMount = harness.runtime.commands.retainCell("remounted-editor", location);
  releaseStaleMount();
  assert.equal(harness.runtime.getSnapshot().protectedCellKeys.size, 1);
  releaseCurrentMount();
  assert.equal(harness.runtime.getSnapshot().protectedCellKeys.size, 0);
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows([], "2026-07", "2026-07", null),
    [],
  );
});

test("keeps a protected source cell projected through authoritative range absence", async (): Promise<void> => {
  const adjustment = createAdjustment(
    FIRST_ID,
    12,
    "2026-07",
    "Adjustment only",
    null,
  );
  const harness = createHarness([adjustment]);
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([], []));
  const location = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Adjustment only",
  };
  const release = harness.runtime.commands.retainCell("source-editor", location);

  const outcome = await harness.runtime.commands.loadRange("2026-07", "2026-07");
  assert.equal(outcome.status, "accepted");
  assert.equal(harness.runtime.commands.getRow(FIRST_ID, null), null);
  assert.equal(
    harness.runtime.commands.applyToBudgetRows([], "2026-07", "2026-07", null)
      .some((row): boolean => row.category === location.category),
    true,
  );

  release();
  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows([], "2026-07", "2026-07", null),
    [],
  );
});

test("accepts exact-overlap ranges in response order and supersedes stale results", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const older = createDeferred<BudgetGridResult>();
  const newer = createDeferred<BudgetGridResult>();
  const harness = createHarness([initial]);
  harness.setRangeHandler((_monthFrom, _monthTo) =>
    harness.rangeCalls.length === 1 ? older.promise : newer.promise);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("9", "2026-07", "Food", "local"),
  );

  const olderLoad = harness.runtime.commands.loadRange("2026-07", "2026-07");
  const newerLoad = harness.runtime.commands.loadRange("2026-07", "2026-07");
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 2);
  const newerGrid = createGrid([{ ...initial, amount: 3 }], []);
  newer.resolve(newerGrid);
  assert.deepEqual(await newerLoad, { status: "accepted", result: newerGrid });
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 1);
  older.resolve(createGrid([{ ...initial, amount: 2 }], []));
  assert.deepEqual(await olderLoad, { status: "superseded" });
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 0);

  const row = harness.runtime.getSnapshot().rows[0];
  assert.equal(row?.confirmed.amount, 3);
  assert.equal(row?.draft.amountInput, "9");
  assert.equal(row?.draft.noteInput, "local");
});

test("accepts exact-overlap ranges when the older response settles first", async (): Promise<void> => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const older = createDeferred<BudgetGridResult>();
  const newer = createDeferred<BudgetGridResult>();
  const harness = createHarness([initial]);
  harness.setRangeHandler((_monthFrom, _monthTo) =>
    harness.rangeCalls.length === 1 ? older.promise : newer.promise);

  const olderLoad = harness.runtime.commands.loadRange("2026-07", "2026-07");
  const newerLoad = harness.runtime.commands.loadRange("2026-07", "2026-07");
  const olderGrid = createGrid([{ ...initial, amount: 2 }], []);
  older.resolve(olderGrid);
  assert.deepEqual(await olderLoad, { status: "accepted", result: olderGrid });
  assert.equal(harness.runtime.getSnapshot().rows[0]?.confirmed.amount, 2);

  const newerGrid = createGrid([{ ...initial, amount: 3 }], []);
  newer.resolve(newerGrid);
  assert.deepEqual(await newerLoad, { status: "accepted", result: newerGrid });
  assert.equal(harness.runtime.getSnapshot().rows[0]?.confirmed.amount, 3);
});

test("loads the maximum supported month without advancing beyond the range", async (): Promise<void> => {
  const harness = createHarness([]);
  const grid = createGrid([], []);
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => grid);

  assert.deepEqual(
    await harness.runtime.commands.loadRange("9999-12", "9999-12"),
    { status: "accepted", result: grid },
  );
  assert.deepEqual(harness.rangeCalls, [{ monthFrom: "9999-12", monthTo: "9999-12" }]);
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 0);
});

test("reconciles safe months but withholds a partially superseded range result", async (): Promise<void> => {
  const july = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const august = createAdjustment(SECOND_ID, 10, "2026-08", "Travel", null);
  const older = createDeferred<BudgetGridResult>();
  const newer = createDeferred<BudgetGridResult>();
  const harness = createHarness([july, august]);
  harness.setRangeHandler((_monthFrom, _monthTo) =>
    harness.rangeCalls.length === 1 ? older.promise : newer.promise);

  const olderLoad = harness.runtime.commands.loadRange("2026-07", "2026-08");
  const newerLoad = harness.runtime.commands.loadRange("2026-08", "2026-09");
  const newerGrid = createGrid([{ ...august, amount: 30 }], []);
  newer.resolve(newerGrid);
  assert.deepEqual(await newerLoad, { status: "accepted", result: newerGrid });
  older.resolve(createGrid([
    { ...july, amount: 2 },
    { ...august, amount: 20 },
  ], []));
  assert.deepEqual(await olderLoad, { status: "superseded" });

  const rows = harness.runtime.getSnapshot().rows;
  assert.equal(rows.find((row) => row.adjustmentId === FIRST_ID)?.confirmed.amount, 2);
  assert.equal(rows.find((row) => row.adjustmentId === SECOND_ID)?.confirmed.amount, 30);
});

test("rejects range failures and clears them after a broader accepted recovery", async (): Promise<void> => {
  const harness = createHarness([]);
  const network = createDeferred<BudgetGridResult>();
  harness.setRangeHandler((_monthFrom, _monthTo) => network.promise);
  const networkLoad = harness.runtime.commands.loadRange("2026-07", "2026-08");
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 1);
  network.reject(new BudgetAdjustmentApiError(
    "Budget grid load",
    503,
    "unavailable",
  ));
  await assert.rejects(networkLoad, /Budget grid load failed: 503 unavailable/);
  assert.deepEqual([...harness.runtime.getSnapshot().rangeErrorByKey.values()], [{
    monthFrom: "2026-07",
    monthTo: "2026-08",
    message: "Budget grid load failed: 503 unavailable",
    httpStatus: 503,
  }]);

  const broader = createDeferred<BudgetGridResult>();
  harness.setRangeHandler((_monthFrom, _monthTo) => broader.promise);
  const recovery = harness.runtime.commands.loadRange("2026-06", "2026-09");
  assert.equal(harness.runtime.getSnapshot().rangeErrorByKey.size, 1);
  const recoveredGrid = createGrid([], []);
  broader.resolve(recoveredGrid);
  assert.deepEqual(await recovery, { status: "accepted", result: recoveredGrid });
  assert.equal(harness.runtime.getSnapshot().rangeErrorByKey.size, 0);

  harness.setRangeHandler(async (): Promise<BudgetGridResult> => createGrid([
    createAdjustment(FIRST_ID, 1, "invalid-month", "Food", null),
  ], []));
  await assert.rejects(
    harness.runtime.commands.loadRange("2026-09", "2026-09"),
    /Budget adjustment range response row 0 is invalid/,
  );
  assert.equal(harness.runtime.getSnapshot().rangeErrorByKey.size, 1);
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 0);
});

test("keeps the newest identical-range failure when responses settle in reverse", async (): Promise<void> => {
  const older = createDeferred<BudgetGridResult>();
  const newer = createDeferred<BudgetGridResult>();
  const harness = createHarness([]);
  harness.setRangeHandler((_monthFrom, _monthTo) =>
    harness.rangeCalls.length === 1 ? older.promise : newer.promise);
  const olderLoad = harness.runtime.commands.loadRange("2026-07", "2026-08");
  const newerLoad = harness.runtime.commands.loadRange("2026-07", "2026-08");

  newer.reject(new Error("newer range failure"));
  await assert.rejects(newerLoad, /newer range failure/);
  older.reject(new Error("older range failure"));
  await assert.rejects(olderLoad, /older range failure/);

  assert.deepEqual([...harness.runtime.getSnapshot().rangeErrorByKey.values()], [{
    monthFrom: "2026-07",
    monthTo: "2026-08",
    message: "newer range failure",
    httpStatus: null,
  }]);
  assert.equal(harness.runtime.getSnapshot().pendingRangeCount, 0);
});

test("keeps a failed range error until accepted partitions cover every month", async (): Promise<void> => {
  const harness = createHarness([]);
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => {
    throw new Error("range offline");
  });
  await assert.rejects(
    harness.runtime.commands.loadRange("2026-07", "2026-09"),
    /range offline/,
  );
  assert.equal(harness.runtime.getSnapshot().rangeErrorByKey.size, 1);

  const partitionGrid = createGrid([], []);
  harness.setRangeHandler(async (): Promise<BudgetGridResult> => partitionGrid);
  assert.equal(
    (await harness.runtime.commands.loadRange("2026-07", "2026-07")).status,
    "accepted",
  );
  assert.equal(harness.runtime.getSnapshot().rangeErrorByKey.size, 1);
  assert.equal(
    (await harness.runtime.commands.loadRange("2026-08", "2026-09")).status,
    "accepted",
  );
  assert.equal(harness.runtime.getSnapshot().rangeErrorByKey.size, 0);
});

test("projects normalized drafts onto budget rows across the loaded range", (): void => {
  const initial = createAdjustment(FIRST_ID, 1, "2026-07", "Food", null);
  const harness = createHarness([initial]);
  harness.runtime.commands.replaceDraft(
    FIRST_ID,
    createDraft("4", "2026-08", "Dining", ""),
  );
  const budgetRows: ReadonlyArray<BudgetRow> = [
    {
      month: "2026-07",
      direction: "spend",
      category: "Food",
      plannedBase: 10,
      plannedModifier: 1,
      planned: 11,
      actual: 0,
      hasUnconvertible: false,
    },
    {
      month: "2026-07",
      direction: "spend",
      category: "Travel",
      plannedBase: 0,
      plannedModifier: 6,
      planned: 6,
      actual: 0,
      hasUnconvertible: false,
    },
    {
      month: "2026-07",
      direction: "transfer",
      category: "Internal",
      plannedBase: 0,
      plannedModifier: 0,
      planned: 0,
      actual: 5,
      hasUnconvertible: false,
    },
  ];

  assert.deepEqual(
    harness.runtime.commands.applyToBudgetRows(
      budgetRows,
      "2026-07",
      "2026-08",
      null,
    ),
    [
      {
        ...budgetRows[0],
        plannedModifier: 0,
        planned: 10,
      },
      budgetRows[2],
      {
        month: "2026-08",
        direction: "spend",
        category: "Dining",
        plannedBase: 0,
        plannedModifier: 4,
        planned: 4,
        actual: 0,
        hasUnconvertible: false,
      },
    ],
  );
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
