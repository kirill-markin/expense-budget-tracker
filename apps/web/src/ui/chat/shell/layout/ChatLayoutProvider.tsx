"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  areChatTargetsEqual,
  getChatTargetKey,
  type ChatTarget,
} from "../../workspace/chatWorkspaceState";
import {
  useChatWorkspaceController,
  type ChatDraftCreationPlan,
  type ChatDraftSessionAdoption,
  type ChatWorkspaceController,
} from "../../workspace/useChatWorkspaceController";
import {
  getChatActiveDraftStorageKey,
  getChatSelectionStorageKey,
  writeChatActiveDraftId,
  writeChatSelection,
} from "../../workspace/chatSelectionStorage";
import {
  deleteTargetChatComposerMemory,
  isChatDraftUntouched,
  readTargetChatComposerMemory,
  rekeyTargetChatComposerMemory,
  restoreFailedChatSubmissionMemory,
  restoreFailedChatSubmissionText,
  revealUnresolvedChatSubmissionMemory,
  updateTargetChatComposerMemory,
  type ChatComposerMemoryState,
  type ChatPendingSubmission,
} from "../panel/chatPanelRuntime";
import {
  getChatDraftStorageKey,
  readAndMigrateChatDraft,
  writeChatDraft,
  type ChatDraftScope,
} from "./chatDraftStorage";

type ChatLayoutContextValue = Readonly<{
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  chatWidth: number;
  setChatWidth: (width: number) => void;
  chatWorkspace: ChatWorkspaceController;
  chatLayoutScopeToken: ChatLayoutScopeToken;
  isChatLayoutScopeCurrent: (token: ChatLayoutScopeToken) => boolean;
  chatTargetAdoptionTransition: ChatTargetAdoptionTransition | null;
  isSelectedWorkspaceDraftUntouched: boolean;
  chatTargetKey: string;
  chatDraftText: string;
  setChatDraftText: Dispatch<SetStateAction<string>>;
  setChatDraftTextForTarget: (
    target: ChatTarget,
    update: SetStateAction<string>,
  ) => void;
  chatComposerMemory: ChatComposerMemoryState;
  setChatComposerMemoryForTarget: (
    target: ChatTarget,
    update: SetStateAction<ChatComposerMemoryState>,
  ) => void;
  reuseSelectedChatDraft: () => ChatDraftCreationResult;
  replaceSelectedChatTargetWithDraft: () => ChatDraftCreationResult;
  registerChatPendingSubmissionOwnership: (
    target: Extract<ChatTarget, { kind: "draft" }>,
    selectionEpoch: number,
    pendingSubmission: ChatPendingSubmission,
    panelLifecycleToken: ChatPanelLifecycleToken,
  ) => ChatPendingSubmissionOwnership;
  releaseChatPendingSubmissionOwnership: (
    ownership: ChatPendingSubmissionOwnership,
  ) => boolean;
  settleRejectedChatPendingSubmissionOwnership: (
    ownership: ChatPendingSubmissionOwnership,
  ) => boolean;
  settleUnresolvedChatPendingSubmissionOwnership: (
    ownership: ChatPendingSubmissionOwnership,
  ) => boolean;
  settleDetachedChatPendingSubmissionOwnership: (
    ownership: ChatPendingSubmissionOwnership,
  ) => boolean;
  retryDetachedChatPendingSubmissionDisposals: () => void;
  adoptChatPendingSubmissionSession: (
    token: ChatLayoutScopeToken,
    draftId: string,
    sessionId: string,
    expectedSelectionEpoch: number,
  ) => ChatDraftSessionAdoption;
  registerChatTargetOperationOwnership: (
    kind: ChatTargetOperationKind,
    target: ChatTarget,
    selectionEpoch: number,
  ) => ChatTargetOperationOwnership;
  readChatTargetOperationOwnership: (
    ownership: ChatTargetOperationOwnership,
  ) => ChatTargetOperationSnapshot | null;
  releaseChatTargetOperationOwnership: (
    ownership: ChatTargetOperationOwnership,
  ) => boolean;
}>;

const ChatLayoutContext = createContext<ChatLayoutContextValue | null>(null);

const COOKIE_MAX_AGE = "max-age=31536000";

export type ChatLayoutScopeToken = Readonly<{
  tokenId: symbol;
}>;

export type ChatPanelLifecycleToken = Readonly<{
  tokenId: symbol;
}>;

export type ChatTargetOperationKind =
  | "attachment_preparation"
  | "dictation";

export type ChatTargetOperationOwnership = Readonly<{
  ownershipId: symbol;
  scopeToken: ChatLayoutScopeToken;
  kind: ChatTargetOperationKind;
  selectionEpoch: number;
}>;

export type ChatTargetOperationSnapshot = Readonly<{
  target: ChatTarget;
  selectionEpoch: number;
}>;

export type ChatTargetAdoptionTransition = Readonly<{
  transitionId: symbol;
  scopeToken: ChatLayoutScopeToken;
  sourceTarget: Extract<ChatTarget, { kind: "draft" }>;
  destinationTarget: Extract<ChatTarget, { kind: "session" }>;
  selectionEpoch: number;
  stateDisposition: ChatPendingSubmissionAdoptionDisposition;
  originatingPanelLifecycleToken: ChatPanelLifecycleToken;
}>;

type ChatPendingSubmissionOwnership = Readonly<{
  ownershipId: symbol;
  scopeToken: ChatLayoutScopeToken;
  target: Extract<ChatTarget, { kind: "draft" }>;
  selectionEpoch: number;
  pendingSubmission: ChatPendingSubmission;
  panelLifecycleToken: ChatPanelLifecycleToken;
}>;

type ChatPendingSubmissionOwnershipRecord = Readonly<{
  ownership: ChatPendingSubmissionOwnership;
  isDetached: boolean;
  isTerminalDisposalPending: boolean;
}>;

type ChatTargetOperationOwnershipRecord = Readonly<{
  ownership: ChatTargetOperationOwnership;
  target: ChatTarget;
}>;

type ChatPendingSubmissionAdoptionDisposition =
  | "transferred"
  | "destination_preserved";

type ChatPendingSubmissionTargetAdoptionPlan = Readonly<{
  stateDisposition: ChatPendingSubmissionAdoptionDisposition;
  nextDraftTextByTarget: ReadonlyMap<string, string>;
  nextComposerMemoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>;
  storageMutations: ReadonlyArray<ChatStorageMutation>;
}>;

type ChatTargetStateDisposalPlan = Readonly<{
  target: ChatTarget;
  nextDraftTextByTarget: ReadonlyMap<string, string>;
  nextComposerMemoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>;
}>;

export type ChatPendingSubmissionStateSettlementPlan = Readonly<{
  nextText: string;
  nextMemory: ChatComposerMemoryState;
}>;

type ChatPendingSubmissionSettlementSource = Readonly<{
  storageKey: string;
  currentText: string;
  currentMemory: ChatComposerMemoryState;
}>;

type ChatPendingSubmissionSettlementCommit = Readonly<{
  storageMutation: ChatStorageMutation;
  nextDraftTextByTarget: ReadonlyMap<string, string>;
  nextComposerMemoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>;
}>;

type ChatDraftCreationTransitionPlan = Readonly<{
  workspacePlan: ChatDraftCreationPlan;
  ownershipToDetach: ChatPendingSubmissionOwnership | null;
  targetDisposalPlan: ChatTargetStateDisposalPlan | null;
  storageMutations: ReadonlyArray<ChatStorageMutation>;
}>;

export type ChatDraftCreationResult = Readonly<{
  sourceTarget: ChatTarget;
  sourceSelectionEpoch: number;
  target: Extract<ChatTarget, { kind: "draft" }>;
  selectionEpoch: number;
  disposedTarget: ChatTarget | null;
}>;

const COMPATIBILITY_CHAT_COMPOSER_TARGET = {
  kind: "draft",
  draftId: "pre-workspace-controller",
} as const;

export const getMountedChatComposerTarget = (): ChatTarget =>
  COMPATIBILITY_CHAT_COMPOSER_TARGET;

export const readMountedChatDraftText = (
  draftTextByTarget: ReadonlyMap<string, string>,
  draftScope: ChatDraftScope,
): string => {
  const storageKey = getChatDraftStorageKey(
    draftScope,
    getMountedChatComposerTarget(),
  );
  return draftTextByTarget.get(storageKey) ?? "";
};

export const restoreChatDraftTextForTarget = (
  storage: Storage,
  draftTextByTarget: ReadonlyMap<string, string>,
  draftScope: ChatDraftScope,
  target: ChatTarget,
): ReadonlyMap<string, string> => {
  const storageKey = getChatDraftStorageKey(draftScope, target);
  if (draftTextByTarget.has(storageKey)) {
    return draftTextByTarget;
  }

  const nextDraftTextByTarget = new Map(draftTextByTarget);
  nextDraftTextByTarget.set(
    storageKey,
    readAndMigrateChatDraft(
      storage,
      draftScope,
      target,
    ),
  );
  return nextDraftTextByTarget;
};

export const restoreMountedChatDraftText = (
  storage: Storage,
  draftTextByTarget: ReadonlyMap<string, string>,
  draftScope: ChatDraftScope,
): ReadonlyMap<string, string> =>
  restoreChatDraftTextForTarget(
    storage,
    draftTextByTarget,
    draftScope,
    getMountedChatComposerTarget(),
  );

export const resolveSelectedChatDraftUntouched = (
  isWorkspaceReady: boolean,
  selectedTarget: ChatTarget,
  draftTextByTarget: ReadonlyMap<string, string>,
  composerMemoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>,
  draftScope: ChatDraftScope,
): boolean => {
  if (!isWorkspaceReady || selectedTarget.kind !== "draft") {
    return false;
  }
  const storageKey = getChatDraftStorageKey(draftScope, selectedTarget);
  const selectedDraftText = draftTextByTarget.get(storageKey);
  if (selectedDraftText === undefined) {
    return false;
  }
  const selectedComposerMemory = readTargetChatComposerMemory(
    composerMemoryByTarget,
    getChatTargetKey(selectedTarget),
  );

  return isChatDraftUntouched({
    text: selectedDraftText,
    pendingAttachmentCount:
      selectedComposerMemory.pendingAttachments.length,
    attachmentErrorCount: selectedComposerMemory.attachmentErrors.length,
    isAttachmentProcessing: selectedComposerMemory.isAttachmentProcessing,
    hasPendingSubmission: selectedComposerMemory.pendingSubmission !== null,
    messageCount: 0,
  });
};

export const updateChatDraftTextForTarget = (
  storage: Storage,
  draftTextByTarget: ReadonlyMap<string, string>,
  draftScope: ChatDraftScope,
  target: ChatTarget,
  update: SetStateAction<string>,
): ReadonlyMap<string, string> => {
  const storageKey = getChatDraftStorageKey(draftScope, target);
  const currentText = draftTextByTarget.get(storageKey)
    ?? readAndMigrateChatDraft(storage, draftScope, target);
  const nextText = typeof update === "function" ? update(currentText) : update;
  writeChatDraft(storage, draftScope, target, nextText);

  const nextDraftTextByTarget = new Map(draftTextByTarget);
  nextDraftTextByTarget.set(storageKey, nextText);
  return nextDraftTextByTarget;
};

export const planRejectedChatPendingSubmissionSettlement = (
  currentText: string,
  currentMemory: ChatComposerMemoryState,
  pendingSubmission: ChatPendingSubmission,
): ChatPendingSubmissionStateSettlementPlan | null => {
  if (currentMemory.pendingSubmission !== pendingSubmission) {
    return null;
  }
  return {
    nextText: restoreFailedChatSubmissionText(
      currentText,
      pendingSubmission,
      currentMemory.composerContentOwner,
    ),
    nextMemory: restoreFailedChatSubmissionMemory(currentMemory),
  };
};

export const planUnresolvedChatPendingSubmissionSettlement = (
  currentText: string,
  currentMemory: ChatComposerMemoryState,
  pendingSubmission: ChatPendingSubmission,
): ChatPendingSubmissionStateSettlementPlan | null => {
  if (currentMemory.pendingSubmission !== pendingSubmission) {
    return null;
  }
  return {
    nextText: restoreFailedChatSubmissionText(
      currentText,
      pendingSubmission,
      currentMemory.composerContentOwner,
    ),
    nextMemory: revealUnresolvedChatSubmissionMemory(currentMemory),
  };
};

const getChatPendingSubmissionScopeKey = (
  draftScope: ChatDraftScope,
): string =>
  draftScope.mode === "demo"
    ? JSON.stringify([draftScope.mode, draftScope.userId])
    : JSON.stringify([
        draftScope.mode,
        draftScope.userId,
        draftScope.workspaceId,
      ]);

const hasMeaningfulChatComposerMemory = (
  memory: ChatComposerMemoryState | undefined,
): boolean =>
  memory !== undefined
  && (
    memory.pendingAttachments.length > 0
    || memory.attachmentErrors.length > 0
    || memory.isAttachmentProcessing
    || memory.pendingSubmission !== null
  );

const restoreStorageValue = (
  storage: Storage,
  storageKey: string,
  value: string | null,
): void => {
  if (value === null) {
    storage.removeItem(storageKey);
    return;
  }
  storage.setItem(storageKey, value);
};

export type ChatStorageMutation = Readonly<{
  storageKey: string;
  apply: () => void;
}>;

export type ChatStorageTransaction = Readonly<{
  storage: Storage;
  previousValues: ReadonlyArray<Readonly<{
    storageKey: string;
    value: string | null;
  }>>;
}>;

export const rollbackChatStorageTransaction = (
  transaction: ChatStorageTransaction,
): void => {
  let rollbackError: Error | null = null;
  for (
    let index = transaction.previousValues.length - 1;
    index >= 0;
    index -= 1
  ) {
    const previousValue = transaction.previousValues[index];
    if (previousValue === undefined) {
      throw new Error(
        `Chat storage rollback is missing mutation at index ${index}`,
      );
    }
    try {
      restoreStorageValue(
        transaction.storage,
        previousValue.storageKey,
        previousValue.value,
      );
    } catch (error) {
      if (rollbackError === null) {
        rollbackError = error instanceof Error
          ? error
          : new Error(String(error));
      }
    }
  }
  if (rollbackError !== null) {
    throw new Error(
      `Chat storage transaction rollback failed: ${rollbackError.message}`,
    );
  }
};

export const stageChatStorageTransaction = (
  storage: Storage,
  mutations: ReadonlyArray<ChatStorageMutation>,
): ChatStorageTransaction => {
  const storageKeys = new Set<string>();
  for (const mutation of mutations) {
    if (storageKeys.has(mutation.storageKey)) {
      throw new Error(
        `Chat storage transaction contains duplicate key `
        + `"${mutation.storageKey}"`,
      );
    }
    storageKeys.add(mutation.storageKey);
  }
  const transaction: ChatStorageTransaction = {
    storage,
    previousValues: mutations.map((mutation) => ({
      storageKey: mutation.storageKey,
      value: storage.getItem(mutation.storageKey),
    })),
  };

  try {
    for (const mutation of mutations) {
      mutation.apply();
    }
  } catch (error) {
    try {
      rollbackChatStorageTransaction(transaction);
    } catch (rollbackError) {
      const transactionMessage = error instanceof Error
        ? error.message
        : String(error);
      const rollbackMessage = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      throw new Error(
        `Chat storage transaction failed and rollback also failed: `
        + `${transactionMessage}; rollback: ${rollbackMessage}`,
      );
    }
    throw error;
  }
  return transaction;
};

export const stageChatDraftStorageDisposal = (
  storage: Storage,
  draftScope: ChatDraftScope,
  target: ChatTarget,
): ChatStorageTransaction => {
  const storageKey = getChatDraftStorageKey(draftScope, target);
  return stageChatStorageTransaction(storage, [{
    storageKey,
    apply: (): void => {
      writeChatDraft(storage, draftScope, target, "");
    },
  }]);
};

export const createChatPendingSubmissionSettlementStorageMutation = (
  storage: Storage,
  draftScope: ChatDraftScope,
  target: ChatTarget,
  nextText: string,
): ChatStorageMutation => ({
  storageKey: getChatDraftStorageKey(draftScope, target),
  apply: (): void => {
    writeChatDraft(storage, draftScope, target, nextText);
  },
});

export const createChatDraftCreationStorageMutations = (
  storage: Storage,
  draftScope: ChatDraftScope,
  workspacePlan: ChatDraftCreationPlan,
  abandonedTarget: ChatTarget | null,
): ReadonlyArray<ChatStorageMutation> => {
  const mutations: Array<ChatStorageMutation> = [];
  if (workspacePlan.shouldPersistActiveDraft) {
    mutations.push({
      storageKey: getChatActiveDraftStorageKey(draftScope),
      apply: (): void => {
        writeChatActiveDraftId(
          storage,
          draftScope,
          workspacePlan.target.draftId,
        );
      },
    });
  }
  if (workspacePlan.shouldPersistSelection) {
    mutations.push({
      storageKey: getChatSelectionStorageKey(draftScope),
      apply: (): void => {
        writeChatSelection(storage, draftScope, workspacePlan.target);
      },
    });
  }
  if (abandonedTarget !== null) {
    const abandonedStorageKey = getChatDraftStorageKey(
      draftScope,
      abandonedTarget,
    );
    mutations.push({
      storageKey: abandonedStorageKey,
      apply: (): void => {
        writeChatDraft(storage, draftScope, abandonedTarget, "");
      },
    });
  }
  return mutations;
};

const writeCookie = (name: string, value: string): void => {
  document.cookie = `${name}=${value}; path=/; ${COOKIE_MAX_AGE}`;
};

type Props = Readonly<{
  children: ReactNode;
  initialChatOpen: boolean;
  initialChatWidth: number;
  draftScope: ChatDraftScope;
}>;

type ScopedChatLayoutProviderProps = Readonly<{
  children: ReactNode;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  chatWidth: number;
  setChatWidth: (width: number) => void;
  stableDraftScope: ChatDraftScope;
  scopeKey: string;
}>;

const ScopedChatLayoutProvider = (
  props: ScopedChatLayoutProviderProps,
): ReactElement => {
  const {
    children,
    isOpen,
    setIsOpen,
    chatWidth,
    setChatWidth,
    stableDraftScope,
    scopeKey,
  } = props;
  const chatWorkspace = useChatWorkspaceController({ scope: stableDraftScope });
  const selectedWorkspaceTarget = chatWorkspace.state.target;
  const chatTargetKey = getChatTargetKey(selectedWorkspaceTarget);
  const selectedDraftStorageKey = getChatDraftStorageKey(
    stableDraftScope,
    selectedWorkspaceTarget,
  );
  const [draftTextByTarget, setDraftTextByTarget] = useState<
    ReadonlyMap<string, string>
  >(new Map<string, string>());
  const draftTextByTargetRef = useRef(draftTextByTarget);
  const [composerMemoryByTarget, setComposerMemoryByTarget] = useState<
    ReadonlyMap<string, ChatComposerMemoryState>
  >(new Map<string, ChatComposerMemoryState>());
  const composerMemoryByTargetRef = useRef(composerMemoryByTarget);
  const chatLayoutScopeToken = useMemo<ChatLayoutScopeToken>(
    (): ChatLayoutScopeToken => ({
      tokenId: Symbol(scopeKey),
    }),
    [scopeKey],
  );
  const chatLayoutScopeTokenRef = useRef<ChatLayoutScopeToken>(
    chatLayoutScopeToken,
  );
  const pendingSubmissionOwnershipsRef = useRef<
    Map<symbol, ChatPendingSubmissionOwnershipRecord>
  >(new Map<symbol, ChatPendingSubmissionOwnershipRecord>());
  const chatTargetOperationOwnershipsRef = useRef<
    Map<symbol, ChatTargetOperationOwnershipRecord>
  >(new Map<symbol, ChatTargetOperationOwnershipRecord>());
  const [
    chatTargetAdoptionTransition,
    setChatTargetAdoptionTransition,
  ] = useState<ChatTargetAdoptionTransition | null>(null);
  const isProviderMountedRef = useRef<boolean>(true);

  useLayoutEffect(() => {
    isProviderMountedRef.current = true;
    chatLayoutScopeTokenRef.current = chatLayoutScopeToken;
    pendingSubmissionOwnershipsRef.current.clear();
    chatTargetOperationOwnershipsRef.current.clear();
    setChatTargetAdoptionTransition(null);
    return () => {
      isProviderMountedRef.current = false;
      pendingSubmissionOwnershipsRef.current.clear();
      chatTargetOperationOwnershipsRef.current.clear();
    };
  }, [chatLayoutScopeToken]);

  useEffect(() => {
    if (!chatWorkspace.isReady) {
      return;
    }
    const currentDraftTextByTarget = draftTextByTargetRef.current;
    const nextDraftTextByTarget = restoreChatDraftTextForTarget(
      window.sessionStorage,
      currentDraftTextByTarget,
      stableDraftScope,
      selectedWorkspaceTarget,
    );
    if (nextDraftTextByTarget === currentDraftTextByTarget) {
      return;
    }
    draftTextByTargetRef.current = nextDraftTextByTarget;
    setDraftTextByTarget(nextDraftTextByTarget);
  }, [
    chatWorkspace.isReady,
    selectedWorkspaceTarget,
    stableDraftScope,
  ]);

  const setChatDraftTextForTarget = useCallback((
    targetToUpdate: ChatTarget,
    update: SetStateAction<string>,
  ): void => {
    const nextDraftTextByTarget = updateChatDraftTextForTarget(
      window.sessionStorage,
      draftTextByTargetRef.current,
      stableDraftScope,
      targetToUpdate,
      update,
    );
    draftTextByTargetRef.current = nextDraftTextByTarget;
    setDraftTextByTarget(nextDraftTextByTarget);
  }, [stableDraftScope]);

  const setChatDraftText = useCallback((
    update: SetStateAction<string>,
  ): void => {
    setChatDraftTextForTarget(selectedWorkspaceTarget, update);
  }, [selectedWorkspaceTarget, setChatDraftTextForTarget]);

  const setChatComposerMemoryForTarget = useCallback((
    targetToUpdate: ChatTarget,
    update: SetStateAction<ChatComposerMemoryState>,
  ): void => {
    const targetKey = getChatTargetKey(targetToUpdate);
    const nextMemoryByTarget = updateTargetChatComposerMemory(
      composerMemoryByTargetRef.current,
      targetKey,
      update,
    );
    composerMemoryByTargetRef.current = nextMemoryByTarget;
    setComposerMemoryByTarget(nextMemoryByTarget);
  }, []);

  const registerChatTargetOperationOwnership = useCallback((
    kind: ChatTargetOperationKind,
    target: ChatTarget,
    selectionEpoch: number,
  ): ChatTargetOperationOwnership => {
    if (!isProviderMountedRef.current) {
      throw new Error(
        `Cannot register ${kind} ownership after chat provider disposal`,
      );
    }
    const ownership: ChatTargetOperationOwnership = {
      ownershipId: Symbol(`${kind}:${getChatTargetKey(target)}`),
      scopeToken: chatLayoutScopeTokenRef.current,
      kind,
      selectionEpoch,
    };
    chatTargetOperationOwnershipsRef.current.set(ownership.ownershipId, {
      ownership,
      target,
    });
    return ownership;
  }, []);

  const readChatTargetOperationOwnership = useCallback((
    ownership: ChatTargetOperationOwnership,
  ): ChatTargetOperationSnapshot | null => {
    const record =
      chatTargetOperationOwnershipsRef.current.get(ownership.ownershipId);
    if (
      !isProviderMountedRef.current
      || ownership.scopeToken !== chatLayoutScopeTokenRef.current
      || record?.ownership !== ownership
    ) {
      return null;
    }
    return {
      target: record.target,
      selectionEpoch: ownership.selectionEpoch,
    };
  }, []);

  const releaseChatTargetOperationOwnership = useCallback((
    ownership: ChatTargetOperationOwnership,
  ): boolean => {
    if (readChatTargetOperationOwnership(ownership) === null) {
      return false;
    }
    chatTargetOperationOwnershipsRef.current.delete(ownership.ownershipId);
    return true;
  }, [readChatTargetOperationOwnership]);

  const readCurrentPendingSubmissionOwnership = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): ChatPendingSubmissionOwnershipRecord | null => {
    const record =
      pendingSubmissionOwnershipsRef.current.get(ownership.ownershipId);
    if (
      !isProviderMountedRef.current
      || ownership.scopeToken !== chatLayoutScopeTokenRef.current
      || record?.ownership !== ownership
    ) {
      return null;
    }
    return record;
  }, []);

  const isChatLayoutScopeCurrent = useCallback((
    token: ChatLayoutScopeToken,
  ): boolean =>
    isProviderMountedRef.current
    && token === chatLayoutScopeTokenRef.current, []);

  const registerChatPendingSubmissionOwnership = useCallback((
    target: Extract<ChatTarget, { kind: "draft" }>,
    selectionEpoch: number,
    pendingSubmission: ChatPendingSubmission,
    panelLifecycleToken: ChatPanelLifecycleToken,
  ): ChatPendingSubmissionOwnership => {
    if (!isProviderMountedRef.current) {
      throw new Error(
        "Cannot register chat submission ownership after provider disposal",
      );
    }
    for (const record of pendingSubmissionOwnershipsRef.current.values()) {
      const { ownership } = record;
      if (
        ownership.scopeToken === chatLayoutScopeTokenRef.current
        && ownership.selectionEpoch === selectionEpoch
        && areChatTargetsEqual(ownership.target, target)
      ) {
        throw new Error(
          `Chat submission ownership already exists for `
          + `"${getChatTargetKey(target)}" at selection epoch `
          + `${selectionEpoch}`,
        );
      }
    }

    const ownership: ChatPendingSubmissionOwnership = {
      ownershipId: Symbol(getChatTargetKey(target)),
      scopeToken: chatLayoutScopeTokenRef.current,
      target,
      selectionEpoch,
      pendingSubmission,
      panelLifecycleToken,
    };
    pendingSubmissionOwnershipsRef.current.set(
      ownership.ownershipId,
      {
        ownership,
        isDetached: false,
        isTerminalDisposalPending: false,
      },
    );
    return ownership;
  }, []);

  const readChatPendingSubmissionOwnership = useCallback((
    target: Extract<ChatTarget, { kind: "draft" }>,
    selectionEpoch: number,
  ): ChatPendingSubmissionOwnership | null => {
    if (!isProviderMountedRef.current) {
      return null;
    }
    for (const record of pendingSubmissionOwnershipsRef.current.values()) {
      const { ownership } = record;
      if (
        ownership.scopeToken === chatLayoutScopeTokenRef.current
        && ownership.selectionEpoch === selectionEpoch
        && !record.isTerminalDisposalPending
        && areChatTargetsEqual(ownership.target, target)
      ) {
        return ownership;
      }
    }
    return null;
  }, []);

  const releaseChatPendingSubmissionOwnership = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): boolean => {
    const record = readCurrentPendingSubmissionOwnership(ownership);
    if (record === null) {
      return false;
    }
    if (record.isDetached) {
      throw new Error(
        "Detached chat submission ownership requires atomic terminal disposal",
      );
    }
    pendingSubmissionOwnershipsRef.current.delete(ownership.ownershipId);
    return true;
  }, [readCurrentPendingSubmissionOwnership]);

  const readChatPendingSubmissionSettlementSource = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): ChatPendingSubmissionSettlementSource | null => {
    const record = readCurrentPendingSubmissionOwnership(ownership);
    if (
      record === null
      || record.isDetached
      || record.isTerminalDisposalPending
    ) {
      return null;
    }
    const storageKey = getChatDraftStorageKey(
      stableDraftScope,
      ownership.target,
    );
    return {
      storageKey,
      currentText: draftTextByTargetRef.current.get(storageKey)
        ?? window.sessionStorage.getItem(storageKey)
        ?? "",
      currentMemory: readTargetChatComposerMemory(
        composerMemoryByTargetRef.current,
        getChatTargetKey(ownership.target),
      ),
    };
  }, [readCurrentPendingSubmissionOwnership, stableDraftScope]);

  const planChatPendingSubmissionSettlementCommit = useCallback((
    ownership: ChatPendingSubmissionOwnership,
    source: ChatPendingSubmissionSettlementSource,
    settlement: ChatPendingSubmissionStateSettlementPlan,
  ): ChatPendingSubmissionSettlementCommit => {
    const nextDraftTextByTarget = new Map(draftTextByTargetRef.current);
    nextDraftTextByTarget.set(source.storageKey, settlement.nextText);
    const nextComposerMemoryByTarget = updateTargetChatComposerMemory(
      composerMemoryByTargetRef.current,
      getChatTargetKey(ownership.target),
      settlement.nextMemory,
    );
    return {
      storageMutation: createChatPendingSubmissionSettlementStorageMutation(
        window.sessionStorage,
        stableDraftScope,
        ownership.target,
        settlement.nextText,
      ),
      nextDraftTextByTarget,
      nextComposerMemoryByTarget,
    };
  }, [stableDraftScope]);

  const commitChatPendingSubmissionSettlement = useCallback((
    ownership: ChatPendingSubmissionOwnership,
    commit: ChatPendingSubmissionSettlementCommit,
  ): boolean => {
    const record = readCurrentPendingSubmissionOwnership(ownership);
    if (
      record === null
      || record.isDetached
      || record.isTerminalDisposalPending
    ) {
      return false;
    }
    stageChatStorageTransaction(
      window.sessionStorage,
      [commit.storageMutation],
    );
    pendingSubmissionOwnershipsRef.current.delete(ownership.ownershipId);
    draftTextByTargetRef.current = commit.nextDraftTextByTarget;
    composerMemoryByTargetRef.current = commit.nextComposerMemoryByTarget;
    setDraftTextByTarget(commit.nextDraftTextByTarget);
    setComposerMemoryByTarget(commit.nextComposerMemoryByTarget);
    return true;
  }, [readCurrentPendingSubmissionOwnership]);

  const settleRejectedChatPendingSubmissionOwnership = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): boolean => {
    const source = readChatPendingSubmissionSettlementSource(ownership);
    if (source === null) {
      return false;
    }
    const settlement = planRejectedChatPendingSubmissionSettlement(
      source.currentText,
      source.currentMemory,
      ownership.pendingSubmission,
    );
    if (settlement === null) {
      return releaseChatPendingSubmissionOwnership(ownership);
    }
    return commitChatPendingSubmissionSettlement(
      ownership,
      planChatPendingSubmissionSettlementCommit(
        ownership,
        source,
        settlement,
      ),
    );
  }, [
    commitChatPendingSubmissionSettlement,
    planChatPendingSubmissionSettlementCommit,
    readChatPendingSubmissionSettlementSource,
    releaseChatPendingSubmissionOwnership,
  ]);

  const settleUnresolvedChatPendingSubmissionOwnership = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): boolean => {
    const source = readChatPendingSubmissionSettlementSource(ownership);
    if (source === null) {
      return false;
    }
    const settlement = planUnresolvedChatPendingSubmissionSettlement(
      source.currentText,
      source.currentMemory,
      ownership.pendingSubmission,
    );
    if (settlement === null) {
      return releaseChatPendingSubmissionOwnership(ownership);
    }
    return commitChatPendingSubmissionSettlement(
      ownership,
      planChatPendingSubmissionSettlementCommit(
        ownership,
        source,
        settlement,
      ),
    );
  }, [
    commitChatPendingSubmissionSettlement,
    planChatPendingSubmissionSettlementCommit,
    readChatPendingSubmissionSettlementSource,
    releaseChatPendingSubmissionOwnership,
  ]);

  const settleChatPendingSubmissionOwnership = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): boolean => {
    if (!releaseChatPendingSubmissionOwnership(ownership)) {
      return false;
    }
    setChatComposerMemoryForTarget(ownership.target, (currentMemory) =>
      currentMemory.pendingSubmission === ownership.pendingSubmission
        ? {
            ...currentMemory,
            pendingSubmission: null,
          }
        : currentMemory);
    return true;
  }, [
    releaseChatPendingSubmissionOwnership,
    setChatComposerMemoryForTarget,
  ]);

  const planChatPendingSubmissionTargetAdoption = useCallback((
    ownership: ChatPendingSubmissionOwnership,
    destinationTarget: ChatTarget,
  ): ChatPendingSubmissionTargetAdoptionPlan | null => {
    if (readCurrentPendingSubmissionOwnership(ownership) === null) {
      return null;
    }
    const sourceTarget = ownership.target;
    const sourceStorageKey = getChatDraftStorageKey(
      stableDraftScope,
      sourceTarget,
    );
    const destinationStorageKey = getChatDraftStorageKey(
      stableDraftScope,
      destinationTarget,
    );
    const sourceText = draftTextByTargetRef.current.get(sourceStorageKey)
      ?? window.sessionStorage.getItem(sourceStorageKey)
      ?? "";
    const destinationText =
      draftTextByTargetRef.current.get(destinationStorageKey)
      ?? window.sessionStorage.getItem(destinationStorageKey)
      ?? "";
    const sourceTargetKey = getChatTargetKey(sourceTarget);
    const destinationTargetKey = getChatTargetKey(destinationTarget);
    const currentComposerMemoryByTarget = composerMemoryByTargetRef.current;
    if (!currentComposerMemoryByTarget.has(sourceTargetKey)) {
      throw new Error(
        `Cannot adopt chat composer state from "${sourceTargetKey}" to `
        + `"${destinationTargetKey}": source target state does not exist`,
      );
    }
    const destinationMemory =
      currentComposerMemoryByTarget.get(destinationTargetKey);
    const shouldPreserveDestination =
      destinationText !== ""
      || hasMeaningfulChatComposerMemory(destinationMemory);
    const nextComposerMemoryByTarget = shouldPreserveDestination
      ? deleteTargetChatComposerMemory(
          currentComposerMemoryByTarget,
          sourceTargetKey,
        )
      : updateTargetChatComposerMemory(
          rekeyTargetChatComposerMemory(
            destinationMemory === undefined
              ? currentComposerMemoryByTarget
              : deleteTargetChatComposerMemory(
                  currentComposerMemoryByTarget,
                  destinationTargetKey,
                ),
            sourceTargetKey,
            destinationTargetKey,
          ),
          destinationTargetKey,
          (currentMemory) =>
            currentMemory.pendingSubmission === ownership.pendingSubmission
              ? {
                  ...currentMemory,
                  pendingSubmission: null,
                }
              : currentMemory,
        );
    const nextDraftTextByTarget = new Map(draftTextByTargetRef.current);
    nextDraftTextByTarget.delete(sourceStorageKey);
    if (!shouldPreserveDestination) {
      nextDraftTextByTarget.set(destinationStorageKey, sourceText);
    } else if (
      !nextDraftTextByTarget.has(destinationStorageKey)
      && destinationText !== ""
    ) {
      nextDraftTextByTarget.set(destinationStorageKey, destinationText);
    }

    const storageMutations: Array<ChatStorageMutation> = [];
    if (!shouldPreserveDestination) {
      storageMutations.push({
        storageKey: destinationStorageKey,
        apply: (): void => {
          writeChatDraft(
            window.sessionStorage,
            stableDraftScope,
            destinationTarget,
            sourceText,
          );
        },
      });
    }
    storageMutations.push({
      storageKey: sourceStorageKey,
      apply: (): void => {
        writeChatDraft(
          window.sessionStorage,
          stableDraftScope,
          sourceTarget,
          "",
        );
      },
    });
    return {
      stateDisposition: shouldPreserveDestination
        ? "destination_preserved"
        : "transferred",
      nextDraftTextByTarget,
      nextComposerMemoryByTarget,
      storageMutations,
    };
  }, [readCurrentPendingSubmissionOwnership, stableDraftScope]);

  const transitionChatTargetOperationsForAdoption = useCallback((
    sourceTarget: ChatTarget,
    destinationTarget: ChatTarget,
    selectionEpoch: number,
    stateDisposition: ChatPendingSubmissionAdoptionDisposition,
  ): void => {
    for (const [ownershipId, record] of
      chatTargetOperationOwnershipsRef.current.entries()) {
      if (
        record.ownership.scopeToken !== chatLayoutScopeTokenRef.current
        || record.ownership.selectionEpoch !== selectionEpoch
        || !areChatTargetsEqual(record.target, sourceTarget)
      ) {
        continue;
      }
      if (stateDisposition === "destination_preserved") {
        chatTargetOperationOwnershipsRef.current.delete(ownershipId);
        continue;
      }
      chatTargetOperationOwnershipsRef.current.set(ownershipId, {
        ownership: record.ownership,
        target: destinationTarget,
      });
    }
  }, []);

  const invalidateChatTargetOperations = useCallback((
    target: ChatTarget,
  ): void => {
    for (const [ownershipId, record] of
      chatTargetOperationOwnershipsRef.current.entries()) {
      if (
        record.ownership.scopeToken === chatLayoutScopeTokenRef.current
        && areChatTargetsEqual(record.target, target)
      ) {
        chatTargetOperationOwnershipsRef.current.delete(ownershipId);
      }
    }
  }, []);

  const planChatTargetStateDisposal = useCallback((
    target: ChatTarget,
  ): ChatTargetStateDisposalPlan => {
    const storageKey = getChatDraftStorageKey(stableDraftScope, target);
    const nextDraftTextByTarget = new Map(draftTextByTargetRef.current);
    nextDraftTextByTarget.delete(storageKey);
    return {
      target,
      nextDraftTextByTarget,
      nextComposerMemoryByTarget: deleteTargetChatComposerMemory(
        composerMemoryByTargetRef.current,
        getChatTargetKey(target),
      ),
    };
  }, [stableDraftScope]);

  const commitChatTargetStateDisposal = useCallback((
    plan: ChatTargetStateDisposalPlan,
  ): void => {
    invalidateChatTargetOperations(plan.target);
    draftTextByTargetRef.current = plan.nextDraftTextByTarget;
    composerMemoryByTargetRef.current = plan.nextComposerMemoryByTarget;
    setDraftTextByTarget(plan.nextDraftTextByTarget);
    setComposerMemoryByTarget(plan.nextComposerMemoryByTarget);
  }, [invalidateChatTargetOperations]);

  const commitChatDraftCreationTransition = useCallback((
    plan: ChatDraftCreationTransitionPlan,
  ): ChatDraftCreationResult => {
    const ownershipRecord = plan.ownershipToDetach === null
      ? null
      : readCurrentPendingSubmissionOwnership(plan.ownershipToDetach);
    if (
      plan.ownershipToDetach !== null
      && (
        ownershipRecord === null
        || ownershipRecord.isDetached
        || ownershipRecord.isTerminalDisposalPending
      )
    ) {
      throw new Error(
        "Cannot detach stale chat submission ownership during New",
      );
    }
    const storageTransaction = stageChatStorageTransaction(
      window.sessionStorage,
      plan.storageMutations,
    );
    try {
      chatWorkspace.commitDraftCreation(plan.workspacePlan);
    } catch (error) {
      try {
        rollbackChatStorageTransaction(storageTransaction);
      } catch (rollbackError) {
        const commitMessage = error instanceof Error
          ? error.message
          : String(error);
        const rollbackMessage = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        throw new Error(
          `Chat draft creation commit failed and storage rollback also `
          + `failed: ${commitMessage}; rollback: ${rollbackMessage}`,
        );
      }
      throw error;
    }

    if (plan.ownershipToDetach !== null && ownershipRecord !== null) {
      pendingSubmissionOwnershipsRef.current.set(
        plan.ownershipToDetach.ownershipId,
        {
          ownership: plan.ownershipToDetach,
          isDetached: true,
          isTerminalDisposalPending: false,
        },
      );
    }
    if (plan.targetDisposalPlan !== null) {
      commitChatTargetStateDisposal(plan.targetDisposalPlan);
    }
    chatWorkspace.finalizeDraftCreation(plan.workspacePlan);
    return {
      sourceTarget: plan.workspacePlan.sourceTarget,
      sourceSelectionEpoch: plan.workspacePlan.sourceSelectionEpoch,
      target: plan.workspacePlan.target,
      selectionEpoch: plan.workspacePlan.selectionEpoch,
      disposedTarget: plan.targetDisposalPlan?.target ?? null,
    };
  }, [
    chatWorkspace.commitDraftCreation,
    chatWorkspace.finalizeDraftCreation,
    commitChatTargetStateDisposal,
    readCurrentPendingSubmissionOwnership,
  ]);

  const reuseSelectedChatDraft = useCallback((): ChatDraftCreationResult => {
    const workspacePlan = chatWorkspace.planSelectedDraftReuse();
    return commitChatDraftCreationTransition({
      workspacePlan,
      ownershipToDetach: null,
      targetDisposalPlan: null,
      storageMutations: createChatDraftCreationStorageMutations(
        window.sessionStorage,
        stableDraftScope,
        workspacePlan,
        null,
      ),
    });
  }, [
    chatWorkspace.planSelectedDraftReuse,
    commitChatDraftCreationTransition,
    stableDraftScope,
  ]);

  const replaceSelectedChatTargetWithDraft = useCallback(
    (): ChatDraftCreationResult => {
      const workspacePlan = chatWorkspace.planDraftReplacement();
      const matchingOwnershipRecords = Array.from(
        pendingSubmissionOwnershipsRef.current.values(),
      ).filter((record): boolean =>
        record.ownership.scopeToken === chatLayoutScopeTokenRef.current
        && !record.isTerminalDisposalPending
        && areChatTargetsEqual(
          record.ownership.target,
          workspacePlan.sourceTarget,
        ));
      if (matchingOwnershipRecords.length > 1) {
        throw new Error(
          `Multiple chat submission owners exist for `
          + `"${getChatTargetKey(workspacePlan.sourceTarget)}"`,
        );
      }
      const ownershipToDetach =
        matchingOwnershipRecords[0]?.ownership ?? null;
      const targetDisposalPlan =
        workspacePlan.sourceTarget.kind === "draft"
        && ownershipToDetach === null
          ? planChatTargetStateDisposal(workspacePlan.sourceTarget)
          : null;
      return commitChatDraftCreationTransition({
        workspacePlan,
        ownershipToDetach,
        targetDisposalPlan,
        storageMutations: createChatDraftCreationStorageMutations(
          window.sessionStorage,
          stableDraftScope,
          workspacePlan,
          targetDisposalPlan?.target ?? null,
        ),
      });
    },
    [
      chatWorkspace.planDraftReplacement,
      commitChatDraftCreationTransition,
      planChatTargetStateDisposal,
      stableDraftScope,
    ],
  );

  const settleDetachedChatPendingSubmissionOwnership = useCallback((
    ownership: ChatPendingSubmissionOwnership,
  ): boolean => {
    const record = readCurrentPendingSubmissionOwnership(ownership);
    if (record === null || !record.isDetached) {
      return false;
    }
    const disposalPlan = planChatTargetStateDisposal(ownership.target);
    pendingSubmissionOwnershipsRef.current.set(ownership.ownershipId, {
      ...record,
      isTerminalDisposalPending: true,
    });
    stageChatDraftStorageDisposal(
      window.sessionStorage,
      stableDraftScope,
      ownership.target,
    );
    pendingSubmissionOwnershipsRef.current.delete(ownership.ownershipId);
    commitChatTargetStateDisposal(disposalPlan);
    return true;
  }, [
    commitChatTargetStateDisposal,
    planChatTargetStateDisposal,
    readCurrentPendingSubmissionOwnership,
    stableDraftScope,
  ]);

  const retryDetachedChatPendingSubmissionDisposals = useCallback((): void => {
    const ownerships = Array.from(
      pendingSubmissionOwnershipsRef.current.values(),
    )
      .filter((record): boolean =>
        record.isDetached && record.isTerminalDisposalPending)
      .map((record): ChatPendingSubmissionOwnership => record.ownership);
    for (const ownership of ownerships) {
      if (!settleDetachedChatPendingSubmissionOwnership(ownership)) {
        throw new Error(
          "Cannot retry stale detached chat submission disposal",
        );
      }
    }
  }, [settleDetachedChatPendingSubmissionOwnership]);

  const adoptChatPendingSubmissionSession = useCallback((
    token: ChatLayoutScopeToken,
    draftId: string,
    sessionId: string,
    expectedSelectionEpoch: number,
  ): ChatDraftSessionAdoption => {
    const draftTarget = { kind: "draft", draftId } as const;
    const sessionTarget = { kind: "session", sessionId } as const;
    if (
      !isProviderMountedRef.current
      || token !== chatLayoutScopeTokenRef.current
    ) {
      return {
        kind: "background",
        target: sessionTarget,
        draftStateDisposition: "preserve",
      };
    }
    const ownership = readChatPendingSubmissionOwnership(
      draftTarget,
      expectedSelectionEpoch,
    );
    if (ownership === null) {
      return {
        kind: "background",
        target: sessionTarget,
        draftStateDisposition: "preserve",
      };
    }
    const workspacePlan = chatWorkspace.planDraftSessionAdoption(
      draftId,
      sessionId,
      expectedSelectionEpoch,
    );
    if (
      workspacePlan.adoption.kind === "background"
      && workspacePlan.adoption.draftStateDisposition === "preserve"
    ) {
      if (!settleChatPendingSubmissionOwnership(ownership)) {
        return {
          kind: "background",
          target: sessionTarget,
          draftStateDisposition: "preserve",
        };
      }
      chatWorkspace.finalizeDraftSessionAdoption(workspacePlan);
      return workspacePlan.adoption;
    }

    const targetPlan = planChatPendingSubmissionTargetAdoption(
      ownership,
      sessionTarget,
    );
    if (targetPlan === null) {
      return {
        kind: "background",
        target: sessionTarget,
        draftStateDisposition: "preserve",
      };
    }
    const storageMutations: Array<ChatStorageMutation> = [
      ...targetPlan.storageMutations,
    ];
    if (workspacePlan.shouldClearActiveDraft) {
      storageMutations.push({
        storageKey: getChatActiveDraftStorageKey(stableDraftScope),
        apply: (): void => {
          writeChatActiveDraftId(
            window.sessionStorage,
            stableDraftScope,
            null,
          );
        },
      });
    }
    if (workspacePlan.shouldPersistSelection) {
      storageMutations.push({
        storageKey: getChatSelectionStorageKey(stableDraftScope),
        apply: (): void => {
          writeChatSelection(
            window.sessionStorage,
            stableDraftScope,
            sessionTarget,
          );
        },
      });
    }
    const storageTransaction = stageChatStorageTransaction(
      window.sessionStorage,
      storageMutations,
    );
    let workspaceAdoption: ChatDraftSessionAdoption;
    try {
      workspaceAdoption =
        chatWorkspace.commitDraftSessionAdoption(workspacePlan);
    } catch (error) {
      try {
        rollbackChatStorageTransaction(storageTransaction);
      } catch (rollbackError) {
        const commitMessage = error instanceof Error
          ? error.message
          : String(error);
        const rollbackMessage = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        throw new Error(
          `Chat draft adoption commit failed and storage rollback also `
          + `failed: ${commitMessage}; rollback: ${rollbackMessage}`,
        );
      }
      throw error;
    }
    draftTextByTargetRef.current = targetPlan.nextDraftTextByTarget;
    setDraftTextByTarget(targetPlan.nextDraftTextByTarget);
    composerMemoryByTargetRef.current =
      targetPlan.nextComposerMemoryByTarget;
    setComposerMemoryByTarget(targetPlan.nextComposerMemoryByTarget);
    pendingSubmissionOwnershipsRef.current.delete(ownership.ownershipId);
    transitionChatTargetOperationsForAdoption(
      draftTarget,
      sessionTarget,
      expectedSelectionEpoch,
      targetPlan.stateDisposition,
    );
    if (workspaceAdoption.kind === "selected") {
      setChatTargetAdoptionTransition({
        transitionId: Symbol(`${draftId}:${sessionId}`),
        scopeToken: token,
        sourceTarget: draftTarget,
        destinationTarget: sessionTarget,
        selectionEpoch: expectedSelectionEpoch,
        stateDisposition: targetPlan.stateDisposition,
        originatingPanelLifecycleToken: ownership.panelLifecycleToken,
      });
    }
    chatWorkspace.finalizeDraftSessionAdoption(workspacePlan);
    return workspaceAdoption;
  }, [
    chatWorkspace.commitDraftSessionAdoption,
    chatWorkspace.finalizeDraftSessionAdoption,
    chatWorkspace.planDraftSessionAdoption,
    planChatPendingSubmissionTargetAdoption,
    readChatPendingSubmissionOwnership,
    settleChatPendingSubmissionOwnership,
    stableDraftScope,
    transitionChatTargetOperationsForAdoption,
  ]);

  const chatDraftText = draftTextByTarget.get(selectedDraftStorageKey) ?? "";
  const chatComposerMemory = readTargetChatComposerMemory(
    composerMemoryByTarget,
    chatTargetKey,
  );
  const isSelectedWorkspaceDraftUntouched = resolveSelectedChatDraftUntouched(
    chatWorkspace.isReady,
    selectedWorkspaceTarget,
    draftTextByTarget,
    composerMemoryByTarget,
    stableDraftScope,
  );

  return (
    <ChatLayoutContext.Provider value={{
      isOpen,
      setIsOpen,
      chatWidth,
      setChatWidth,
      chatWorkspace,
      chatLayoutScopeToken,
      isChatLayoutScopeCurrent,
      chatTargetAdoptionTransition,
      isSelectedWorkspaceDraftUntouched,
      chatTargetKey,
      chatDraftText,
      setChatDraftText,
      setChatDraftTextForTarget,
      chatComposerMemory,
      setChatComposerMemoryForTarget,
      reuseSelectedChatDraft,
      replaceSelectedChatTargetWithDraft,
      registerChatPendingSubmissionOwnership,
      releaseChatPendingSubmissionOwnership,
      settleRejectedChatPendingSubmissionOwnership,
      settleUnresolvedChatPendingSubmissionOwnership,
      settleDetachedChatPendingSubmissionOwnership,
      retryDetachedChatPendingSubmissionDisposals,
      adoptChatPendingSubmissionSession,
      registerChatTargetOperationOwnership,
      readChatTargetOperationOwnership,
      releaseChatTargetOperationOwnership,
    }}>
      {children}
    </ChatLayoutContext.Provider>
  );
};

export const ChatLayoutProvider = (props: Props): ReactElement => {
  const {
    children,
    initialChatOpen,
    initialChatWidth,
    draftScope,
  } = props;
  const [isOpen, setIsOpenState] = useState<boolean>(initialChatOpen);
  const [chatWidth, setChatWidthState] = useState<number>(initialChatWidth);
  const draftWorkspaceId = draftScope.mode === "workspace"
    ? draftScope.workspaceId
    : null;
  const stableDraftScope = useMemo<ChatDraftScope>(
    (): ChatDraftScope => draftScope.mode === "demo"
      ? {
          mode: "demo",
          userId: draftScope.userId,
        }
      : {
          mode: "workspace",
          userId: draftScope.userId,
          workspaceId: draftScope.workspaceId,
        },
    [draftScope.mode, draftScope.userId, draftWorkspaceId],
  );
  const scopeKey = getChatPendingSubmissionScopeKey(stableDraftScope);
  const setIsOpen = useCallback((open: boolean): void => {
    setIsOpenState(open);
    writeCookie("chat-open", String(open));
  }, []);
  const setChatWidth = useCallback((width: number): void => {
    setChatWidthState(width);
    writeCookie("chat-width", String(Math.round(width)));
  }, []);

  return (
    <ScopedChatLayoutProvider
      key={scopeKey}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      chatWidth={chatWidth}
      setChatWidth={setChatWidth}
      stableDraftScope={stableDraftScope}
      scopeKey={scopeKey}
    >
      {children}
    </ScopedChatLayoutProvider>
  );
};

export const useChatLayout = (): ChatLayoutContextValue => {
  const ctx = useContext(ChatLayoutContext);
  if (ctx === null) {
    throw new Error("useChatLayout must be used within a ChatLayoutProvider");
  }
  return ctx;
};
