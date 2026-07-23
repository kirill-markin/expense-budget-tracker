import assert from "node:assert/strict";
import test from "node:test";

import {
  createModeTransitionCoordinator,
  type ModeTransitionRequest,
} from "@/ui/modeTransitionCoordinator";
import {
  createTableEditorActivationCoordinator,
  createTableEditorRegistration,
  createTableEditorTransitionCoordinator,
} from "@/ui/tables/shared/TableEditorActivationProvider";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

const createDeferred = <T,>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = (): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  const promise = new Promise<T>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const createEditorTransitionCoordinator = (): ReturnType<
  typeof createTableEditorTransitionCoordinator
> => {
  const activation = createTableEditorActivationCoordinator();
  return createTableEditorTransitionCoordinator({
    begin: activation.beginTransition,
    commit: activation.commitTransition,
    cancel: activation.cancelTransition,
  });
};

const createOwner = (
  editorId: string,
): ReturnType<ReturnType<typeof createTableEditorRegistration>["mount"]> => (
  createTableEditorRegistration(editorId).mount((): boolean => true)
);

test("mode transition waits for Base and adjustment lifecycles before committing", async (): Promise<void> => {
  const baseSettlement = createDeferred<boolean>();
  const adjustmentSettlement = createDeferred<boolean>();
  const editorTransitions = createEditorTransitionCoordinator();
  const settlementOrder: Array<string> = [];
  const committed: Array<ModeTransitionRequest> = [];
  editorTransitions.registerTransitionGate(createOwner("base-editor"), {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      settlementOrder.push("base");
      return baseSettlement.promise;
    },
  });
  editorTransitions.registerTransitionGate(createOwner("adjustment-editor"), {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      settlementOrder.push("adjustment");
      return adjustmentSettlement.promise;
    },
  });
  const modes = createModeTransitionCoordinator({
    settleEditors: editorTransitions.requestEditorTransition,
    commitTransition: (request): void => {
      committed.push(request);
    },
    handleSettlementFailure: (): void => {
      throw new Error("Successful settlement must not report a failure");
    },
    handleSettlementError: (): void => {
      throw new Error("Successful settlement must not report an error");
    },
  });

  const transition = modes.requestTransition({
    target: "filtered",
    source: "manual",
  });
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  assert.deepEqual(settlementOrder, ["base", "adjustment"]);
  assert.deepEqual(committed, []);

  baseSettlement.resolve(true);
  await Promise.resolve();
  assert.deepEqual(committed, []);

  adjustmentSettlement.resolve(true);
  assert.equal(await transition, true);
  assert.deepEqual(committed, [{
    target: "filtered",
    source: "manual",
  }]);
});

test("All, Filtered, and Demo failures stay retryable and commit once", async (): Promise<void> => {
  const targets = ["all", "filtered", "demo"] as const;
  for (const target of targets) {
    let settlementSucceeds = false;
    let settlementCount = 0;
    const committed: Array<ModeTransitionRequest> = [];
    const failed: Array<ModeTransitionRequest> = [];
    const modes = createModeTransitionCoordinator({
      settleEditors: (): Promise<boolean> => {
        settlementCount += 1;
        return Promise.resolve(settlementSucceeds);
      },
      commitTransition: (request): void => {
        committed.push(request);
      },
      handleSettlementFailure: (request): void => {
        failed.push(request);
      },
      handleSettlementError: (): void => {
        throw new Error("Definitive settlement failure must not report an error");
      },
    });
    const request: ModeTransitionRequest = {
      target,
      source: "manual",
    };

    assert.equal(await modes.requestTransition(request), false);
    assert.deepEqual(committed, []);
    assert.deepEqual(failed, [request]);

    settlementSucceeds = true;
    const retry = modes.retryPendingTransition();
    if (retry === null) {
      throw new Error(`Failed ${target} transition must remain pending for recovery`);
    }
    assert.equal(await retry, true);
    assert.equal(modes.retryPendingTransition(), null);
    assert.equal(settlementCount, 2);
    assert.deepEqual(committed, [request]);
    assert.deepEqual(failed, [request]);
  }
});

test("rapid requests share settlement and commit only the latest target", async (): Promise<void> => {
  const settlement = createDeferred<boolean>();
  const committed: Array<ModeTransitionRequest> = [];
  let settlementCount = 0;
  const modes = createModeTransitionCoordinator({
    settleEditors: (): Promise<boolean> => {
      settlementCount += 1;
      return settlement.promise;
    },
    commitTransition: (request): void => {
      committed.push(request);
    },
    handleSettlementFailure: (): void => {
      throw new Error("Successful settlement must not report a failure");
    },
    handleSettlementError: (): void => {
      throw new Error("Successful settlement must not report an error");
    },
  });

  const first = modes.requestTransition({ target: "all", source: "manual" });
  const repeated = modes.requestTransition({ target: "all", source: "manual" });
  const latest = modes.requestTransition({ target: "filtered", source: "manual" });

  assert.equal(first, repeated);
  assert.equal(first, latest);
  settlement.resolve(true);
  assert.equal(await first, true);
  assert.equal(settlementCount, 1);
  assert.deepEqual(committed, [{
    target: "filtered",
    source: "manual",
  }]);
});

const verifyRejectedSettlement = async (
  source: ModeTransitionRequest["source"],
): Promise<void> => {
  const expectedError = new Error(`${source} settlement failed unexpectedly`);
  const request: ModeTransitionRequest = { target: "filtered", source };
  const errors: Array<Readonly<{
    request: ModeTransitionRequest;
    error: unknown;
  }>> = [];
  let rejectSettlement = true;
  let commitCount = 0;
  const modes = createModeTransitionCoordinator({
    settleEditors: (): Promise<boolean> => (
      rejectSettlement
        ? Promise.reject(expectedError)
        : Promise.resolve(true)
    ),
    commitTransition: (): void => {
      commitCount += 1;
    },
    handleSettlementFailure: (): void => {
      throw new Error("Rejected settlement must not report a definitive failure");
    },
    handleSettlementError: (failedRequest, error): void => {
      errors.push({ request: failedRequest, error });
    },
  });

  assert.equal(await modes.requestTransition(request), false);
  assert.deepEqual(errors, [{ request, error: expectedError }]);
  assert.equal(modes.retryPendingTransition(), null);

  rejectSettlement = false;
  assert.equal(await modes.requestTransition(request), true);
  assert.equal(commitCount, 1);
};

test("a rejected automatic settlement reports its cause and clears the gate", async (): Promise<void> => {
  await verifyRejectedSettlement("automatic");
});

test("a rejected manual settlement reports its cause and clears the gate", async (): Promise<void> => {
  await verifyRejectedSettlement("manual");
});

test("recovery signals join an active transition without double settlement", async (): Promise<void> => {
  const settlement = createDeferred<boolean>();
  let settlementCount = 0;
  let commitCount = 0;
  const modes = createModeTransitionCoordinator({
    settleEditors: (): Promise<boolean> => {
      settlementCount += 1;
      return settlement.promise;
    },
    commitTransition: (): void => {
      commitCount += 1;
    },
    handleSettlementFailure: (): void => {
      throw new Error("Successful settlement must not report a failure");
    },
    handleSettlementError: (): void => {
      throw new Error("Successful settlement must not report an error");
    },
  });

  const transition = modes.requestTransition({
    target: "filtered",
    source: "manual",
  });
  const joinedRecovery = modes.retryPendingTransition();

  assert.equal(joinedRecovery, transition);
  settlement.resolve(true);
  assert.equal(await transition, true);
  assert.equal(settlementCount, 1);
  assert.equal(commitCount, 1);
});
