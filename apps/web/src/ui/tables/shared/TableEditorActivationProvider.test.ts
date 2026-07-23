import assert from "node:assert/strict";
import test from "node:test";

import {
  createTableEditorActivationCoordinator,
  createTableEditorActivationLease,
  createTableEditorRegistration,
  createTableEditorTransitionCoordinator,
  type TableEditorTransitionGate,
} from "@/ui/tables/shared/TableEditorActivationProvider";

const SOURCE_EDITOR_ID = "source-editor";
const DESTINATION_EDITOR_ID = "destination-editor";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

type ActivationCoordinator = ReturnType<typeof createTableEditorActivationCoordinator>;
type ActivationLease = ReturnType<typeof createTableEditorActivationLease>;
type ActivationLeaseContext = Parameters<typeof createTableEditorActivationLease>[2];
type Registration = ReturnType<typeof createTableEditorRegistration>;
type EditorOwner = ReturnType<Registration["mount"]>;
type RecoveryGate = Parameters<ActivationLease["registerRecoveryGate"]>[0];

type QueuedActivationScenario = Readonly<{
  activation: ActivationCoordinator;
  sourceOwner: EditorOwner;
  destinationOwner: EditorOwner;
  activatedDestinationIds: Array<string>;
}>;

const createDeferred = <T,>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = (): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  const promise = new Promise<T>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T): void => resolvePromise(value) };
};

const createMountedOwner = (editorId: string): EditorOwner => (
  createTableEditorRegistration(editorId).mount((): boolean => true)
);

const createTransitionCoordinator = (
  activation: ActivationCoordinator,
): ReturnType<typeof createTableEditorTransitionCoordinator> => (
  createTableEditorTransitionCoordinator({
    begin: activation.beginTransition,
    commit: activation.commitTransition,
    cancel: activation.cancelTransition,
  })
);

const createActivationLeaseContext = (
  activation: ActivationCoordinator,
): ActivationLeaseContext => ({
  requestActivation: activation.requestActivation,
  prepareActivationRelease: activation.prepareActivationRelease,
  cancelActivationRelease: activation.cancelActivationRelease,
  cancelActivationRequest: activation.cancelActivationRequest,
  releaseActivation: activation.releaseActivation,
  registerRecoveryGate: (): (() => void) => (): void => {},
  registerTransitionGate: (): (() => void) => (): void => {},
});

const createQueuedActivationScenario = (): QueuedActivationScenario => {
  const activation = createTableEditorActivationCoordinator();
  const sourceOwner = createMountedOwner(SOURCE_EDITOR_ID);
  const destinationOwner = createMountedOwner(DESTINATION_EDITOR_ID);
  const activatedDestinationIds: Array<string> = [];
  assert.equal(
    activation.requestActivation(sourceOwner, (): void => {}),
    "activated",
  );
  activation.prepareActivationRelease(sourceOwner);
  assert.equal(
    activation.requestActivation(destinationOwner, (): void => {
      activatedDestinationIds.push(DESTINATION_EDITOR_ID);
    }),
    "queued",
  );
  return {
    activation,
    sourceOwner,
    destinationOwner,
    activatedDestinationIds,
  };
};

const getRejection = async (promise: Promise<boolean>): Promise<unknown> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected table editor transition to reject");
};

const getRequiredMapValue = <Key, Value>(
  values: ReadonlyMap<Key, Value>,
  key: Key,
  description: string,
): Value => {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Expected ${description} to be registered`);
  }
  return value;
};

test("editor transition succeeds when no lifecycle is unresolved", async (): Promise<void> => {
  const activation = createTableEditorActivationCoordinator();
  const coordinator = createTransitionCoordinator(activation);
  coordinator.registerTransitionGate(createMountedOwner("resolved-editor"), {
    isLifecycleUnresolved: (): boolean => false,
    settleLifecycle: (): Promise<boolean> => {
      throw new Error("Resolved lifecycle must not be settled");
    },
  });

  assert.equal(await coordinator.requestEditorTransition(), true);
});

test("simultaneous editor transition requests share one settlement promise", async (): Promise<void> => {
  const settlement = createDeferred<boolean>();
  let settlementCount = 0;
  const activation = createTableEditorActivationCoordinator();
  const coordinator = createTransitionCoordinator(activation);
  coordinator.registerTransitionGate(createMountedOwner("pending-editor"), {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      settlementCount += 1;
      return settlement.promise;
    },
  });

  const firstRequest = coordinator.requestEditorTransition();
  const secondRequest = coordinator.requestEditorTransition();

  assert.equal(firstRequest, secondRequest);
  settlement.resolve(true);
  assert.equal(await firstRequest, true);
  assert.equal(settlementCount, 1);
});

test("aggregate failure cancels a successful source release without activating its destination", async (): Promise<void> => {
  const {
    activation,
    sourceOwner,
    activatedDestinationIds,
  } = createQueuedActivationScenario();
  const coordinator = createTransitionCoordinator(activation);
  let invalidGateSettlementCount = 0;
  let invalidGateSettles = false;
  coordinator.registerTransitionGate(sourceOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      activation.releaseActivation(sourceOwner);
      return Promise.resolve(true);
    },
  });
  coordinator.registerTransitionGate(createMountedOwner("invalid-editor"), {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      invalidGateSettlementCount += 1;
      return Promise.resolve(invalidGateSettles);
    },
  });

  assert.equal(await coordinator.requestEditorTransition(), false);
  assert.deepEqual(activatedDestinationIds, []);
  assert.equal(activation.releaseActivation(sourceOwner), false);
  assert.deepEqual(activatedDestinationIds, []);

  invalidGateSettles = true;
  assert.equal(await coordinator.requestEditorTransition(), true);
  assert.equal(invalidGateSettlementCount, 2);
  assert.deepEqual(activatedDestinationIds, []);
});

test("all successful lifecycles commit one deferred destination handoff", async (): Promise<void> => {
  const {
    activation,
    sourceOwner,
    destinationOwner,
    activatedDestinationIds,
  } = createQueuedActivationScenario();
  const coordinator = createTransitionCoordinator(activation);
  coordinator.registerTransitionGate(sourceOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      activation.releaseActivation(sourceOwner);
      return Promise.resolve(true);
    },
  });
  coordinator.registerTransitionGate(createMountedOwner("second-editor"), {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => Promise.resolve(true),
  });

  assert.equal(await coordinator.requestEditorTransition(), true);
  assert.deepEqual(activatedDestinationIds, [DESTINATION_EDITOR_ID]);
  assert.equal(activation.getActiveOwner(), destinationOwner);
  assert.equal(activation.releaseActivation(sourceOwner), false);
  assert.deepEqual(activatedDestinationIds, [DESTINATION_EDITOR_ID]);
});

test("releasing source generation cannot reactivate while aggregate settlement is pending", async (): Promise<void> => {
  const {
    activation,
    sourceOwner,
    activatedDestinationIds,
  } = createQueuedActivationScenario();
  const sourceReleased = createDeferred<void>();
  const secondSettlement = createDeferred<boolean>();
  const coordinator = createTransitionCoordinator(activation);
  let sourceReactivationCount = 0;
  coordinator.registerTransitionGate(sourceOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      activation.releaseActivation(sourceOwner);
      sourceReleased.resolve(undefined);
      return Promise.resolve(true);
    },
  });
  coordinator.registerTransitionGate(createMountedOwner("second-editor"), {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => secondSettlement.promise,
  });

  const transition = coordinator.requestEditorTransition();
  await sourceReleased.promise;
  assert.equal(
    activation.requestActivation(sourceOwner, (): void => {
      sourceReactivationCount += 1;
    }),
    "denied",
  );
  assert.equal(sourceReactivationCount, 0);
  assert.deepEqual(activatedDestinationIds, []);

  secondSettlement.resolve(true);
  assert.equal(await transition, true);
  assert.equal(sourceReactivationCount, 0);
  assert.deepEqual(activatedDestinationIds, [DESTINATION_EDITOR_ID]);
});

test("old-generation queued initializer stays dead after same-ID remount", (): void => {
  let oldInitializationCount = 0;
  let newInitializationCount = 0;
  const sourceOwner = createMountedOwner(SOURCE_EDITOR_ID);
  const destinationRegistration = createTableEditorRegistration(DESTINATION_EDITOR_ID);
  const oldDestinationOwner = destinationRegistration.mount((): boolean => {
    oldInitializationCount += 1;
    return true;
  });
  const activation = createTableEditorActivationCoordinator();
  assert.equal(activation.requestActivation(sourceOwner, (): void => {}), "activated");
  activation.prepareActivationRelease(sourceOwner);
  assert.equal(
    activation.requestActivation(oldDestinationOwner, (): void => {
      if (destinationRegistration.initializeLatest(oldDestinationOwner)) return;
      activation.releaseActivation(oldDestinationOwner);
    }),
    "queued",
  );

  destinationRegistration.unmount(oldDestinationOwner);
  const newDestinationOwner = destinationRegistration.mount((): boolean => {
    newInitializationCount += 1;
    return true;
  });
  assert.notEqual(newDestinationOwner.generation, oldDestinationOwner.generation);
  assert.equal(activation.releaseActivation(sourceOwner), true);
  assert.equal(oldInitializationCount, 0);
  assert.equal(newInitializationCount, 0);
  assert.equal(activation.getActiveOwner(), null);
  assert.equal(destinationRegistration.initializeLatest(newDestinationOwner), true);
  assert.equal(newInitializationCount, 1);
});

test("old-generation cleanup cannot release newer same-ID ownership", (): void => {
  const registration = createTableEditorRegistration(SOURCE_EDITOR_ID);
  const oldOwner = registration.mount((): boolean => true);
  const activation = createTableEditorActivationCoordinator();
  assert.equal(activation.requestActivation(oldOwner, (): void => {}), "activated");
  registration.unmount(oldOwner);
  assert.equal(activation.releaseActivation(oldOwner), false);

  const newOwner = registration.mount((): boolean => true);
  assert.equal(activation.requestActivation(newOwner, (): void => {}), "activated");
  activation.cancelActivationRequest(oldOwner);
  activation.cancelActivationRelease(oldOwner);
  assert.equal(activation.releaseActivation(oldOwner), false);
  assert.equal(activation.getActiveOwner(), newOwner);
});

test("throwing immediate initializer releases only its captured owner", (): void => {
  const expectedError = new Error("Immediate initialization failed");
  const activation = createTableEditorActivationCoordinator();
  const registration = createTableEditorRegistration("throwing-editor");
  const oldOwner = registration.mount((): boolean => {
    throw expectedError;
  });
  const oldLease = createTableEditorActivationLease(
    registration,
    oldOwner,
    createActivationLeaseContext(activation),
  );
  let thrownError: unknown = null;

  try {
    oldLease.requestActivation();
  } catch (error: unknown) {
    thrownError = error;
  }

  assert.equal(thrownError, expectedError);
  assert.equal(activation.getActiveOwner(), null);
  registration.unmount(oldOwner);
  const newOwner = registration.mount((): boolean => true);
  const newLease = createTableEditorActivationLease(
    registration,
    newOwner,
    createActivationLeaseContext(activation),
  );
  assert.equal(newLease.requestActivation(), "activated");
  assert.equal(oldLease.releaseActivation(), false);
  assert.equal(activation.getActiveOwner(), newOwner);
});

test("throwing queued initializer releases its owner during transition commit", async (): Promise<void> => {
  const expectedError = new Error("Queued initialization failed");
  const activation = createTableEditorActivationCoordinator();
  const sourceOwner = createMountedOwner(SOURCE_EDITOR_ID);
  const destinationRegistration = createTableEditorRegistration(DESTINATION_EDITOR_ID);
  const destinationOwner = destinationRegistration.mount((): boolean => {
    throw expectedError;
  });
  const destinationLease = createTableEditorActivationLease(
    destinationRegistration,
    destinationOwner,
    createActivationLeaseContext(activation),
  );
  assert.equal(activation.requestActivation(sourceOwner, (): void => {}), "activated");
  activation.prepareActivationRelease(sourceOwner);
  assert.equal(destinationLease.requestActivation(), "queued");
  const transition = createTransitionCoordinator(activation);
  transition.registerTransitionGate(sourceOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      activation.releaseActivation(sourceOwner);
      return Promise.resolve(true);
    },
  });

  const rejection = await getRejection(transition.requestEditorTransition());

  assert.equal(rejection, expectedError);
  assert.equal(activation.getActiveOwner(), null);
  const laterOwner = createMountedOwner("later-editor");
  assert.equal(activation.requestActivation(laterOwner, (): void => {}), "activated");
  assert.equal(destinationLease.releaseActivation(), false);
  assert.equal(activation.getActiveOwner(), laterOwner);
});

test("old recovery and transition wrappers stay dead after same-ID remount", async (): Promise<void> => {
  let oldRecoveryCount = 0;
  let oldSettlementCount = 0;
  let newRecoveryCount = 0;
  let newSettlementCount = 0;
  const registration = createTableEditorRegistration("wrapped-editor");
  const oldOwner = registration.mount((): boolean => true);
  const oldRecoveryGate = registration.guardRecoveryGate(oldOwner, {
    ownsAdjustment: (): boolean => true,
    recoverAdjustment: (): Promise<void> => {
      oldRecoveryCount += 1;
      return Promise.resolve();
    },
  });
  const oldTransitionGate = registration.guardTransitionGate(oldOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      oldSettlementCount += 1;
      return Promise.resolve(true);
    },
  });

  registration.unmount(oldOwner);
  const newOwner = registration.mount((): boolean => true);
  const newRecoveryGate = registration.guardRecoveryGate(newOwner, {
    ownsAdjustment: (): boolean => true,
    recoverAdjustment: (): Promise<void> => {
      newRecoveryCount += 1;
      return Promise.resolve();
    },
  });
  const newTransitionGate = registration.guardTransitionGate(newOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      newSettlementCount += 1;
      return Promise.resolve(true);
    },
  });

  assert.equal(oldRecoveryGate.ownsAdjustment("adjustment-1"), false);
  await oldRecoveryGate.recoverAdjustment("adjustment-1");
  assert.equal(oldTransitionGate.isLifecycleUnresolved(), false);
  assert.equal(await oldTransitionGate.settleLifecycle(), true);
  assert.equal(oldRecoveryCount, 0);
  assert.equal(oldSettlementCount, 0);

  assert.equal(newRecoveryGate.ownsAdjustment("adjustment-1"), true);
  await newRecoveryGate.recoverAdjustment("adjustment-1");
  assert.equal(newTransitionGate.isLifecycleUnresolved(), true);
  assert.equal(await newTransitionGate.settleLifecycle(), true);
  assert.equal(newRecoveryCount, 1);
  assert.equal(newSettlementCount, 1);
});

test("retained hook lease callbacks stay stale after same-ID remount", async (): Promise<void> => {
  const activation = createTableEditorActivationCoordinator();
  const registration = createTableEditorRegistration("leased-editor");
  const forwardedOperations: Array<string> = [];
  const recoveryGates = new Map<EditorOwner, RecoveryGate>();
  const transitionGates = new Map<EditorOwner, TableEditorTransitionGate>();
  const context: ActivationLeaseContext = {
    requestActivation: (owner, initializeEditor) => {
      forwardedOperations.push("request");
      return activation.requestActivation(owner, initializeEditor);
    },
    prepareActivationRelease: (owner): void => {
      forwardedOperations.push("prepare");
      activation.prepareActivationRelease(owner);
    },
    cancelActivationRelease: (owner): void => {
      forwardedOperations.push("cancel-release");
      activation.cancelActivationRelease(owner);
    },
    cancelActivationRequest: (owner): void => {
      forwardedOperations.push("cancel-request");
      activation.cancelActivationRequest(owner);
    },
    releaseActivation: (owner): boolean => {
      forwardedOperations.push("release");
      return activation.releaseActivation(owner);
    },
    registerRecoveryGate: (owner, gate): (() => void) => {
      forwardedOperations.push("register-recovery");
      recoveryGates.set(owner, gate);
      return (): void => {
        if (recoveryGates.get(owner) === gate) recoveryGates.delete(owner);
      };
    },
    registerTransitionGate: (owner, gate): (() => void) => {
      forwardedOperations.push("register-transition");
      transitionGates.set(owner, gate);
      return (): void => {
        if (transitionGates.get(owner) === gate) transitionGates.delete(owner);
      };
    },
  };
  let oldInitializationCount = 0;
  let newInitializationCount = 0;
  let oldRecoveryCount = 0;
  let oldSettlementCount = 0;
  let newRecoveryCount = 0;
  let newSettlementCount = 0;

  const oldOwner = registration.mount((): boolean => {
    oldInitializationCount += 1;
    return true;
  });
  const oldLease = createTableEditorActivationLease(registration, oldOwner, context);
  oldLease.registerRecoveryGate({
    ownsAdjustment: (): boolean => true,
    recoverAdjustment: (): Promise<void> => {
      oldRecoveryCount += 1;
      return Promise.resolve();
    },
  });
  oldLease.registerTransitionGate({
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      oldSettlementCount += 1;
      return Promise.resolve(true);
    },
  });
  const guardedOldRecoveryGate = getRequiredMapValue(
    recoveryGates,
    oldOwner,
    "old recovery gate",
  );
  const guardedOldTransitionGate = getRequiredMapValue(
    transitionGates,
    oldOwner,
    "old transition gate",
  );
  assert.equal(oldLease.requestActivation(), "activated");
  assert.equal(oldInitializationCount, 1);

  registration.unmount(oldOwner);
  activation.cancelActivationRequest(oldOwner);
  activation.releaseActivation(oldOwner);
  const newOwner = registration.mount((): boolean => {
    newInitializationCount += 1;
    return true;
  });
  const newLease = createTableEditorActivationLease(registration, newOwner, context);
  assert.equal(newLease.requestActivation(), "activated");
  assert.equal(newInitializationCount, 1);
  const forwardedBeforeStaleCalls = [...forwardedOperations];

  assert.equal(oldLease.requestActivation(), "denied");
  assert.throws(
    (): void => oldLease.prepareActivationRelease(),
    /stale table editor activation lease/,
  );
  oldLease.cancelActivationRelease();
  oldLease.cancelActivationRequest();
  assert.equal(oldLease.releaseActivation(), false);
  assert.throws(
    (): void => {
      oldLease.registerRecoveryGate({
        ownsAdjustment: (): boolean => true,
        recoverAdjustment: (): Promise<void> => Promise.resolve(),
      });
    },
    /stale table editor activation lease/,
  );
  assert.throws(
    (): void => {
      oldLease.registerTransitionGate({
        isLifecycleUnresolved: (): boolean => true,
        settleLifecycle: (): Promise<boolean> => Promise.resolve(true),
      });
    },
    /stale table editor activation lease/,
  );
  assert.deepEqual(forwardedOperations, forwardedBeforeStaleCalls);
  assert.equal(guardedOldRecoveryGate.ownsAdjustment("adjustment-1"), false);
  await guardedOldRecoveryGate.recoverAdjustment("adjustment-1");
  assert.equal(guardedOldTransitionGate.isLifecycleUnresolved(), false);
  assert.equal(await guardedOldTransitionGate.settleLifecycle(), true);
  assert.equal(oldRecoveryCount, 0);
  assert.equal(oldSettlementCount, 0);
  assert.equal(activation.getActiveOwner(), newOwner);

  newLease.registerRecoveryGate({
    ownsAdjustment: (): boolean => true,
    recoverAdjustment: (): Promise<void> => {
      newRecoveryCount += 1;
      return Promise.resolve();
    },
  });
  newLease.registerTransitionGate({
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      newSettlementCount += 1;
      return Promise.resolve(true);
    },
  });
  const guardedNewRecoveryGate = getRequiredMapValue(
    recoveryGates,
    newOwner,
    "new recovery gate",
  );
  const guardedNewTransitionGate = getRequiredMapValue(
    transitionGates,
    newOwner,
    "new transition gate",
  );
  assert.equal(guardedNewRecoveryGate.ownsAdjustment("adjustment-1"), true);
  await guardedNewRecoveryGate.recoverAdjustment("adjustment-1");
  assert.equal(guardedNewTransitionGate.isLifecycleUnresolved(), true);
  assert.equal(await guardedNewTransitionGate.settleLifecycle(), true);
  assert.equal(newRecoveryCount, 1);
  assert.equal(newSettlementCount, 1);
  newLease.prepareActivationRelease();
  newLease.cancelActivationRelease();
  newLease.cancelActivationRequest();
  assert.equal(newLease.releaseActivation(), false);
  assert.equal(activation.getActiveOwner(), null);
});

test("queued initialization uses only the latest committed initializer", (): void => {
  const calls: Array<string> = [];
  const registration = createTableEditorRegistration(DESTINATION_EDITOR_ID);
  const owner = registration.mount((): boolean => {
    calls.push("first-committed");
    return true;
  });
  const uncommittedCandidate = (): boolean => {
    calls.push("discarded");
    return true;
  };
  void uncommittedCandidate;

  assert.equal(registration.initializeLatest(owner), true);
  registration.updateInitializer(owner, (): boolean => {
    calls.push("latest-committed");
    return true;
  });
  assert.equal(registration.initializeLatest(owner), true);
  assert.deepEqual(calls, ["first-committed", "latest-committed"]);
});

test("strict-style remount creates a usable new generation", (): void => {
  let initializationCount = 0;
  const registration = createTableEditorRegistration(SOURCE_EDITOR_ID);
  const oldOwner = registration.mount((): boolean => {
    initializationCount += 1;
    return true;
  });
  registration.unmount(oldOwner);
  const newOwner = registration.mount((): boolean => {
    initializationCount += 1;
    return true;
  });

  assert.notEqual(newOwner.generation, oldOwner.generation);
  assert.equal(registration.initializeLatest(oldOwner), false);
  assert.equal(registration.initializeLatest(newOwner), true);
  assert.equal(initializationCount, 1);
});

test("synchronous unresolved-lifecycle failure cancels the prepared transfer", async (): Promise<void> => {
  const expectedError = new Error("Unresolved lifecycle check failed");
  const {
    activation,
    sourceOwner,
    activatedDestinationIds,
  } = createQueuedActivationScenario();
  const coordinator = createTransitionCoordinator(activation);
  coordinator.registerTransitionGate(sourceOwner, {
    isLifecycleUnresolved: (): boolean => {
      throw expectedError;
    },
    settleLifecycle: (): Promise<boolean> => Promise.resolve(true),
  });

  const rejection = await getRejection(coordinator.requestEditorTransition());

  assert.equal(rejection, expectedError);
  assert.equal(activation.getActiveOwner(), sourceOwner);
  assert.equal(activation.releaseActivation(sourceOwner), false);
  assert.deepEqual(activatedDestinationIds, []);
});

test("synchronous settlement failure cancels the prepared transfer", async (): Promise<void> => {
  const expectedError = new Error("Lifecycle settlement failed synchronously");
  const {
    activation,
    sourceOwner,
    activatedDestinationIds,
  } = createQueuedActivationScenario();
  const coordinator = createTransitionCoordinator(activation);
  const gate: TableEditorTransitionGate = {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => {
      throw expectedError;
    },
  };
  coordinator.registerTransitionGate(sourceOwner, gate);

  const rejection = await getRejection(coordinator.requestEditorTransition());

  assert.equal(rejection, expectedError);
  assert.equal(activation.getActiveOwner(), sourceOwner);
  assert.equal(activation.releaseActivation(sourceOwner), false);
  assert.deepEqual(activatedDestinationIds, []);
});

test("rejected settlement cancels the prepared transfer", async (): Promise<void> => {
  const expectedError = new Error("Lifecycle settlement rejected");
  const {
    activation,
    sourceOwner,
    activatedDestinationIds,
  } = createQueuedActivationScenario();
  const coordinator = createTransitionCoordinator(activation);
  coordinator.registerTransitionGate(sourceOwner, {
    isLifecycleUnresolved: (): boolean => true,
    settleLifecycle: (): Promise<boolean> => Promise.reject(expectedError),
  });

  const rejection = await getRejection(coordinator.requestEditorTransition());

  assert.equal(rejection, expectedError);
  assert.equal(activation.getActiveOwner(), sourceOwner);
  assert.equal(activation.releaseActivation(sourceOwner), false);
  assert.deepEqual(activatedDestinationIds, []);
});
