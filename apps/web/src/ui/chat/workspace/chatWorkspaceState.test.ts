import assert from "node:assert/strict";
import test from "node:test";

import {
  appendChatSessionCatalogPage,
  createChatWorkspaceState,
  failChatSessionCatalogLoad,
  findChatSessionInvalidationIncrements,
  getRunningChatSessionCount,
  getChatTargetKey,
  replaceChatSessionCatalog,
  resolveFailedSessionRecoveryTarget,
  resolveNewChatDraftTarget,
  selectChatWorkspaceTarget,
  startChatSessionCatalogLoad,
} from "./chatWorkspaceState";
import type { ChatSessionSummary } from "./chatSessionSummaryTransport";
import {
  createChatDraftCreationStorageMutations,
  createChatPendingSubmissionSettlementStorageMutation,
  getMountedChatComposerTarget,
  planRejectedChatPendingSubmissionSettlement,
  planUnresolvedChatPendingSubmissionSettlement,
  readMountedChatDraftText,
  rollbackChatStorageTransaction,
  resolveSelectedChatDraftUntouched,
  restoreChatDraftTextForTarget,
  restoreMountedChatDraftText,
  stageChatDraftStorageDisposal,
  stageChatStorageTransaction,
  updateChatDraftTextForTarget,
  type ChatStorageMutation,
} from "../shell/layout/ChatLayoutProvider";
import {
  getChatDraftStorageKey,
  writeChatDraft,
} from "../shell/layout/chatDraftStorage";
import {
  isChatDraftUntouched,
  type ChatComposerMemoryState,
} from "../shell/panel/chatPanelRuntime";
import {
  clearChatSelection,
  getChatActiveDraftStorageKey,
  getChatSelectionStorageKey,
  writeChatSelection,
} from "./chatSelectionStorage";
import {
  resolveChatBootstrapRecovery,
  resolveChatBootstrapSelection,
  resolveChatControllerNavigationObservation,
  resolveChatControllerNavigationWrite,
  resolveChatDraftSessionAdoption,
  resolveChatDraftCreationPlan,
  resolveChatHistoryErrorMessage,
  resolveChatHistoryPaginationFocus,
  resolveChatHistoryStatusVisibility,
  resolveInvalidChatUrlRecovery,
  resolveChatPopStateNavigation,
  resolvePostReadyAutomaticCatalogSelection,
  resolveChatUrlSynchronization,
  promoteSelectedChatWorkspaceTargetToExplicit,
  shouldReuseSelectedChatDraft,
} from "./useChatWorkspaceController";

const createSummary = (
  sessionId: string,
  status: ChatSessionSummary["status"],
  mainContentInvalidationVersion: number,
): ChatSessionSummary => ({
  sessionId,
  title: sessionId,
  lastMessageAt: "2026-07-26T12:00:00.000Z",
  status,
  mainContentInvalidationVersion,
});

const createStorage = (): Storage => {
  const values = new Map<string, string>();

  return {
    get length(): number {
      return values.size;
    },
    clear: (): void => values.clear(),
    getItem: (key: string): string | null => values.get(key) ?? null,
    key: (index: number): string | null => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string): void => {
      values.delete(key);
    },
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
};

const createFailingMutationStorage = (
  baseStorage: Storage,
  failureMutationIndex: number,
): Storage => {
  let mutationIndex = 0;
  const runMutation = (mutation: () => void): void => {
    const currentMutationIndex = mutationIndex;
    mutationIndex += 1;
    if (currentMutationIndex === failureMutationIndex) {
      throw new Error(
        `Synthetic chat storage failure at mutation ${failureMutationIndex}`,
      );
    }
    mutation();
  };

  return {
    get length(): number {
      return baseStorage.length;
    },
    clear: (): void => runMutation(() => baseStorage.clear()),
    getItem: (key: string): string | null => baseStorage.getItem(key),
    key: (index: number): string | null => baseStorage.key(index),
    removeItem: (key: string): void =>
      runMutation(() => baseStorage.removeItem(key)),
    setItem: (key: string, value: string): void =>
      runMutation(() => baseStorage.setItem(key, value)),
  };
};

const createAdoptionStorageMutations = (
  storage: Storage,
  storageKeys: readonly [string, string, string, string],
): ReadonlyArray<ChatStorageMutation> => [
  {
    storageKey: storageKeys[0],
    apply: (): void => storage.setItem(storageKeys[0], "destination"),
  },
  {
    storageKey: storageKeys[1],
    apply: (): void => storage.removeItem(storageKeys[1]),
  },
  {
    storageKey: storageKeys[2],
    apply: (): void => storage.removeItem(storageKeys[2]),
  },
  {
    storageKey: storageKeys[3],
    apply: (): void => storage.setItem(storageKeys[3], "selection"),
  },
];

test("chat adoption storage staging restores every key after each commit-phase failure", (): void => {
  const storageKeys = [
    "destination-draft",
    "source-draft",
    "active-draft",
    "selection",
  ] as const;
  const initialValues = [
    "previous destination",
    "source follow-up",
    "draft-source",
    "previous selection",
  ] as const;

  for (
    let failureMutationIndex = 0;
    failureMutationIndex < storageKeys.length;
    failureMutationIndex += 1
  ) {
    const baseStorage = createStorage();
    storageKeys.forEach((storageKey, index): void => {
      const initialValue = initialValues[index];
      if (initialValue === undefined) {
        throw new Error(`Missing initial storage value at index ${index}`);
      }
      baseStorage.setItem(storageKey, initialValue);
    });
    const failingStorage = createFailingMutationStorage(
      baseStorage,
      failureMutationIndex,
    );

    assert.throws(
      () => stageChatStorageTransaction(
        failingStorage,
        createAdoptionStorageMutations(failingStorage, storageKeys),
      ),
      new RegExp(`mutation ${failureMutationIndex}`, "u"),
    );
    assert.deepEqual(
      storageKeys.map((storageKey): string | null =>
        baseStorage.getItem(storageKey)),
      initialValues,
    );
  }
});

test("chat adoption storage staging can be rolled back after a successful stage", (): void => {
  const storage = createStorage();
  const storageKeys = [
    "destination-draft",
    "source-draft",
    "active-draft",
    "selection",
  ] as const;
  const initialValues = [
    "previous destination",
    "source follow-up",
    "draft-source",
    "previous selection",
  ] as const;
  storageKeys.forEach((storageKey, index): void => {
    const initialValue = initialValues[index];
    if (initialValue === undefined) {
      throw new Error(`Missing initial storage value at index ${index}`);
    }
    storage.setItem(storageKey, initialValue);
  });

  const transaction = stageChatStorageTransaction(
    storage,
    createAdoptionStorageMutations(storage, storageKeys),
  );
  assert.deepEqual(
    storageKeys.map((storageKey): string | null => storage.getItem(storageKey)),
    ["destination", null, null, "selection"],
  );

  rollbackChatStorageTransaction(transaction);
  assert.deepEqual(
    storageKeys.map((storageKey): string | null => storage.getItem(storageKey)),
    initialValues,
  );
});

test("chat draft disposal retains storage on failure and succeeds on retry", (): void => {
  const storage = createStorage();
  const scope = {
    mode: "demo",
    userId: "local",
  } as const;
  const target = {
    kind: "draft",
    draftId: "draft-disposal-retry",
  } as const;
  const storageKey = getChatDraftStorageKey(scope, target);
  writeChatDraft(storage, scope, target, "retained draft");

  assert.throws(
    () => stageChatDraftStorageDisposal(
      createFailingMutationStorage(storage, 0),
      scope,
      target,
    ),
    /Synthetic chat storage failure at mutation 0/u,
  );
  assert.equal(storage.getItem(storageKey), "retained draft");

  stageChatDraftStorageDisposal(storage, scope, target);
  assert.equal(storage.getItem(storageKey), null);
});

test("rejected submission settlement stages restored text before memory can commit", (): void => {
  const scope = { mode: "demo", userId: "local" } as const;
  const target = {
    kind: "draft",
    draftId: "draft-rejected-settlement",
  } as const;
  const pendingSubmission = {
    text: "retry rejected submission",
    attachments: [],
  } as const;
  const currentMemory: ChatComposerMemoryState = {
    pendingAttachments: [],
    attachmentErrors: [],
    isAttachmentProcessing: false,
    pendingSubmission,
    composerContentOwner: "pending_submission",
  };
  const settlement = planRejectedChatPendingSubmissionSettlement(
    "",
    currentMemory,
    pendingSubmission,
  );
  assert.notEqual(settlement, null);
  if (settlement === null) {
    throw new Error("Rejected submission settlement plan is missing");
  }
  const storage = createStorage();
  const storageKey = getChatDraftStorageKey(scope, target);
  const failingStorage = createFailingMutationStorage(storage, 0);

  assert.throws(
    () => stageChatStorageTransaction(failingStorage, [
      createChatPendingSubmissionSettlementStorageMutation(
        failingStorage,
        scope,
        target,
        settlement.nextText,
      ),
    ]),
    /Synthetic chat storage failure at mutation 0/u,
  );
  assert.equal(storage.getItem(storageKey), null);
  assert.equal(currentMemory.pendingSubmission, pendingSubmission);

  stageChatStorageTransaction(storage, [
    createChatPendingSubmissionSettlementStorageMutation(
      storage,
      scope,
      target,
      settlement.nextText,
    ),
  ]);
  assert.equal(storage.getItem(storageKey), pendingSubmission.text);
  assert.equal(settlement.nextMemory.pendingSubmission, null);
});

test("unresolved submission settlement stages restored text before ownership release", (): void => {
  const scope = { mode: "demo", userId: "local" } as const;
  const target = {
    kind: "draft",
    draftId: "draft-unresolved-settlement",
  } as const;
  const pendingSubmission = {
    text: "recover unresolved submission",
    attachments: [],
  } as const;
  const currentMemory: ChatComposerMemoryState = {
    pendingAttachments: [],
    attachmentErrors: [],
    isAttachmentProcessing: false,
    pendingSubmission,
    composerContentOwner: "pending_submission",
  };
  const settlement = planUnresolvedChatPendingSubmissionSettlement(
    "",
    currentMemory,
    pendingSubmission,
  );
  assert.notEqual(settlement, null);
  if (settlement === null) {
    throw new Error("Unresolved submission settlement plan is missing");
  }
  const storage = createStorage();
  const storageKey = getChatDraftStorageKey(scope, target);
  const failingStorage = createFailingMutationStorage(storage, 0);

  assert.throws(
    () => stageChatStorageTransaction(failingStorage, [
      createChatPendingSubmissionSettlementStorageMutation(
        failingStorage,
        scope,
        target,
        settlement.nextText,
      ),
    ]),
    /Synthetic chat storage failure at mutation 0/u,
  );
  assert.equal(storage.getItem(storageKey), null);
  assert.equal(currentMemory.pendingSubmission, pendingSubmission);

  stageChatStorageTransaction(storage, [
    createChatPendingSubmissionSettlementStorageMutation(
      storage,
      scope,
      target,
      settlement.nextText,
    ),
  ]);
  assert.equal(storage.getItem(storageKey), pendingSubmission.text);
  assert.equal(
    settlement.nextMemory.pendingSubmission,
    pendingSubmission,
  );
});

test("explicit history selection storage staging retains the prior selection on failure", (): void => {
  const storage = createStorage();
  const scope = {
    mode: "workspace",
    userId: "user-history-failure",
    workspaceId: "workspace-history-failure",
  } as const;
  const previousTarget = {
    kind: "session",
    sessionId: "session-history-previous",
  } as const;
  const nextTarget = {
    kind: "session",
    sessionId: "session-history-next",
  } as const;
  const selectionStorageKey = getChatSelectionStorageKey(scope);
  writeChatSelection(storage, scope, previousTarget);
  const previousSelection = storage.getItem(selectionStorageKey);

  const failingStorage = createFailingMutationStorage(storage, 0);
  assert.throws(
    () => writeChatSelection(failingStorage, scope, nextTarget),
    /Synthetic chat storage failure at mutation 0/u,
  );
  assert.equal(storage.getItem(selectionStorageKey), previousSelection);
});

test("New stages active draft, selection, and abandoned text as one transaction", (): void => {
  const scope = {
    mode: "demo",
    userId: "local",
  } as const;
  const sourceTarget = {
    kind: "draft",
    draftId: "draft-new-transaction-source",
  } as const;
  const nextTarget = {
    kind: "draft",
    draftId: "draft-new-transaction-next",
  } as const;
  const workspacePlan = resolveChatDraftCreationPlan({
    kind: "replace_selected_target",
    currentState: createChatWorkspaceState(sourceTarget, "explicit"),
    currentSelectionEpoch: 14,
    currentActiveDraftId: sourceTarget.draftId,
    nextDraftId: nextTarget.draftId,
  });
  const activeDraftStorageKey = getChatActiveDraftStorageKey(scope);
  const selectionStorageKey = getChatSelectionStorageKey(scope);
  const sourceDraftStorageKey = getChatDraftStorageKey(scope, sourceTarget);
  const initialValues = [
    sourceTarget.draftId,
    JSON.stringify({
      ...sourceTarget,
      selectionReason: "explicit",
    }),
    "unsent source text",
  ] as const;

  for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
    const storage = createStorage();
    storage.setItem(activeDraftStorageKey, initialValues[0]);
    storage.setItem(selectionStorageKey, initialValues[1]);
    storage.setItem(sourceDraftStorageKey, initialValues[2]);
    const failingStorage = createFailingMutationStorage(storage, failureIndex);

    assert.throws(
      () => stageChatStorageTransaction(
        failingStorage,
        createChatDraftCreationStorageMutations(
          failingStorage,
          scope,
          workspacePlan,
          sourceTarget,
        ),
      ),
      new RegExp(`mutation ${failureIndex}`, "u"),
    );
    assert.deepEqual(
      [
        storage.getItem(activeDraftStorageKey),
        storage.getItem(selectionStorageKey),
        storage.getItem(sourceDraftStorageKey),
      ],
      initialValues,
    );
  }

  const storage = createStorage();
  storage.setItem(activeDraftStorageKey, initialValues[0]);
  storage.setItem(selectionStorageKey, initialValues[1]);
  storage.setItem(sourceDraftStorageKey, initialValues[2]);
  stageChatStorageTransaction(
    storage,
    createChatDraftCreationStorageMutations(
      storage,
      scope,
      workspacePlan,
      sourceTarget,
    ),
  );
  assert.equal(storage.getItem(activeDraftStorageKey), nextTarget.draftId);
  assert.equal(
    storage.getItem(selectionStorageKey),
    JSON.stringify({
      ...nextTarget,
      selectionReason: "explicit",
    }),
  );
  assert.equal(storage.getItem(sourceDraftStorageKey), null);
});

test("chat workspace state keeps an explicit target and selection reason", (): void => {
  const draftState = createChatWorkspaceState(
    { kind: "draft", draftId: "draft-1" },
    "automatic",
  );
  const sessionState = selectChatWorkspaceTarget(
    draftState,
    { kind: "session", sessionId: "session-1" },
    "explicit",
  );

  assert.deepEqual(draftState.target, { kind: "draft", draftId: "draft-1" });
  assert.deepEqual(sessionState.target, {
    kind: "session",
    sessionId: "session-1",
  });
  assert.equal(sessionState.selectionReason, "explicit");
});

test("meaningful activity promotes only the selection reason at the exact epoch", (): void => {
  const selectionEpoch = 12;
  const automaticState = createChatWorkspaceState(
    { kind: "session", sessionId: "session-automatic" },
    "automatic",
  );
  const explicitState = promoteSelectedChatWorkspaceTargetToExplicit(
    automaticState,
    automaticState.target,
  );

  assert.equal(explicitState.selectionReason, "explicit");
  assert.equal(explicitState.target, automaticState.target);
  assert.equal(selectionEpoch, 12);
  assert.equal(
    resolvePostReadyAutomaticCatalogSelection({
      requestStartedReady: true,
      requestSelectionEpoch: selectionEpoch,
      requestSelectionReason: "automatic",
      currentSelectionEpoch: selectionEpoch,
      currentSelectionReason: explicitState.selectionReason,
      currentTarget: explicitState.target,
      summaries: [createSummary("session-new", "running", 0)],
      unavailableSessionIds: new Set<string>(),
      currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
      draftId: "draft-active",
    }),
    null,
  );
  assert.throws(
    () => promoteSelectedChatWorkspaceTargetToExplicit(
      explicitState,
      { kind: "session", sessionId: "session-other" },
    ),
    /Cannot promote unselected chat target/u,
  );
});

test("draft adoption uses one authoritative target and epoch snapshot", (): void => {
  assert.deepEqual(
    resolveChatDraftSessionAdoption({
      currentTarget: { kind: "draft", draftId: "draft-a" },
      currentSelectionEpoch: 4,
      draftId: "draft-a",
      sessionId: "session-a",
      expectedSelectionEpoch: 4,
    }),
    {
      kind: "selected",
      target: { kind: "session", sessionId: "session-a" },
      selectionEpoch: 4,
    },
  );
  assert.deepEqual(
    resolveChatDraftSessionAdoption({
      currentTarget: { kind: "session", sessionId: "session-b" },
      currentSelectionEpoch: 5,
      draftId: "draft-a",
      sessionId: "session-a",
      expectedSelectionEpoch: 4,
    }),
    {
      kind: "background",
      target: { kind: "session", sessionId: "session-a" },
      draftStateDisposition: "transfer",
    },
  );
  assert.deepEqual(
    resolveChatDraftSessionAdoption({
      currentTarget: { kind: "draft", draftId: "draft-a" },
      currentSelectionEpoch: 6,
      draftId: "draft-a",
      sessionId: "session-a",
      expectedSelectionEpoch: 4,
    }),
    {
      kind: "background",
      target: { kind: "session", sessionId: "session-a" },
      draftStateDisposition: "preserve",
    },
  );
});

test("catalog page state preserves ordering, pagination, and known summaries on failure", (): void => {
  const initialState = startChatSessionCatalogLoad(
    createChatWorkspaceState(
      { kind: "draft", draftId: "draft-1" },
      "automatic",
    ),
  );
  const firstPageState = replaceChatSessionCatalog(initialState, {
    sessions: [
      createSummary("session-1", "idle", 0),
      createSummary("session-2", "running", 2),
    ],
    nextCursor: "cursor-1",
  });
  const nextPageState = appendChatSessionCatalogPage(firstPageState, {
    sessions: [
      createSummary("session-2", "idle", 3),
      createSummary("session-3", "interrupted", 0),
    ],
    nextCursor: null,
  });
  const failedState = failChatSessionCatalogLoad(
    startChatSessionCatalogLoad(nextPageState),
    "Chat session catalog request failed: status=503",
  );

  assert.deepEqual(
    failedState.summaries.map((summary) => summary.sessionId),
    ["session-1", "session-2", "session-3"],
  );
  assert.equal(failedState.summaries[1]?.status, "idle");
  assert.deepEqual(failedState.pagination, {
    hasLoadedFirstPage: true,
    nextCursor: null,
  });
  assert.deepEqual(failedState.catalogRequest, {
    isLoading: false,
    errorMessage: "Chat session catalog request failed: status=503",
  });
});

test("failed next-page loads retain the cursor and retry appends without duplicates", (): void => {
  const firstPageState = replaceChatSessionCatalog(
    createChatWorkspaceState(
      { kind: "draft", draftId: "draft-1" },
      "automatic",
    ),
    {
      sessions: [
        createSummary("session-1", "idle", 0),
        createSummary("session-2", "running", 1),
      ],
      nextCursor: "cursor-1",
    },
  );
  const failedState = failChatSessionCatalogLoad(
    startChatSessionCatalogLoad(firstPageState),
    "Chat session catalog request failed: status=503",
  );
  const retriedState = appendChatSessionCatalogPage(failedState, {
    sessions: [
      createSummary("session-2", "idle", 2),
      createSummary("session-3", "interrupted", 0),
    ],
    nextCursor: null,
  });

  assert.deepEqual(
    failedState.summaries.map((summary) => summary.sessionId),
    ["session-1", "session-2"],
  );
  assert.equal(failedState.pagination.nextCursor, "cursor-1");
  assert.deepEqual(
    retriedState.summaries.map((summary) => summary.sessionId),
    ["session-1", "session-2", "session-3"],
  );
  assert.equal(retriedState.summaries[1]?.status, "idle");
  assert.equal(retriedState.catalogRequest.errorMessage, null);
});

test("running count is derived across all catalog summaries", (): void => {
  assert.equal(
    getRunningChatSessionCount([
      createSummary("session-1", "running", 0),
      createSummary("session-2", "idle", 0),
      createSummary("session-3", "running", 0),
      createSummary("session-4", "interrupted", 0),
    ]),
    2,
  );
});

test("invalidation comparison detects increments for selected and unselected sessions", (): void => {
  const selectedState = replaceChatSessionCatalog(
    createChatWorkspaceState(
      { kind: "session", sessionId: "session-selected" },
      "explicit",
    ),
    {
      sessions: [
        createSummary("session-selected", "running", 2),
        createSummary("session-background", "running", 4),
      ],
      nextCursor: null,
    },
  );

  const increments = findChatSessionInvalidationIncrements(
    selectedState.mainContentInvalidationVersions,
    [
      createSummary("session-selected", "running", 3),
      createSummary("session-background", "running", 6),
      createSummary("session-new", "idle", 5),
    ],
  );

  assert.deepEqual(increments, [
    {
      sessionId: "session-selected",
      previousVersion: 2,
      nextVersion: 3,
    },
    {
      sessionId: "session-background",
      previousVersion: 4,
      nextVersion: 6,
    },
  ]);
});

test("first catalog observation establishes invalidation baselines without increments", (): void => {
  const increments = findChatSessionInvalidationIncrements(
    new Map<string, number>(),
    [createSummary("session-1", "idle", 8)],
  );

  assert.deepEqual(increments, []);
});

test("repeated New reuses one untouched local draft", (): void => {
  const currentDraft = { kind: "draft", draftId: "draft-1" } as const;

  assert.deepEqual(
    resolveNewChatDraftTarget(
      currentDraft,
      "draft-1",
      true,
      "draft-unused",
    ),
    currentDraft,
  );
});

test("New revisits an existing tab draft from a selected session", (): void => {
  assert.deepEqual(
    resolveNewChatDraftTarget(
      { kind: "session", sessionId: "session-1" },
      "draft-1",
      false,
      "draft-unused",
    ),
    { kind: "draft", draftId: "draft-1" },
  );
});

test("failed URL session recovery excludes the failed row and selects a safe catalog target", (): void => {
  assert.deepEqual(
    resolveFailedSessionRecoveryTarget(
      [
        createSummary("session-failed", "running", 0),
        createSummary("session-safe", "running", 0),
      ],
      new Set(["session-failed"]),
      Date.parse("2026-07-26T13:00:00.000Z"),
      "draft-safe",
    ),
    { kind: "session", sessionId: "session-safe" },
  );
});

test("failed URL session recovery falls back to a local draft when no safe session remains", (): void => {
  assert.deepEqual(
    resolveFailedSessionRecoveryTarget(
      [createSummary("session-failed", "running", 0)],
      new Set(["session-failed"]),
      Date.parse("2026-07-26T13:00:00.000Z"),
      "draft-safe",
    ),
    { kind: "draft", draftId: "draft-safe" },
  );
});

test("failed session recovery never alternates between multiple stale rows", (): void => {
  const staleSummaries = [
    createSummary("session-a", "running", 0),
    createSummary("session-b", "running", 0),
  ];
  const afterFirstFailure = resolveFailedSessionRecoveryTarget(
    staleSummaries,
    new Set(["session-a"]),
    Date.parse("2026-07-26T13:00:00.000Z"),
    "draft-safe",
  );
  const afterSecondFailure = resolveFailedSessionRecoveryTarget(
    staleSummaries,
    new Set(["session-a", "session-b"]),
    Date.parse("2026-07-26T13:00:00.000Z"),
    "draft-safe",
  );

  assert.deepEqual(afterFirstFailure, {
    kind: "session",
    sessionId: "session-b",
  });
  assert.deepEqual(afterSecondFailure, {
    kind: "draft",
    draftId: "draft-safe",
  });
});

test("workspace selection does not retarget the mounted compatibility composer", (): void => {
  const draftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  } as const;
  const selectedState = selectChatWorkspaceTarget(
    createChatWorkspaceState(
      { kind: "draft", draftId: "draft-workspace" },
      "automatic",
    ),
    { kind: "session", sessionId: "session-selected" },
    "explicit",
  );
  const mountedComposerTarget = getMountedChatComposerTarget();
  const draftTextByTarget = new Map<string, string>([
    [
      getChatDraftStorageKey(draftScope, mountedComposerTarget),
      "Mounted controller draft",
    ],
    [
      getChatDraftStorageKey(draftScope, selectedState.target),
      "Selected workspace target draft",
    ],
  ]);

  assert.deepEqual(selectedState.target, {
    kind: "session",
    sessionId: "session-selected",
  });
  assert.deepEqual(mountedComposerTarget, {
    kind: "draft",
    draftId: "pre-workspace-controller",
  });
  assert.notEqual(
    getChatTargetKey(selectedState.target),
    getChatTargetKey(mountedComposerTarget),
  );
  assert.equal(
    readMountedChatDraftText(draftTextByTarget, draftScope),
    "Mounted controller draft",
  );
});

test("mounted compatibility draft restores before catalog readiness and keeps the first edit", (): void => {
  const storage = createStorage();
  const draftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  } as const;
  const mountedComposerTarget = getMountedChatComposerTarget();
  writeChatDraft(
    storage,
    draftScope,
    mountedComposerTarget,
    "Saved compatibility draft",
  );

  const restoredDraftTextByTarget = restoreMountedChatDraftText(
    storage,
    new Map<string, string>(),
    draftScope,
  );
  assert.equal(
    readMountedChatDraftText(restoredDraftTextByTarget, draftScope),
    "Saved compatibility draft",
  );

  const editedDraftTextByTarget = updateChatDraftTextForTarget(
    storage,
    restoredDraftTextByTarget,
    draftScope,
    mountedComposerTarget,
    "Saved compatibility draft plus first edit",
  );
  assert.equal(
    readMountedChatDraftText(editedDraftTextByTarget, draftScope),
    "Saved compatibility draft plus first edit",
  );
  assert.equal(
    storage.getItem(getChatDraftStorageKey(draftScope, mountedComposerTarget)),
    "Saved compatibility draft plus first edit",
  );
});

test("selected workspace draft reuse uses only restored target-aware state", (): void => {
  const storage = createStorage();
  const draftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  } as const;
  const selectedDraft = {
    kind: "draft",
    draftId: "draft-selected",
  } as const;
  const compatibilityTranscriptMessageCount = 2;
  const restoredEmptyDrafts = restoreChatDraftTextForTarget(
    storage,
    new Map<string, string>(),
    draftScope,
    selectedDraft,
  );

  assert.equal(compatibilityTranscriptMessageCount > 0, true);
  assert.equal(
    resolveSelectedChatDraftUntouched(
      true,
      selectedDraft,
      restoredEmptyDrafts,
      new Map(),
      draftScope,
    ),
    true,
  );

  writeChatDraft(storage, draftScope, selectedDraft, "Persisted draft text");
  const restoredTextDrafts = restoreChatDraftTextForTarget(
    storage,
    new Map<string, string>(),
    draftScope,
    selectedDraft,
  );
  assert.equal(
    resolveSelectedChatDraftUntouched(
      true,
      selectedDraft,
      restoredTextDrafts,
      new Map(),
      draftScope,
    ),
    false,
  );
  assert.equal(
    resolveSelectedChatDraftUntouched(
      true,
      selectedDraft,
      new Map(),
      new Map(),
      draftScope,
    ),
    false,
  );
  assert.equal(
    resolveSelectedChatDraftUntouched(
      false,
      selectedDraft,
      restoredEmptyDrafts,
      new Map(),
      draftScope,
    ),
    false,
  );
  assert.equal(
    resolveSelectedChatDraftUntouched(
      true,
      { kind: "session", sessionId: "session-selected" },
      restoredEmptyDrafts,
      new Map(),
      draftScope,
    ),
    false,
  );

  const pendingComposerMemory = new Map([
    [
      getChatTargetKey(selectedDraft),
      {
        pendingAttachments: [],
        attachmentErrors: [],
        isAttachmentProcessing: false,
        pendingSubmission: {
          text: "Pending submission",
          attachments: [],
        },
        composerContentOwner: "pending_submission" as const,
      },
    ],
  ]);
  assert.equal(
    resolveSelectedChatDraftUntouched(
      true,
      selectedDraft,
      restoredEmptyDrafts,
      pendingComposerMemory,
      draftScope,
    ),
    false,
  );
});

test("deferred bootstrap preserves the exact draft selected by New", (): void => {
  const initializingTarget = { kind: "draft", draftId: "initializing" } as const;
  const selectedDraft = resolveNewChatDraftTarget(
    initializingTarget,
    null,
    shouldReuseSelectedChatDraft(false, initializingTarget, true),
    "draft-selected-during-bootstrap",
  );

  assert.deepEqual(selectedDraft, {
    kind: "draft",
    draftId: "draft-selected-during-bootstrap",
  });
  assert.deepEqual(
    resolveChatBootstrapSelection({
      bootstrapSelectionEpoch: 0,
      currentSelectionEpoch: 1,
      currentTarget: selectedDraft,
      currentSelectionReason: "explicit",
      urlTarget: { kind: "session", sessionId: "session-stale-url" },
      storedTarget: { kind: "session", sessionId: "session-stale-storage" },
      automaticTarget: { kind: "session", sessionId: "session-stale-automatic" },
    }),
    {
      target: selectedDraft,
      selectionReason: "explicit",
      selectionChangedDuringBootstrap: true,
    },
  );
});

test("bootstrap selection keeps URL then stored then automatic precedence", (): void => {
  const commonInput = {
    bootstrapSelectionEpoch: 0,
    currentSelectionEpoch: 0,
    currentTarget: { kind: "draft", draftId: "draft-initializing" },
    currentSelectionReason: "automatic",
    automaticTarget: { kind: "draft", draftId: "draft-automatic" },
  } as const;

  assert.deepEqual(
    resolveChatBootstrapSelection({
      ...commonInput,
      urlTarget: { kind: "session", sessionId: "session-url" },
      storedTarget: { kind: "session", sessionId: "session-stored" },
    }),
    {
      target: { kind: "session", sessionId: "session-url" },
      selectionReason: "explicit",
      selectionChangedDuringBootstrap: false,
    },
  );
  assert.deepEqual(
    resolveChatBootstrapSelection({
      ...commonInput,
      urlTarget: null,
      storedTarget: { kind: "session", sessionId: "session-stored" },
    }).target,
    { kind: "session", sessionId: "session-stored" },
  );
  assert.deepEqual(
    resolveChatBootstrapSelection({
      ...commonInput,
      urlTarget: null,
      storedTarget: null,
    }).target,
    { kind: "draft", draftId: "draft-automatic" },
  );
});

test("bootstrap recovery follows the highest-precedence source", (): void => {
  const automaticDraft = {
    target: { kind: "draft", draftId: "draft-automatic" },
    selectionReason: "automatic",
    selectionChangedDuringBootstrap: false,
  } as const;
  const automaticSession = {
    target: { kind: "session", sessionId: "session-automatic" },
    selectionReason: "automatic",
    selectionChangedDuringBootstrap: false,
  } as const;
  const validUrlSelection = {
    target: { kind: "session", sessionId: "session-url" },
    selectionReason: "explicit",
    selectionChangedDuringBootstrap: false,
  } as const;
  const newerSelection = {
    target: { kind: "draft", draftId: "draft-newer" },
    selectionReason: "explicit",
    selectionChangedDuringBootstrap: true,
  } as const;
  const cases = [
    {
      name: "valid URL suppresses an invalid stored selection",
      input: {
        selection: validUrlSelection,
        hasUrlSessionParameter: true,
        urlSelectionFailed: false,
        storedTarget: null,
        storedSelectionFailed: true,
        activeDraftFailed: false,
      },
      expected: {
        showRecoveryNotice: false,
        shouldReplaceUrl: false,
      },
    },
    {
      name: "valid URL suppresses an invalid active draft",
      input: {
        selection: validUrlSelection,
        hasUrlSessionParameter: true,
        urlSelectionFailed: false,
        storedTarget: null,
        storedSelectionFailed: false,
        activeDraftFailed: true,
      },
      expected: {
        showRecoveryNotice: false,
        shouldReplaceUrl: false,
      },
    },
    {
      name: "invalid URL fallback reports recovery and replaces the URL",
      input: {
        selection: automaticDraft,
        hasUrlSessionParameter: true,
        urlSelectionFailed: true,
        storedTarget: null,
        storedSelectionFailed: false,
        activeDraftFailed: false,
      },
      expected: {
        showRecoveryNotice: true,
        shouldReplaceUrl: true,
      },
    },
    {
      name: "invalid winning stored selection reports recovery without replacing the URL",
      input: {
        selection: automaticSession,
        hasUrlSessionParameter: false,
        urlSelectionFailed: false,
        storedTarget: null,
        storedSelectionFailed: true,
        activeDraftFailed: false,
      },
      expected: {
        showRecoveryNotice: true,
        shouldReplaceUrl: false,
      },
    },
    {
      name: "invalid winning active draft reports recovery",
      input: {
        selection: automaticDraft,
        hasUrlSessionParameter: false,
        urlSelectionFailed: false,
        storedTarget: null,
        storedSelectionFailed: false,
        activeDraftFailed: true,
      },
      expected: {
        showRecoveryNotice: true,
        shouldReplaceUrl: false,
      },
    },
    {
      name: "invalid unused active draft stays silent",
      input: {
        selection: automaticSession,
        hasUrlSessionParameter: false,
        urlSelectionFailed: false,
        storedTarget: null,
        storedSelectionFailed: false,
        activeDraftFailed: true,
      },
      expected: {
        showRecoveryNotice: false,
        shouldReplaceUrl: false,
      },
    },
    {
      name: "newer selection suppresses stale bootstrap recovery",
      input: {
        selection: newerSelection,
        hasUrlSessionParameter: true,
        urlSelectionFailed: true,
        storedTarget: null,
        storedSelectionFailed: true,
        activeDraftFailed: true,
      },
      expected: {
        showRecoveryNotice: false,
        shouldReplaceUrl: false,
      },
    },
  ] as const;

  for (const testCase of cases) {
    assert.deepEqual(
      resolveChatBootstrapRecovery(testCase.input),
      testCase.expected,
      testCase.name,
    );
  }
});

test("recovery and visibility refreshes reconcile only their current automatic selection", (): void => {
  const automaticDraft = {
    kind: "draft",
    draftId: "draft-automatic",
  } as const;
  const recentSession = createSummary("session-recent", "idle", 0);
  const runningSession = createSummary("session-running", "running", 0);
  const newerSession = {
    ...createSummary("session-newer", "idle", 0),
    lastMessageAt: "2026-07-26T12:30:00.000Z",
  };
  const cases = [
    {
      name: "successful refresh after an initial failure selects a recent session",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 1,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 1,
        currentSelectionReason: "automatic",
        currentTarget: automaticDraft,
        summaries: [recentSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
        draftId: automaticDraft.draftId,
      },
      expected: { kind: "session", sessionId: "session-recent" },
    },
    {
      name: "a running session remains eligible regardless of age",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 2,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 2,
        currentSelectionReason: "automatic",
        currentTarget: automaticDraft,
        summaries: [runningSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-27T13:00:00.000Z"),
        draftId: automaticDraft.draftId,
      },
      expected: { kind: "session", sessionId: "session-running" },
    },
    {
      name: "visibility refresh keeps the selected running session when another row is newer",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 2,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 2,
        currentSelectionReason: "automatic",
        currentTarget: {
          kind: "session",
          sessionId: runningSession.sessionId,
        },
        summaries: [newerSession, runningSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-27T13:00:00.000Z"),
        draftId: automaticDraft.draftId,
      },
      expected: null,
    },
    {
      name: "visibility refresh keeps the selected recent session when another row is newer",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 2,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 2,
        currentSelectionReason: "automatic",
        currentTarget: {
          kind: "session",
          sessionId: recentSession.sessionId,
        },
        summaries: [newerSession, recentSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
        draftId: automaticDraft.draftId,
      },
      expected: null,
    },
    {
      name: "an explicit draft selected during recovery fences the automatic response",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 3,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 4,
        currentSelectionReason: "explicit",
        currentTarget: { kind: "draft", draftId: "draft-new" },
        summaries: [recentSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
        draftId: "draft-new",
      },
      expected: null,
    },
    {
      name: "an explicit session during the request fences the automatic response",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 5,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 6,
        currentSelectionReason: "explicit",
        currentTarget: { kind: "session", sessionId: "session-explicit" },
        summaries: [recentSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
        draftId: automaticDraft.draftId,
      },
      expected: null,
    },
    {
      name: "an automatic idle session crossing six hours returns to its draft",
      input: {
        requestStartedReady: true,
        requestSelectionEpoch: 7,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 7,
        currentSelectionReason: "automatic",
        currentTarget: { kind: "session", sessionId: "session-recent" },
        summaries: [recentSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-26T18:00:00.001Z"),
        draftId: automaticDraft.draftId,
      },
      expected: automaticDraft,
    },
    {
      name: "the initial bootstrap response cannot bypass source precedence",
      input: {
        requestStartedReady: false,
        requestSelectionEpoch: 0,
        requestSelectionReason: "automatic",
        currentSelectionEpoch: 0,
        currentSelectionReason: "automatic",
        currentTarget: { kind: "draft", draftId: "initializing" },
        summaries: [recentSession],
        unavailableSessionIds: new Set<string>(),
        currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
        draftId: automaticDraft.draftId,
      },
      expected: null,
    },
  ] as const;

  for (const testCase of cases) {
    assert.deepEqual(
      resolvePostReadyAutomaticCatalogSelection(testCase.input),
      testCase.expected,
      testCase.name,
    );
  }
});

test("post-recovery refresh excludes unavailable sessions until recovery makes them eligible", (): void => {
  const failedSession = createSummary("session-failed", "running", 0);
  const availableSession = createSummary("session-available", "idle", 0);
  const commonInput = {
    requestStartedReady: true,
    requestSelectionEpoch: 4,
    requestSelectionReason: "automatic",
    currentSelectionEpoch: 4,
    currentSelectionReason: "automatic",
    currentTarget: { kind: "draft", draftId: "draft-safe" },
    currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
    draftId: "draft-safe",
  } as const;

  assert.deepEqual(
    resolvePostReadyAutomaticCatalogSelection({
      ...commonInput,
      summaries: [failedSession, availableSession],
      unavailableSessionIds: new Set(["session-failed"]),
    }),
    { kind: "session", sessionId: "session-available" },
  );
  assert.equal(
    resolvePostReadyAutomaticCatalogSelection({
      ...commonInput,
      summaries: [failedSession],
      unavailableSessionIds: new Set(["session-failed"]),
    }),
    null,
  );
  assert.deepEqual(
    resolvePostReadyAutomaticCatalogSelection({
      ...commonInput,
      summaries: [failedSession, availableSession],
      unavailableSessionIds: new Set<string>(),
    }),
    { kind: "session", sessionId: "session-failed" },
  );
});

test("New reuses an untouched automatic draft as an explicit selection and fences a deferred refresh", (): void => {
  const requestSelectionEpoch = 8;
  const automaticState = createChatWorkspaceState(
    { kind: "draft", draftId: "draft-reused" },
    "automatic",
  );
  const reusePlan = resolveChatDraftCreationPlan({
    kind: "reuse_selected_draft",
    currentState: automaticState,
    currentSelectionEpoch: requestSelectionEpoch,
    currentActiveDraftId: "draft-reused",
  });
  const reusedTarget = reusePlan.target;
  const explicitState = selectChatWorkspaceTarget(
    automaticState,
    reusedTarget,
    "explicit",
  );
  const explicitSelectionEpoch = reusePlan.selectionEpoch;

  assert.equal(reusePlan.kind, "transition");
  assert.deepEqual(reusedTarget, {
    kind: "draft",
    draftId: "draft-reused",
  });
  assert.equal(reusePlan.shouldPersistActiveDraft, true);
  assert.equal(reusePlan.shouldPersistSelection, true);
  assert.deepEqual(explicitState.target, reusedTarget);
  assert.equal(explicitState.selectionReason, "explicit");
  assert.equal(explicitSelectionEpoch, 9);
  assert.equal(
    resolvePostReadyAutomaticCatalogSelection({
      requestStartedReady: true,
      requestSelectionEpoch,
      requestSelectionReason: "automatic",
      currentSelectionEpoch: explicitSelectionEpoch,
      currentSelectionReason: explicitState.selectionReason,
      currentTarget: explicitState.target,
      summaries: [createSummary("session-running", "running", 0)],
      unavailableSessionIds: new Set<string>(),
      currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
      draftId: reusedTarget.draftId,
    }),
    null,
  );
});

test("malformed runtime URL recovery preserves valid stored targets and clears only malformed storage", (): void => {
  const scope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  } as const;
  const summaries = [createSummary("session-automatic", "running", 0)];
  const currentTimeMs = Date.parse("2026-07-26T13:00:00.000Z");

  for (const storedTarget of [
    { kind: "session", sessionId: "session-stored" },
    { kind: "draft", draftId: "draft-stored" },
  ] as const) {
    const storage = createStorage();
    writeChatSelection(storage, scope, storedTarget);
    assert.deepEqual(
      resolveInvalidChatUrlRecovery(
        storage,
        scope,
        summaries,
        currentTimeMs,
        "draft-automatic",
      ),
      {
        target: storedTarget,
        selectionReason: "explicit",
        shouldClearStoredSelection: false,
      },
    );
    assert.notEqual(
      storage.getItem(getChatSelectionStorageKey(scope)),
      null,
    );
  }

  const malformedStorage = createStorage();
  malformedStorage.setItem(getChatSelectionStorageKey(scope), "{");
  const malformedDecision = resolveInvalidChatUrlRecovery(
    malformedStorage,
    scope,
    summaries,
    currentTimeMs,
    "draft-automatic",
  );
  if (malformedDecision.shouldClearStoredSelection) {
    clearChatSelection(malformedStorage, scope);
  }
  assert.deepEqual(malformedDecision, {
    target: { kind: "session", sessionId: "session-automatic" },
    selectionReason: "automatic",
    shouldClearStoredSelection: true,
  });
  assert.equal(
    malformedStorage.getItem(getChatSelectionStorageKey(scope)),
    null,
  );

  const emptyStorage = createStorage();
  assert.deepEqual(
    resolveInvalidChatUrlRecovery(
      emptyStorage,
      scope,
      summaries,
      currentTimeMs,
      "draft-automatic",
    ),
    {
      target: { kind: "session", sessionId: "session-automatic" },
      selectionReason: "automatic",
      shouldClearStoredSelection: false,
    },
  );
});

test("New reuses only a completely untouched mounted draft", (): void => {
  const untouchedInput = {
    text: "",
    pendingAttachmentCount: 0,
    attachmentErrorCount: 0,
    isAttachmentProcessing: false,
    hasPendingSubmission: false,
    messageCount: 0,
  } as const;
  const currentDraft = { kind: "draft", draftId: "draft-current" } as const;
  const explicitReusePlan = resolveChatDraftCreationPlan({
    kind: "reuse_selected_draft",
    currentState: createChatWorkspaceState(currentDraft, "explicit"),
    currentSelectionEpoch: 21,
    currentActiveDraftId: currentDraft.draftId,
  });

  assert.equal(isChatDraftUntouched(untouchedInput), true);
  assert.equal(explicitReusePlan.kind, "reuse");
  assert.equal(explicitReusePlan.selectionEpoch, 21);
  assert.equal(explicitReusePlan.shouldPersistActiveDraft, false);
  assert.equal(explicitReusePlan.shouldPersistSelection, false);
  assert.equal(
    shouldReuseSelectedChatDraft(true, currentDraft, true),
    true,
  );
  assert.deepEqual(
    resolveNewChatDraftTarget(
      currentDraft,
      currentDraft.draftId,
      isChatDraftUntouched(untouchedInput),
      "draft-unused",
    ),
    currentDraft,
  );
  for (const touchedInput of [
    { ...untouchedInput, text: "draft" },
    { ...untouchedInput, pendingAttachmentCount: 1 },
    { ...untouchedInput, attachmentErrorCount: 1 },
    { ...untouchedInput, isAttachmentProcessing: true },
    { ...untouchedInput, hasPendingSubmission: true },
    { ...untouchedInput, messageCount: 1 },
  ]) {
    assert.equal(isChatDraftUntouched(touchedInput), false);
  }
});

test("same-path external URL queries select sessions while controller writes do not feed back", (): void => {
  const input = {
    previousPathname: "/chat",
    pathname: "/chat",
    urlTarget: { kind: "session", sessionId: "session-b" },
    currentTarget: { kind: "session", sessionId: "session-a" },
    currentSelectionReason: "explicit",
    activeDraftTarget: { kind: "draft", draftId: "draft-active" },
  } as const;

  assert.deepEqual(
    resolveChatUrlSynchronization({
      ...input,
      controllerNavigationMatches: false,
    }),
    {
      kind: "select",
      target: { kind: "session", sessionId: "session-b" },
    },
  );
  assert.deepEqual(
    resolveChatUrlSynchronization({
      ...input,
      controllerNavigationMatches: true,
    }),
    { kind: "none" },
  );
});

test("same-target URL navigation promotes automatic selection and fences a stale refresh", (): void => {
  const automaticTarget = {
    kind: "session",
    sessionId: "session-current",
  } as const;
  const urlDecision = resolveChatUrlSynchronization({
    previousPathname: "/chat",
    pathname: "/chat",
    controllerNavigationMatches: false,
    urlTarget: automaticTarget,
    currentTarget: automaticTarget,
    currentSelectionReason: "automatic",
    activeDraftTarget: { kind: "draft", draftId: "draft-active" },
  });

  assert.deepEqual(urlDecision, {
    kind: "select",
    target: automaticTarget,
  });
  const requestSelectionEpoch = 2;
  const explicitSelectionEpoch = requestSelectionEpoch + 1;
  const explicitState = selectChatWorkspaceTarget(
    createChatWorkspaceState(automaticTarget, "automatic"),
    automaticTarget,
    "explicit",
  );
  assert.equal(explicitState.selectionReason, "explicit");
  assert.equal(
    resolvePostReadyAutomaticCatalogSelection({
      requestStartedReady: true,
      requestSelectionEpoch,
      requestSelectionReason: "automatic",
      currentSelectionEpoch: explicitSelectionEpoch,
      currentSelectionReason: explicitState.selectionReason,
      currentTarget: explicitState.target,
      summaries: [createSummary("session-new", "running", 0)],
      unavailableSessionIds: new Set<string>(),
      currentTimeMs: Date.parse("2026-07-26T13:00:00.000Z"),
      draftId: "draft-active",
    }),
    null,
  );
  assert.deepEqual(
    resolveChatUrlSynchronization({
      previousPathname: "/chat",
      pathname: "/chat",
      controllerNavigationMatches: false,
      urlTarget: automaticTarget,
      currentTarget: explicitState.target,
      currentSelectionReason: explicitState.selectionReason,
      activeDraftTarget: { kind: "draft", draftId: "draft-active" },
    }),
    { kind: "none" },
  );
});

test("same-visible URL supersession uses replace and retires canceled ownership", (): void => {
  const pendingPush = {
    generation: 6,
    url: "/chat?session=session-b",
    outstandingOrigins: [],
  } as const;
  const writeDecision = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat",
    "push",
    pendingPush.generation,
    pendingPush,
  );

  assert.equal(writeDecision.kind, "navigate");
  if (writeDecision.kind !== "navigate") {
    throw new Error("Conflicting navigation must be superseded");
  }
  assert.equal(writeDecision.navigationMode, "replace");
  assert.equal(writeDecision.generation, 7);
  assert.equal(writeDecision.controllerNavigation, null);
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      writeDecision.controllerNavigation,
      7,
      "/chat",
    ),
    { kind: "external" },
  );
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      writeDecision.controllerNavigation,
      7,
      "/chat?session=session-b",
    ),
    { kind: "external" },
  );
  assert.deepEqual(
    resolveChatControllerNavigationWrite(
      "/chat",
      "/chat",
      "replace",
      7,
      null,
    ),
    {
      kind: "none",
      controllerNavigation: null,
    },
  );
});

test("an older URL observed before the newest target settles is restored and retired", (): void => {
  const navigationToB = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-b",
    "push",
    20,
    null,
  );
  assert.equal(navigationToB.kind, "navigate");
  if (navigationToB.kind !== "navigate") {
    throw new Error("B navigation must be created");
  }
  if (navigationToB.controllerNavigation === null) {
    throw new Error("B navigation must remain pending");
  }
  const navigationToC = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-c",
    "push",
    navigationToB.generation,
    navigationToB.controllerNavigation,
  );
  assert.equal(navigationToC.kind, "navigate");
  if (navigationToC.kind !== "navigate") {
    throw new Error("C navigation must supersede B");
  }
  if (navigationToC.controllerNavigation === null) {
    throw new Error("C navigation must remain pending");
  }
  assert.deepEqual(
    navigationToC.controllerNavigation.outstandingOrigins,
    [{
      generation: navigationToB.generation,
      url: "/chat?session=session-b",
    }],
  );

  const staleB = resolveChatControllerNavigationObservation(
    navigationToC.controllerNavigation,
    navigationToC.generation,
    "/chat?session=session-b",
  );
  assert.equal(staleB.kind, "restore");
  if (staleB.kind !== "restore") {
    throw new Error("Stale B must restore the pending C URL");
  }
  assert.equal(staleB.url, "/chat?session=session-c");
  assert.deepEqual(staleB.controllerNavigation.outstandingOrigins, []);
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      staleB.controllerNavigation,
      staleB.controllerNavigation.generation,
      "/chat?session=session-c",
    ),
    { kind: "settle" },
  );
});

test("newest target settlement clears canceled origins and later old URLs are external", (): void => {
  const navigationToB = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-b",
    "push",
    30,
    null,
  );
  assert.equal(navigationToB.kind, "navigate");
  if (navigationToB.kind !== "navigate") {
    throw new Error("B navigation must be created");
  }
  if (navigationToB.controllerNavigation === null) {
    throw new Error("B navigation must remain pending");
  }
  const navigationToC = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-c",
    "push",
    navigationToB.generation,
    navigationToB.controllerNavigation,
  );
  assert.equal(navigationToC.kind, "navigate");
  if (navigationToC.kind !== "navigate") {
    throw new Error("C navigation must supersede B");
  }
  if (navigationToC.controllerNavigation === null) {
    throw new Error("C navigation must remain pending");
  }
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      navigationToC.controllerNavigation,
      navigationToC.generation,
      "/chat?session=session-c",
    ),
    { kind: "settle" },
  );
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      null,
      navigationToC.generation,
      "/chat?session=session-b",
    ),
    { kind: "external" },
  );
  assert.deepEqual(
    resolveChatUrlSynchronization({
      previousPathname: "/chat",
      pathname: "/chat",
      controllerNavigationMatches: false,
      urlTarget: { kind: "session", sessionId: "session-b" },
      currentTarget: { kind: "session", sessionId: "session-c" },
      currentSelectionReason: "explicit",
      activeDraftTarget: { kind: "draft", draftId: "draft-a" },
    }),
    {
      kind: "select",
      target: { kind: "session", sessionId: "session-b" },
    },
  );
});

test("repeated B target retires C before settlement or cancels it when B settles", (): void => {
  const firstB = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-b",
    "push",
    40,
    null,
  );
  assert.equal(firstB.kind, "navigate");
  if (firstB.kind !== "navigate") {
    throw new Error("First B navigation must be created");
  }
  if (firstB.controllerNavigation === null) {
    throw new Error("First B navigation must remain pending");
  }
  const navigationToC = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-c",
    "push",
    firstB.generation,
    firstB.controllerNavigation,
  );
  assert.equal(navigationToC.kind, "navigate");
  if (navigationToC.kind !== "navigate") {
    throw new Error("C navigation must supersede the first B");
  }
  if (navigationToC.controllerNavigation === null) {
    throw new Error("C navigation must remain pending");
  }
  const newestB = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat?session=session-b",
    "push",
    navigationToC.generation,
    navigationToC.controllerNavigation,
  );
  assert.equal(newestB.kind, "navigate");
  if (newestB.kind !== "navigate") {
    throw new Error("Newest B navigation must supersede C");
  }
  if (newestB.controllerNavigation === null) {
    throw new Error("Newest B navigation must remain pending");
  }
  assert.deepEqual(
    newestB.controllerNavigation.outstandingOrigins,
    [{
      generation: navigationToC.generation,
      url: "/chat?session=session-c",
    }],
  );

  const staleCBeforeB = resolveChatControllerNavigationObservation(
    newestB.controllerNavigation,
    newestB.generation,
    "/chat?session=session-c",
  );
  assert.equal(staleCBeforeB.kind, "restore");
  if (staleCBeforeB.kind !== "restore") {
    throw new Error("C completion must restore newest B");
  }
  assert.deepEqual(staleCBeforeB.controllerNavigation.outstandingOrigins, []);
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      staleCBeforeB.controllerNavigation,
      staleCBeforeB.controllerNavigation.generation,
      "/chat?session=session-b",
    ),
    { kind: "settle" },
  );
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      null,
      newestB.generation,
      "/chat?session=session-c",
    ),
    { kind: "external" },
  );
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      newestB.controllerNavigation,
      newestB.generation,
      "/chat?session=session-b",
    ),
    { kind: "settle" },
  );
});

test("popstate retires canceled controller origins and accepts their URL exactly once", (): void => {
  const pendingPush = {
    generation: 10,
    url: "/chat?session=session-b",
    outstandingOrigins: [],
  } as const;
  const supersedingWrite = resolveChatControllerNavigationWrite(
    "/chat",
    "/chat",
    "replace",
    pendingPush.generation,
    pendingPush,
  );
  assert.equal(supersedingWrite.kind, "navigate");
  if (supersedingWrite.kind !== "navigate") {
    throw new Error("Same-URL selection must supersede the pending push");
  }
  assert.equal(supersedingWrite.generation, 11);
  assert.equal(supersedingWrite.controllerNavigation, null);

  const retirement = resolveChatPopStateNavigation(
    "/chat",
    supersedingWrite.generation,
  );
  assert.deepEqual(retirement, {
    generation: 12,
    controllerNavigation: null,
    targetNavigationMode: "none",
  });
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      retirement.controllerNavigation,
      retirement.generation,
      "/chat?session=session-b",
    ),
    { kind: "external" },
  );

  const poppedTarget = {
    kind: "session",
    sessionId: "session-b",
  } as const;
  const poppedState = selectChatWorkspaceTarget(
    createChatWorkspaceState(
      { kind: "draft", draftId: "draft-a" },
      "explicit",
    ),
    poppedTarget,
    "explicit",
  );
  assert.deepEqual(poppedState.target, poppedTarget);
  assert.deepEqual(
    resolveChatUrlSynchronization({
      previousPathname: "/chat",
      pathname: "/chat",
      controllerNavigationMatches: false,
      urlTarget: poppedTarget,
      currentTarget: poppedState.target,
      currentSelectionReason: poppedState.selectionReason,
      activeDraftTarget: { kind: "draft", draftId: "draft-a" },
    }),
    { kind: "none" },
  );
});

test("non-chat popstate retires pending chat ownership without replacement navigation", (): void => {
  const pendingChatNavigation = {
    generation: 50,
    url: "/chat?session=session-b",
    outstandingOrigins: [{
      generation: 49,
      url: "/chat?session=session-a",
    }],
  } as const;
  const popStateNavigation = resolveChatPopStateNavigation(
    "/balances",
    pendingChatNavigation.generation,
  );

  assert.deepEqual(popStateNavigation, {
    generation: 51,
    controllerNavigation: null,
    targetNavigationMode: null,
  });
  assert.deepEqual(
    resolveChatControllerNavigationObservation(
      popStateNavigation.controllerNavigation,
      popStateNavigation.generation,
      pendingChatNavigation.url,
    ),
    { kind: "external" },
  );
  assert.deepEqual(
    resolveChatUrlSynchronization({
      previousPathname: "/chat",
      pathname: "/balances",
      controllerNavigationMatches: false,
      urlTarget: { kind: "session", sessionId: "session-b" },
      currentTarget: { kind: "session", sessionId: "session-a" },
      currentSelectionReason: "explicit",
      activeDraftTarget: { kind: "draft", draftId: "draft-a" },
    }),
    { kind: "none" },
  );
});

test("same-path URL removal selects the active draft and chat entry restores an explicit session URL", (): void => {
  const commonInput = {
    pathname: "/chat",
    controllerNavigationMatches: false,
    urlTarget: null,
    currentTarget: { kind: "session", sessionId: "session-a" },
    currentSelectionReason: "explicit",
    activeDraftTarget: { kind: "draft", draftId: "draft-active" },
  } as const;

  assert.deepEqual(
    resolveChatUrlSynchronization({
      ...commonInput,
      previousPathname: "/chat",
    }),
    {
      kind: "select",
      target: { kind: "draft", draftId: "draft-active" },
    },
  );
  assert.deepEqual(
    resolveChatUrlSynchronization({
      ...commonInput,
      previousPathname: "/balances",
    }),
    {
      kind: "navigate",
      target: { kind: "session", sessionId: "session-a" },
    },
  );
});

test("recovery notices remain visible until catalog success or failure settles them", (): void => {
  assert.equal(
    resolveChatHistoryErrorMessage(
      null,
      "This chat is unavailable. A safe chat was selected.",
    ),
    "This chat is unavailable. A safe chat was selected.",
  );
  assert.equal(
    resolveChatHistoryErrorMessage(
      "Chat session catalog request failed: status=503",
      "This chat is unavailable. A safe chat was selected.",
    ),
    "Chat session catalog request failed: status=503",
  );
  assert.equal(resolveChatHistoryErrorMessage(null, null), null);
});

test("history shows loading instead of empty until the first page settles", (): void => {
  assert.deepEqual(
    resolveChatHistoryStatusVisibility(0, true, false, null),
    {
      showEmpty: false,
      showLoading: true,
    },
  );
  assert.deepEqual(
    resolveChatHistoryStatusVisibility(0, false, true, null),
    {
      showEmpty: true,
      showLoading: false,
    },
  );
  assert.deepEqual(
    resolveChatHistoryStatusVisibility(0, false, false, null),
    {
      showEmpty: false,
      showLoading: false,
    },
  );
});

test("history pagination focus stays with Load more or moves to New on the final page", (): void => {
  assert.equal(
    resolveChatHistoryPaginationFocus(true, true),
    "load_more",
  );
  assert.equal(
    resolveChatHistoryPaginationFocus(true, false),
    "create_draft",
  );
  assert.equal(
    resolveChatHistoryPaginationFocus(false, false),
    "none",
  );
});
