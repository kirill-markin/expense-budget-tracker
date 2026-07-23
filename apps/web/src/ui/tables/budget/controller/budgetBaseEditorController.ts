export type BudgetBaseDraftSnapshot = Readonly<{
  revision: number;
  value: number | null;
}>;

export type BudgetBaseAcknowledgement = Readonly<{
  revision: number;
  value: number;
}>;

export type BudgetBaseSettlementOutcome =
  | Readonly<{
    status: "settled";
    acknowledgement: BudgetBaseAcknowledgement;
  }>
  | Readonly<{
    status: "interrupted";
    acknowledgement: BudgetBaseAcknowledgement;
    draft: BudgetBaseDraftSnapshot;
  }>
  | Readonly<{
    status: "invalid";
    draft: BudgetBaseDraftSnapshot;
  }>
  | Readonly<{
    status: "failed";
    acknowledgement: BudgetBaseAcknowledgement;
    draft: BudgetBaseDraftSnapshot;
    error: unknown;
  }>;

export type BudgetBaseCancellationOutcome =
  | Readonly<{
    status: "cancelled";
    acknowledgement: BudgetBaseAcknowledgement;
    draft: BudgetBaseDraftSnapshot;
  }>
  | Readonly<{
    status: "failed";
    acknowledgement: BudgetBaseAcknowledgement;
    draft: BudgetBaseDraftSnapshot;
    error: unknown;
  }>;

type BudgetBasePersistenceOutcome =
  | Readonly<{
    status: "acknowledged" | "unchanged" | "superseded";
    snapshot: BudgetBaseDraftSnapshot;
  }>
  | Readonly<{
    status: "failed";
    snapshot: BudgetBaseDraftSnapshot;
    error: unknown;
  }>;

export type BudgetBaseEditorController = Readonly<{
  getAcknowledgement: () => BudgetBaseAcknowledgement;
  getDraft: () => BudgetBaseDraftSnapshot;
  isDirty: () => boolean;
  isPersistencePending: () => boolean;
  synchronizeAcknowledgement: (value: number) => void;
  updateDraft: (value: number | null) => BudgetBaseDraftSnapshot;
  settleLatest: () => Promise<BudgetBaseSettlementOutcome>;
  cancelDraft: () => Promise<BudgetBaseCancellationOutcome>;
  rollbackToAcknowledgement: () => BudgetBaseDraftSnapshot;
}>;

const assertBaseValue = (value: number, context: string): void => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(
      `${context} must be a finite integer; received ${String(value)}`,
    );
  }
};

const nextRevision = (revision: number): number => {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError(
      `Budget Base draft revision must be a non-negative safe integer; received ${String(revision)}`,
    );
  }
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Cannot create another Budget Base draft revision");
  }
  return revision + 1;
};

export const createBudgetBaseEditorController = (
  initialValue: number,
  persist: (snapshot: BudgetBaseDraftSnapshot) => Promise<void>,
): BudgetBaseEditorController => {
  assertBaseValue(initialValue, "Initial Budget Base value");

  let acknowledgement: BudgetBaseAcknowledgement = {
    revision: 0,
    value: initialValue,
  };
  let draft: BudgetBaseDraftSnapshot = {
    revision: 0,
    value: initialValue,
  };
  let persistenceTail: Promise<void> = Promise.resolve();
  let pendingPersistenceCount = 0;
  let activeSettlement: Promise<BudgetBaseSettlementOutcome> | null = null;
  let interruptActiveSettlement = false;
  const persistenceByRevision =
    new Map<number, Promise<BudgetBasePersistenceOutcome>>();

  const isDirty = (): boolean => (
    draft.value === null || draft.value !== acknowledgement.value
  );

  const executePersistence = async (
    snapshot: BudgetBaseDraftSnapshot,
  ): Promise<BudgetBasePersistenceOutcome> => {
    if (snapshot.revision < draft.revision) {
      return { status: "superseded", snapshot };
    }
    if (snapshot.value === null) {
      throw new Error(
        `Cannot persist invalid Budget Base draft revision ${String(snapshot.revision)}`,
      );
    }
    if (snapshot.value === acknowledgement.value) {
      acknowledgement = {
        revision: snapshot.revision,
        value: snapshot.value,
      };
      return { status: "unchanged", snapshot };
    }

    try {
      await persist(snapshot);
      acknowledgement = {
        revision: snapshot.revision,
        value: snapshot.value,
      };
      return { status: "acknowledged", snapshot };
    } catch (error: unknown) {
      return { status: "failed", snapshot, error };
    }
  };

  const persistSnapshot = (
    snapshot: BudgetBaseDraftSnapshot,
  ): Promise<BudgetBasePersistenceOutcome> => {
    const existing = persistenceByRevision.get(snapshot.revision);
    if (existing !== undefined) return existing;

    const previousTail = persistenceTail;
    pendingPersistenceCount += 1;
    let request: Promise<BudgetBasePersistenceOutcome>;
    request = previousTail
      .then((): Promise<BudgetBasePersistenceOutcome> => (
        executePersistence(snapshot)
      ))
      .finally((): void => {
        pendingPersistenceCount -= 1;
        if (persistenceByRevision.get(snapshot.revision) === request) {
          persistenceByRevision.delete(snapshot.revision);
        }
      });
    persistenceByRevision.set(snapshot.revision, request);
    persistenceTail = request.then((): void => undefined);
    return request;
  };

  const runSettlement = async (): Promise<BudgetBaseSettlementOutcome> => {
    while (true) {
      const snapshot = draft;
      if (snapshot.value === null) {
        return { status: "invalid", draft: snapshot };
      }

      const outcome = await persistSnapshot(snapshot);
      if (interruptActiveSettlement) {
        if (outcome.status === "failed") {
          return {
            status: "failed",
            acknowledgement,
            draft: snapshot,
            error: outcome.error,
          };
        }
        return {
          status: "interrupted",
          acknowledgement,
          draft,
        };
      }
      if (draft.revision !== snapshot.revision) continue;
      if (outcome.status === "failed") {
        return {
          status: "failed",
          acknowledgement,
          draft: snapshot,
          error: outcome.error,
        };
      }
      return { status: "settled", acknowledgement };
    }
  };

  const settleLatest = (): Promise<BudgetBaseSettlementOutcome> => {
    if (activeSettlement !== null) return activeSettlement;

    let request: Promise<BudgetBaseSettlementOutcome>;
    request = runSettlement().finally((): void => {
      if (activeSettlement === request) activeSettlement = null;
    });
    activeSettlement = request;
    return request;
  };

  const rollbackToAcknowledgement = (): BudgetBaseDraftSnapshot => {
    draft = {
      revision: draft.revision,
      value: acknowledgement.value,
    };
    return draft;
  };

  const cancelDraft = async (): Promise<BudgetBaseCancellationOutcome> => {
    const settlement = activeSettlement;
    if (settlement !== null) {
      interruptActiveSettlement = true;
      let outcome: BudgetBaseSettlementOutcome;
      try {
        outcome = await settlement;
      } finally {
        interruptActiveSettlement = false;
      }
      if (outcome.status === "failed") {
        return outcome;
      }
    }

    const cancelledDraft = rollbackToAcknowledgement();
    return {
      status: "cancelled",
      acknowledgement,
      draft: cancelledDraft,
    };
  };

  const synchronizeAcknowledgement = (value: number): void => {
    assertBaseValue(value, "Synchronized Budget Base value");
    if (pendingPersistenceCount > 0 || activeSettlement !== null || isDirty()) {
      throw new Error(
        "Cannot synchronize Budget Base acknowledgement while its editor lifecycle is unresolved",
      );
    }
    acknowledgement = { revision: draft.revision, value };
    draft = { revision: draft.revision, value };
  };

  const updateDraft = (value: number | null): BudgetBaseDraftSnapshot => {
    if (value !== null) assertBaseValue(value, "Budget Base draft value");
    draft = {
      revision: nextRevision(draft.revision),
      value,
    };
    return draft;
  };

  return {
    getAcknowledgement: (): BudgetBaseAcknowledgement => acknowledgement,
    getDraft: (): BudgetBaseDraftSnapshot => draft,
    isDirty,
    isPersistencePending: (): boolean => (
      pendingPersistenceCount > 0 || activeSettlement !== null
    ),
    synchronizeAcknowledgement,
    updateDraft,
    settleLatest,
    cancelDraft,
    rollbackToAcknowledgement,
  };
};
