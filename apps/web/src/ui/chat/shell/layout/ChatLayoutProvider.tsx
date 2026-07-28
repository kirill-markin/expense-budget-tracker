"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  getChatTargetKey,
  type ChatTarget,
} from "../../workspace/chatWorkspaceState";
import {
  useChatWorkspaceController,
  type ChatWorkspaceController,
} from "../../workspace/useChatWorkspaceController";
import {
  deleteTargetChatComposerMemory,
  isChatDraftUntouched,
  readTargetChatComposerMemory,
  rekeyTargetChatComposerMemory,
  updateTargetChatComposerMemory,
  type ChatComposerMemoryState,
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
  adoptChatTargetState: (
    sourceTarget: ChatTarget,
    destinationTarget: ChatTarget,
  ) => void;
  disposeChatTargetState: (target: ChatTarget) => void;
}>;

const ChatLayoutContext = createContext<ChatLayoutContextValue | null>(null);

const COOKIE_MAX_AGE = "max-age=31536000";

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

const writeCookie = (name: string, value: string): void => {
  document.cookie = `${name}=${value}; path=/; ${COOKIE_MAX_AGE}`;
};

type Props = Readonly<{
  children: ReactNode;
  initialChatOpen: boolean;
  initialChatWidth: number;
  draftScope: ChatDraftScope;
}>;

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
  const chatWorkspace = useChatWorkspaceController({ scope: stableDraftScope });
  const mountedChatComposerTarget = getMountedChatComposerTarget();
  const chatTargetKey = getChatTargetKey(mountedChatComposerTarget);
  const [draftTextByTarget, setDraftTextByTarget] = useState<
    ReadonlyMap<string, string>
  >(new Map<string, string>());
  const draftTextByTargetRef = useRef(draftTextByTarget);
  const [composerMemoryByTarget, setComposerMemoryByTarget] = useState<
    ReadonlyMap<string, ChatComposerMemoryState>
  >(new Map<string, ChatComposerMemoryState>());
  const composerMemoryByTargetRef = useRef(composerMemoryByTarget);

  useEffect(() => {
    const restoredDraftTextByTarget = restoreMountedChatDraftText(
      window.sessionStorage,
      new Map<string, string>(),
      stableDraftScope,
    );
    draftTextByTargetRef.current = restoredDraftTextByTarget;
    setDraftTextByTarget(restoredDraftTextByTarget);
    const emptyComposerMemoryByTarget =
      new Map<string, ChatComposerMemoryState>();
    composerMemoryByTargetRef.current = emptyComposerMemoryByTarget;
    setComposerMemoryByTarget(emptyComposerMemoryByTarget);
  }, [stableDraftScope]);

  const selectedWorkspaceTarget = chatWorkspace.state.target;
  useEffect(() => {
    if (!chatWorkspace.isReady || selectedWorkspaceTarget.kind !== "draft") {
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

  const setIsOpen = (open: boolean): void => {
    setIsOpenState(open);
    writeCookie("chat-open", String(open));
  };

  const setChatWidth = (width: number): void => {
    setChatWidthState(width);
    writeCookie("chat-width", String(Math.round(width)));
  };

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
    setChatDraftTextForTarget(mountedChatComposerTarget, update);
  }, [mountedChatComposerTarget, setChatDraftTextForTarget]);

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

  const adoptChatTargetState = useCallback((
    sourceTarget: ChatTarget,
    destinationTarget: ChatTarget,
  ): void => {
    const sourceStorageKey = getChatDraftStorageKey(
      stableDraftScope,
      sourceTarget,
    );
    const destinationStorageKey = getChatDraftStorageKey(
      stableDraftScope,
      destinationTarget,
    );
    const sourceText = draftTextByTargetRef.current.get(sourceStorageKey)
      ?? readAndMigrateChatDraft(
        window.sessionStorage,
        stableDraftScope,
        sourceTarget,
      );
    writeChatDraft(
      window.sessionStorage,
      stableDraftScope,
      destinationTarget,
      sourceText,
    );
    writeChatDraft(
      window.sessionStorage,
      stableDraftScope,
      sourceTarget,
      "",
    );

    const nextDraftTextByTarget = new Map(draftTextByTargetRef.current);
    nextDraftTextByTarget.delete(sourceStorageKey);
    nextDraftTextByTarget.set(destinationStorageKey, sourceText);
    draftTextByTargetRef.current = nextDraftTextByTarget;
    setDraftTextByTarget(nextDraftTextByTarget);

    const nextComposerMemoryByTarget = rekeyTargetChatComposerMemory(
      composerMemoryByTargetRef.current,
      getChatTargetKey(sourceTarget),
      getChatTargetKey(destinationTarget),
    );
    composerMemoryByTargetRef.current = nextComposerMemoryByTarget;
    setComposerMemoryByTarget(nextComposerMemoryByTarget);
  }, [stableDraftScope]);

  const disposeChatTargetState = useCallback((
    targetToDispose: ChatTarget,
  ): void => {
    const storageKey = getChatDraftStorageKey(
      stableDraftScope,
      targetToDispose,
    );
    writeChatDraft(
      window.sessionStorage,
      stableDraftScope,
      targetToDispose,
      "",
    );
    const nextDraftTextByTarget = new Map(draftTextByTargetRef.current);
    nextDraftTextByTarget.delete(storageKey);
    draftTextByTargetRef.current = nextDraftTextByTarget;
    setDraftTextByTarget(nextDraftTextByTarget);

    const nextComposerMemoryByTarget = deleteTargetChatComposerMemory(
      composerMemoryByTargetRef.current,
      getChatTargetKey(targetToDispose),
    );
    composerMemoryByTargetRef.current = nextComposerMemoryByTarget;
    setComposerMemoryByTarget(nextComposerMemoryByTarget);
  }, [stableDraftScope]);

  const chatDraftText = readMountedChatDraftText(
    draftTextByTarget,
    stableDraftScope,
  );
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
      isSelectedWorkspaceDraftUntouched,
      chatTargetKey,
      chatDraftText,
      setChatDraftText,
      setChatDraftTextForTarget,
      chatComposerMemory,
      setChatComposerMemoryForTarget,
      adoptChatTargetState,
      disposeChatTargetState,
    }}>
      {children}
    </ChatLayoutContext.Provider>
  );
};

export const useChatLayout = (): ChatLayoutContextValue => {
  const ctx = useContext(ChatLayoutContext);
  if (ctx === null) {
    throw new Error("useChatLayout must be used within a ChatLayoutProvider");
  }
  return ctx;
};
