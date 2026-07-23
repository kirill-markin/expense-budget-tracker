import assert from "node:assert/strict";
import test from "node:test";

import {
  createBudgetBaseEditorController,
  type BudgetBaseDraftSnapshot,
} from "@/ui/tables/budget/controller/budgetBaseEditorController";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}>;

const createDeferred = <T,>(): Deferred<T> => {
  let resolvePromise = (_value: T): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  let rejectPromise = (_error: Error): void => {
    throw new Error("Deferred rejecter was used before initialization");
  };
  const promise = new Promise<T>((resolve, reject): void => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("serializes Base saves and settles through the newest superseding draft", async (): Promise<void> => {
  const firstSave = createDeferred<void>();
  const secondSave = createDeferred<void>();
  const secondSaveStarted = createDeferred<void>();
  const calls: Array<BudgetBaseDraftSnapshot> = [];
  const controller = createBudgetBaseEditorController(
    100,
    (snapshot): Promise<void> => {
      calls.push(snapshot);
      if (calls.length === 2) secondSaveStarted.resolve();
      return calls.length === 1 ? firstSave.promise : secondSave.promise;
    },
  );

  controller.updateDraft(200);
  const settlement = controller.settleLatest();
  await flushMicrotasks();
  assert.deepEqual(calls.map((snapshot) => snapshot.value), [200]);

  controller.updateDraft(300);
  const joinedSettlement = controller.settleLatest();
  assert.equal(joinedSettlement, settlement);

  let settled = false;
  void settlement.then((): void => {
    settled = true;
  });
  firstSave.resolve();
  await secondSaveStarted.promise;
  assert.equal(settled, false);
  assert.deepEqual(calls.map((snapshot) => snapshot.value), [200, 300]);

  secondSave.resolve();
  assert.deepEqual(await settlement, {
    status: "settled",
    acknowledgement: { revision: 2, value: 300 },
  });
  assert.equal(settled, true);
});

test("skips a queued revision superseded before its request begins", async (): Promise<void> => {
  const firstSave = createDeferred<void>();
  const calls: Array<number> = [];
  const controller = createBudgetBaseEditorController(
    100,
    (snapshot): Promise<void> => {
      if (snapshot.value === null) {
        throw new Error("A valid Base snapshot is required");
      }
      calls.push(snapshot.value);
      return calls.length === 1 ? firstSave.promise : Promise.resolve();
    },
  );

  controller.updateDraft(200);
  const settlement = controller.settleLatest();
  await flushMicrotasks();
  controller.updateDraft(300);
  controller.updateDraft(400);
  firstSave.resolve();

  assert.equal((await settlement).status, "settled");
  assert.deepEqual(calls, [200, 400]);
  assert.equal(controller.getAcknowledgement().value, 400);
});

test("continues after a superseded failure and reports only the newest result", async (): Promise<void> => {
  const firstSave = createDeferred<void>();
  const calls: Array<number> = [];
  const controller = createBudgetBaseEditorController(
    100,
    (snapshot): Promise<void> => {
      if (snapshot.value === null) {
        throw new Error("A valid Base snapshot is required");
      }
      calls.push(snapshot.value);
      return calls.length === 1 ? firstSave.promise : Promise.resolve();
    },
  );

  controller.updateDraft(200);
  const settlement = controller.settleLatest();
  await flushMicrotasks();
  controller.updateDraft(300);
  firstSave.reject(new Error("superseded failure"));

  assert.deepEqual(await settlement, {
    status: "settled",
    acknowledgement: { revision: 2, value: 300 },
  });
  assert.deepEqual(calls, [200, 300]);
});

test("settles back to the acknowledgement after a superseded save fails", async (): Promise<void> => {
  const failedSave = createDeferred<void>();
  const calls: Array<number> = [];
  const controller = createBudgetBaseEditorController(
    100,
    (snapshot): Promise<void> => {
      if (snapshot.value === null) {
        throw new Error("A valid Base snapshot is required");
      }
      calls.push(snapshot.value);
      return failedSave.promise;
    },
  );

  controller.updateDraft(200);
  const settlement = controller.settleLatest();
  await flushMicrotasks();
  controller.updateDraft(100);
  failedSave.reject(new Error("superseded failure"));

  assert.deepEqual(await settlement, {
    status: "settled",
    acknowledgement: { revision: 2, value: 100 },
  });
  assert.deepEqual(calls, [200]);
});

test("returns a definitive failure with the latest acknowledged Base", async (): Promise<void> => {
  const failure = new Error("save failed");
  const controller = createBudgetBaseEditorController(
    100,
    (): Promise<void> => Promise.reject(failure),
  );

  const failedDraft = controller.updateDraft(200);
  assert.deepEqual(await controller.settleLatest(), {
    status: "failed",
    acknowledgement: { revision: 0, value: 100 },
    draft: failedDraft,
    error: failure,
  });

  assert.deepEqual(controller.rollbackToAcknowledgement(), {
    revision: failedDraft.revision,
    value: 100,
  });
  assert.equal(controller.isDirty(), false);
});

test("cancellation finishes only the active save before discarding a newer valid draft", async (): Promise<void> => {
  const save = createDeferred<void>();
  const calls: Array<number> = [];
  const controller = createBudgetBaseEditorController(
    100,
    (snapshot): Promise<void> => {
      if (snapshot.value === null) {
        throw new Error("A valid Base snapshot is required");
      }
      calls.push(snapshot.value);
      return save.promise;
    },
  );

  controller.updateDraft(200);
  const settlement = controller.settleLatest();
  await flushMicrotasks();
  controller.updateDraft(300);

  const cancellation = controller.cancelDraft();
  let cancellationResolved = false;
  void cancellation.then((): void => {
    cancellationResolved = true;
  });
  await flushMicrotasks();
  assert.equal(cancellationResolved, false);

  save.resolve();
  assert.deepEqual(await settlement, {
    status: "interrupted",
    acknowledgement: { revision: 1, value: 200 },
    draft: { revision: 2, value: 300 },
  });
  assert.deepEqual(await cancellation, {
    status: "cancelled",
    acknowledgement: { revision: 1, value: 200 },
    draft: { revision: 2, value: 200 },
  });
  assert.deepEqual(controller.getDraft(), {
    revision: 2,
    value: 200,
  });
  assert.deepEqual(calls, [200]);
});

test("cancellation dismisses an already-recovered failure without another revision", async (): Promise<void> => {
  const failure = new Error("save failed");
  let callCount = 0;
  const controller = createBudgetBaseEditorController(
    100,
    (): Promise<void> => {
      callCount += 1;
      return Promise.reject(failure);
    },
  );

  const failedDraft = controller.updateDraft(200);
  assert.equal((await controller.settleLatest()).status, "failed");
  assert.deepEqual(controller.rollbackToAcknowledgement(), {
    revision: failedDraft.revision,
    value: 100,
  });

  assert.deepEqual(await controller.cancelDraft(), {
    status: "cancelled",
    acknowledgement: { revision: 0, value: 100 },
    draft: { revision: failedDraft.revision, value: 100 },
  });
  assert.equal(controller.getDraft().revision, failedDraft.revision);
  assert.equal(callCount, 1);
});

test("accepts finite rounded Base values outside the safe integer range", (): void => {
  const outsideSafeIntegerRange = Number.MAX_SAFE_INTEGER + 1;
  const controller = createBudgetBaseEditorController(
    outsideSafeIntegerRange,
    (): Promise<void> => Promise.resolve(),
  );

  assert.deepEqual(controller.getAcknowledgement(), {
    revision: 0,
    value: outsideSafeIntegerRange,
  });
  assert.deepEqual(controller.updateDraft(-outsideSafeIntegerRange), {
    revision: 1,
    value: -outsideSafeIntegerRange,
  });
});

test("rejects reinitialization while persistence or a dirty draft is unsettled", async (): Promise<void> => {
  const save = createDeferred<void>();
  const controller = createBudgetBaseEditorController(
    100,
    (): Promise<void> => save.promise,
  );

  controller.updateDraft(200);
  assert.throws(
    (): void => controller.synchronizeAcknowledgement(300),
    /lifecycle is unresolved/,
  );

  const settlement = controller.settleLatest();
  await flushMicrotasks();
  assert.throws(
    (): void => controller.synchronizeAcknowledgement(300),
    /lifecycle is unresolved/,
  );
  save.resolve();
  await settlement;

  controller.synchronizeAcknowledgement(300);
  assert.deepEqual(controller.getDraft(), { revision: 1, value: 300 });
  assert.deepEqual(controller.getAcknowledgement(), { revision: 1, value: 300 });
});
