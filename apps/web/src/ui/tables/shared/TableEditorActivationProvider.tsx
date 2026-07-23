"use client";

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type TableEditorActivationRequestOutcome = "activated" | "queued" | "denied";

type TableEditorGeneration = Readonly<{
  token: symbol;
}>;

type TableEditorOwner = Readonly<{
  editorId: string;
  generation: TableEditorGeneration;
}>;

type QueuedTableEditorActivation = Readonly<{
  owner: TableEditorOwner;
  activate: () => void;
}>;

type TableEditorRecoveryGate = Readonly<{
  ownsAdjustment: (adjustmentId: string) => boolean;
  recoverAdjustment: (adjustmentId: string) => Promise<void>;
}>;

export type TableEditorTransitionGate = Readonly<{
  isLifecycleUnresolved: () => boolean;
  settleLifecycle: () => Promise<boolean>;
}>;

type TableEditorRegistration = Readonly<{
  mount: (initializeEditor: () => boolean) => TableEditorOwner;
  updateInitializer: (
    owner: TableEditorOwner,
    initializeEditor: () => boolean,
  ) => void;
  unmount: (owner: TableEditorOwner) => void;
  isLive: (owner: TableEditorOwner) => boolean;
  getLiveOwner: () => TableEditorOwner | null;
  initializeLatest: (owner: TableEditorOwner) => boolean;
  guardRecoveryGate: (
    owner: TableEditorOwner,
    gate: TableEditorRecoveryGate,
  ) => TableEditorRecoveryGate;
  guardTransitionGate: (
    owner: TableEditorOwner,
    gate: TableEditorTransitionGate,
  ) => TableEditorTransitionGate;
}>;

export const createTableEditorRegistration = (
  editorId: string,
): TableEditorRegistration => {
  let liveOwner: TableEditorOwner | null = null;
  let latestInitializer: (() => boolean) | null = null;

  const ownsLiveGeneration = (owner: TableEditorOwner): boolean => (
    liveOwner !== null
    && liveOwner.editorId === owner.editorId
    && liveOwner.generation === owner.generation
  );
  const mount = (initializeEditor: () => boolean): TableEditorOwner => {
    if (liveOwner !== null) {
      throw new Error(`Cannot mount live table editor registration "${editorId}" twice`);
    }
    const owner: TableEditorOwner = {
      editorId,
      generation: { token: Symbol(editorId) },
    };
    liveOwner = owner;
    latestInitializer = initializeEditor;
    return owner;
  };
  const updateInitializer = (
    owner: TableEditorOwner,
    initializeEditor: () => boolean,
  ): void => {
    if (!ownsLiveGeneration(owner)) return;
    latestInitializer = initializeEditor;
  };
  const unmount = (owner: TableEditorOwner): void => {
    if (!ownsLiveGeneration(owner)) return;
    liveOwner = null;
    latestInitializer = null;
  };
  const getLiveOwner = (): TableEditorOwner | null => liveOwner;
  const initializeLatest = (owner: TableEditorOwner): boolean => (
    ownsLiveGeneration(owner)
    && latestInitializer !== null
    && latestInitializer()
  );
  const guardRecoveryGate = (
    owner: TableEditorOwner,
    gate: TableEditorRecoveryGate,
  ): TableEditorRecoveryGate => ({
    ownsAdjustment: (adjustmentId): boolean => (
      ownsLiveGeneration(owner) && gate.ownsAdjustment(adjustmentId)
    ),
    recoverAdjustment: (adjustmentId): Promise<void> => (
      ownsLiveGeneration(owner)
        ? gate.recoverAdjustment(adjustmentId)
        : Promise.resolve()
    ),
  });
  const guardTransitionGate = (
    owner: TableEditorOwner,
    gate: TableEditorTransitionGate,
  ): TableEditorTransitionGate => ({
    isLifecycleUnresolved: (): boolean => (
      ownsLiveGeneration(owner) && gate.isLifecycleUnresolved()
    ),
    settleLifecycle: (): Promise<boolean> => (
      ownsLiveGeneration(owner)
        ? gate.settleLifecycle()
        : Promise.resolve(true)
    ),
  });

  return {
    mount,
    updateInitializer,
    unmount,
    isLive: ownsLiveGeneration,
    getLiveOwner,
    initializeLatest,
    guardRecoveryGate,
    guardTransitionGate,
  };
};

type RegisteredTableEditorTransitionGate = Readonly<{
  owner: TableEditorOwner;
  gate: TableEditorTransitionGate;
}>;

type TableEditorActivationCoordinator = Readonly<{
  getActiveOwner: () => TableEditorOwner | null;
  requestActivation: (
    owner: TableEditorOwner,
    activateWhenAvailable: () => void,
  ) => TableEditorActivationRequestOutcome;
  prepareActivationRelease: (owner: TableEditorOwner) => void;
  cancelActivationRelease: (owner: TableEditorOwner) => void;
  cancelActivationRequest: (owner: TableEditorOwner) => void;
  releaseActivation: (owner: TableEditorOwner) => boolean;
  beginTransition: () => void;
  commitTransition: () => void;
  cancelTransition: () => void;
}>;

export const createTableEditorActivationCoordinator = (): TableEditorActivationCoordinator => {
  let activeOwner: TableEditorOwner | null = null;
  let releasingOwner: TableEditorOwner | null = null;
  let queuedActivation: QueuedTableEditorActivation | null = null;
  let transitionActive = false;
  let deferredReleaseOwner: TableEditorOwner | null = null;

  const ownersMatch = (
    firstOwner: TableEditorOwner | null,
    secondOwner: TableEditorOwner,
  ): boolean => (
    firstOwner !== null
    && firstOwner.editorId === secondOwner.editorId
    && firstOwner.generation === secondOwner.generation
  );
  const getActiveOwner = (): TableEditorOwner | null => activeOwner;

  const requestActivation = (
    owner: TableEditorOwner,
    activateWhenAvailable: () => void,
  ): TableEditorActivationRequestOutcome => {
    if (
      ownersMatch(activeOwner, owner)
      && (ownersMatch(releasingOwner, owner) || ownersMatch(deferredReleaseOwner, owner))
    ) {
      return "denied";
    }
    if (activeOwner !== null && !ownersMatch(activeOwner, owner)) {
      if (!ownersMatch(releasingOwner, activeOwner)) return "denied";
      queuedActivation = { owner, activate: activateWhenAvailable };
      return "queued";
    }
    activeOwner = owner;
    return "activated";
  };

  const prepareActivationRelease = (owner: TableEditorOwner): void => {
    if (activeOwner === null) {
      activeOwner = owner;
    } else if (!ownersMatch(activeOwner, owner)) {
      throw new Error(`Cannot prepare inactive table editor "${owner.editorId}" for release`);
    }
    releasingOwner = owner;
  };

  const cancelActivationRelease = (owner: TableEditorOwner): void => {
    if (!ownersMatch(releasingOwner, owner)) return;
    releasingOwner = null;
    queuedActivation = null;
  };

  const cancelActivationRequest = (owner: TableEditorOwner): void => {
    if (
      queuedActivation !== null
      && ownersMatch(queuedActivation.owner, owner)
    ) {
      queuedActivation = null;
    }
  };

  const completeRelease = (
    owner: TableEditorOwner,
    activateQueuedEditor: boolean,
  ): boolean => {
    if (!ownersMatch(activeOwner, owner)) return false;
    activeOwner = null;
    releasingOwner = null;
    const activation = queuedActivation;
    queuedActivation = null;
    if (!activateQueuedEditor || activation === null) return false;
    activeOwner = activation.owner;
    activation.activate();
    return true;
  };

  const releaseActivation = (owner: TableEditorOwner): boolean => {
    if (!ownersMatch(activeOwner, owner)) return false;
    if (transitionActive) {
      releasingOwner = owner;
      deferredReleaseOwner = owner;
      return queuedActivation !== null;
    }
    return completeRelease(owner, true);
  };

  const beginTransition = (): void => {
    if (transitionActive) {
      throw new Error("Cannot begin a table editor transition while another transition is active");
    }
    transitionActive = true;
    deferredReleaseOwner = null;
  };

  const commitTransition = (): void => {
    if (!transitionActive) {
      throw new Error("Cannot commit a table editor transition that is not active");
    }
    transitionActive = false;
    const releasedOwner = deferredReleaseOwner;
    deferredReleaseOwner = null;
    if (releasedOwner !== null) {
      completeRelease(releasedOwner, true);
    }
  };

  const cancelTransition = (): void => {
    if (!transitionActive) return;
    transitionActive = false;
    const releasedOwner = deferredReleaseOwner;
    deferredReleaseOwner = null;
    queuedActivation = null;
    releasingOwner = null;
    if (releasedOwner !== null && ownersMatch(activeOwner, releasedOwner)) {
      activeOwner = null;
    }
  };

  return {
    getActiveOwner,
    requestActivation,
    prepareActivationRelease,
    cancelActivationRelease,
    cancelActivationRequest,
    releaseActivation,
    beginTransition,
    commitTransition,
    cancelTransition,
  };
};

type TableEditorTransitionTransaction = Readonly<{
  begin: () => void;
  commit: () => void;
  cancel: () => void;
}>;

type TableEditorTransitionCoordinator = Readonly<{
  registerTransitionGate: (
    owner: TableEditorOwner,
    gate: TableEditorTransitionGate,
  ) => () => void;
  requestEditorTransition: () => Promise<boolean>;
}>;

export const createTableEditorTransitionCoordinator = (
  transaction: TableEditorTransitionTransaction,
): TableEditorTransitionCoordinator => {
  const transitionGates = new Map<TableEditorOwner, TableEditorTransitionGate>();
  let activeTransitionRequest: Promise<boolean> | null = null;

  const registerTransitionGate = (
    owner: TableEditorOwner,
    gate: TableEditorTransitionGate,
  ): (() => void) => {
    transitionGates.set(owner, gate);
    return (): void => {
      if (transitionGates.get(owner) === gate) {
        transitionGates.delete(owner);
      }
    };
  };

  const requestEditorTransition = (): Promise<boolean> => {
    if (activeTransitionRequest !== null) return activeTransitionRequest;

    transaction.begin();
    let request: Promise<boolean>;
    request = Promise.resolve()
      .then((): ReadonlyArray<RegisteredTableEditorTransitionGate> => (
        Array.from(transitionGates, ([owner, gate]) => ({ owner, gate }))
          .filter(({ gate }) => gate.isLifecycleUnresolved())
      ))
      .then((unresolvedGates): Promise<ReadonlyArray<boolean>> => (
        Promise.all(unresolvedGates.map(({ gate }) => gate.settleLifecycle()))
      ))
      .then((settledLifecycles): boolean => {
        const settled = settledLifecycles.every(Boolean);
        if (settled) {
          transaction.commit();
        } else {
          transaction.cancel();
        }
        return settled;
      })
      .catch((error: unknown): never => {
        transaction.cancel();
        throw error;
      })
      .finally((): void => {
        if (activeTransitionRequest === request) {
          activeTransitionRequest = null;
        }
      });
    activeTransitionRequest = request;
    return request;
  };

  return { registerTransitionGate, requestEditorTransition };
};

type TableEditorActivationContextValue = Readonly<{
  requestActivation: (
    owner: TableEditorOwner,
    activateWhenAvailable: () => void,
  ) => TableEditorActivationRequestOutcome;
  prepareActivationRelease: (owner: TableEditorOwner) => void;
  cancelActivationRelease: (owner: TableEditorOwner) => void;
  cancelActivationRequest: (owner: TableEditorOwner) => void;
  releaseActivation: (owner: TableEditorOwner) => boolean;
  registerRecoveryGate: (
    owner: TableEditorOwner,
    gate: TableEditorRecoveryGate,
  ) => () => void;
  requestRecoveryGate: (adjustmentId: string) => Promise<boolean>;
  pendingRecoveryGateAdjustmentIds: ReadonlySet<string>;
  registerTransitionGate: (
    owner: TableEditorOwner,
    gate: TableEditorTransitionGate,
  ) => () => void;
  requestEditorTransition: () => Promise<boolean>;
}>;

const TableEditorActivationContext = createContext<TableEditorActivationContextValue | null>(null);

type ProviderProps = Readonly<{
  children: ReactNode;
}>;

export const TableEditorActivationProvider = (props: ProviderProps): ReactElement => {
  const activationCoordinator = useMemo(
    (): TableEditorActivationCoordinator => createTableEditorActivationCoordinator(),
    [],
  );
  const recoveryGatesRef = useRef<Map<TableEditorOwner, TableEditorRecoveryGate>>(new Map());
  const recoveryRequestsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const [
    pendingRecoveryGateAdjustmentIds,
    setPendingRecoveryGateAdjustmentIds,
  ] = useState<ReadonlySet<string>>(new Set());

  const registerRecoveryGate = useCallback((
    owner: TableEditorOwner,
    gate: TableEditorRecoveryGate,
  ): (() => void) => {
    recoveryGatesRef.current.set(owner, gate);
    return (): void => {
      if (recoveryGatesRef.current.get(owner) === gate) {
        recoveryGatesRef.current.delete(owner);
      }
    };
  }, []);

  const requestRecoveryGate = useCallback((
    adjustmentId: string,
  ): Promise<boolean> => {
    const activeRequest = recoveryRequestsRef.current.get(adjustmentId);
    if (activeRequest !== undefined) return activeRequest;

    const activeOwner = activationCoordinator.getActiveOwner();
    const activeGate = activeOwner === null
      ? undefined
      : recoveryGatesRef.current.get(activeOwner);
    let recoveryGate = activeGate !== undefined
      && activeGate.ownsAdjustment(adjustmentId)
      ? activeGate
      : null;

    if (recoveryGate === null) {
      for (const [owner, gate] of recoveryGatesRef.current) {
        if (owner === activeOwner || !gate.ownsAdjustment(adjustmentId)) continue;
        recoveryGate = gate;
        break;
      }
    }
    if (recoveryGate === null) return Promise.resolve(false);

    const request = recoveryGate.recoverAdjustment(adjustmentId)
      .then((): boolean => true)
      .finally((): void => {
        if (recoveryRequestsRef.current.get(adjustmentId) !== request) return;
        recoveryRequestsRef.current.delete(adjustmentId);
        setPendingRecoveryGateAdjustmentIds((currentIds): ReadonlySet<string> => {
          const nextIds = new Set(currentIds);
          nextIds.delete(adjustmentId);
          return nextIds;
        });
      });
    recoveryRequestsRef.current.set(adjustmentId, request);
    setPendingRecoveryGateAdjustmentIds((currentIds): ReadonlySet<string> =>
      new Set([...currentIds, adjustmentId]));
    return request;
  }, [activationCoordinator]);

  const transitionCoordinator = useMemo(
    (): TableEditorTransitionCoordinator => (
      createTableEditorTransitionCoordinator({
        begin: activationCoordinator.beginTransition,
        commit: activationCoordinator.commitTransition,
        cancel: activationCoordinator.cancelTransition,
      })
    ),
    [activationCoordinator],
  );

  const value = useMemo<TableEditorActivationContextValue>(
    () => ({
      requestActivation: activationCoordinator.requestActivation,
      prepareActivationRelease: activationCoordinator.prepareActivationRelease,
      cancelActivationRelease: activationCoordinator.cancelActivationRelease,
      cancelActivationRequest: activationCoordinator.cancelActivationRequest,
      releaseActivation: activationCoordinator.releaseActivation,
      registerRecoveryGate,
      requestRecoveryGate,
      pendingRecoveryGateAdjustmentIds,
      registerTransitionGate: transitionCoordinator.registerTransitionGate,
      requestEditorTransition: transitionCoordinator.requestEditorTransition,
    }),
    [
      activationCoordinator,
      pendingRecoveryGateAdjustmentIds,
      registerRecoveryGate,
      requestRecoveryGate,
      transitionCoordinator,
    ],
  );

  return (
    <TableEditorActivationContext value={value}>
      {props.children}
    </TableEditorActivationContext>
  );
};

type TableEditorActivation = Readonly<{
  requestActivation: () => TableEditorActivationRequestOutcome;
  prepareActivationRelease: () => void;
  cancelActivationRelease: () => void;
  cancelActivationRequest: () => void;
  releaseActivation: () => boolean;
  registerRecoveryGate: (gate: TableEditorRecoveryGate) => () => void;
  registerTransitionGate: (gate: TableEditorTransitionGate) => () => void;
}>;

type TableEditorActivationLeaseContext = Readonly<Pick<
  TableEditorActivationContextValue,
  | "requestActivation"
  | "prepareActivationRelease"
  | "cancelActivationRelease"
  | "cancelActivationRequest"
  | "releaseActivation"
  | "registerRecoveryGate"
  | "registerTransitionGate"
>>;

export const createTableEditorActivationLease = (
  registration: TableEditorRegistration,
  owner: TableEditorOwner,
  context: TableEditorActivationLeaseContext,
): TableEditorActivation => {
  const requireLiveLease = (operation: string): void => {
    if (registration.isLive(owner)) return;
    throw new Error(
      `Cannot ${operation} with a stale table editor activation lease "${owner.editorId}"`,
    );
  };
  const requestActivation = (): TableEditorActivationRequestOutcome => {
    if (!registration.isLive(owner)) return "denied";
    const initializeLatestEditor = (): void => {
      try {
        if (registration.initializeLatest(owner)) return;
      } catch (error: unknown) {
        context.releaseActivation(owner);
        throw error;
      }
      context.releaseActivation(owner);
    };
    const outcome = context.requestActivation(owner, initializeLatestEditor);
    if (outcome === "activated") initializeLatestEditor();
    return outcome;
  };
  const prepareActivationRelease = (): void => {
    requireLiveLease("prepare activation release");
    context.prepareActivationRelease(owner);
  };
  const cancelActivationRelease = (): void => {
    if (!registration.isLive(owner)) return;
    context.cancelActivationRelease(owner);
  };
  const cancelActivationRequest = (): void => {
    if (!registration.isLive(owner)) return;
    context.cancelActivationRequest(owner);
  };
  const releaseActivation = (): boolean => (
    registration.isLive(owner) && context.releaseActivation(owner)
  );
  const registerRecoveryGate = (
    gate: TableEditorRecoveryGate,
  ): (() => void) => {
    requireLiveLease("register a recovery gate");
    return context.registerRecoveryGate(
      owner,
      registration.guardRecoveryGate(owner, gate),
    );
  };
  const registerTransitionGate = (
    gate: TableEditorTransitionGate,
  ): (() => void) => {
    requireLiveLease("register a transition gate");
    return context.registerTransitionGate(
      owner,
      registration.guardTransitionGate(owner, gate),
    );
  };

  return {
    requestActivation,
    prepareActivationRelease,
    cancelActivationRelease,
    cancelActivationRequest,
    releaseActivation,
    registerRecoveryGate,
    registerTransitionGate,
  };
};

const createPendingTableEditorActivation = (
  editorId: string,
): TableEditorActivation => {
  const rejectPendingOperation = (operation: string): never => {
    throw new Error(
      `Cannot ${operation} before table editor "${editorId}" has a committed activation lease`,
    );
  };
  return {
    requestActivation: (): TableEditorActivationRequestOutcome => "denied",
    prepareActivationRelease: (): void => {
      rejectPendingOperation("prepare activation release");
    },
    cancelActivationRelease: (): void => {},
    cancelActivationRequest: (): void => {},
    releaseActivation: (): boolean => false,
    registerRecoveryGate: (): (() => void) => (): void => {},
    registerTransitionGate: (): (() => void) => (): void => {},
  };
};

export const useTableEditorActivation = (
  editorId: string,
  initializeEditor: () => boolean,
): TableEditorActivation => {
  const context = useContext(TableEditorActivationContext);
  if (context === null) {
    throw new Error("useTableEditorActivation must be used within TableEditorActivationProvider");
  }

  const registration = useMemo(
    (): TableEditorRegistration => createTableEditorRegistration(editorId),
    [editorId],
  );
  const pendingActivation = useMemo(
    (): TableEditorActivation => createPendingTableEditorActivation(editorId),
    [editorId],
  );
  const [activationLease, setActivationLease] = useState<TableEditorActivation | null>(null);

  useLayoutEffect(() => {
    const owner = registration.mount(initializeEditor);
    const lease = createTableEditorActivationLease(registration, owner, {
      requestActivation: context.requestActivation,
      prepareActivationRelease: context.prepareActivationRelease,
      cancelActivationRelease: context.cancelActivationRelease,
      cancelActivationRequest: context.cancelActivationRequest,
      releaseActivation: context.releaseActivation,
      registerRecoveryGate: context.registerRecoveryGate,
      registerTransitionGate: context.registerTransitionGate,
    });
    setActivationLease(lease);
    return (): void => {
      registration.unmount(owner);
      setActivationLease((currentLease): TableEditorActivation | null => (
        currentLease === lease ? null : currentLease
      ));
      context.cancelActivationRequest(owner);
      context.releaseActivation(owner);
    };
  }, [
    context.cancelActivationRelease,
    context.cancelActivationRequest,
    context.prepareActivationRelease,
    context.registerRecoveryGate,
    context.registerTransitionGate,
    context.releaseActivation,
    context.requestActivation,
    registration,
  ]);
  useLayoutEffect((): void => {
    const owner = registration.getLiveOwner();
    if (owner === null) {
      throw new Error(`Cannot update initializer for unmounted table editor "${editorId}"`);
    }
    registration.updateInitializer(owner, initializeEditor);
  });

  return activationLease ?? pendingActivation;
};

type TableEditorRecovery = Readonly<{
  requestRecoveryGate: (adjustmentId: string) => Promise<boolean>;
  pendingRecoveryGateAdjustmentIds: ReadonlySet<string>;
}>;

export const useTableEditorRecoveryGate = (): TableEditorRecovery => {
  const context = useContext(TableEditorActivationContext);
  if (context === null) {
    throw new Error("useTableEditorRecoveryGate must be used within TableEditorActivationProvider");
  }
  return {
    requestRecoveryGate: context.requestRecoveryGate,
    pendingRecoveryGateAdjustmentIds: context.pendingRecoveryGateAdjustmentIds,
  };
};

type TableEditorTransition = Readonly<{
  requestEditorTransition: () => Promise<boolean>;
}>;

export const useTableEditorTransition = (): TableEditorTransition => {
  const context = useContext(TableEditorActivationContext);
  if (context === null) {
    throw new Error("useTableEditorTransition must be used within TableEditorActivationProvider");
  }
  return { requestEditorTransition: context.requestEditorTransition };
};
