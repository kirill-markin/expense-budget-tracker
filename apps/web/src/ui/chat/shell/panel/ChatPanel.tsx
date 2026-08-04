"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import {
  useChatLayout,
  type ChatLayoutScopeToken,
  type ChatPanelLifecycleToken,
  type ChatTargetOperationOwnership,
} from "../layout/ChatLayoutProvider";
import {
  ChatComposer,
  type DeferredAttachmentIngestion,
} from "./ChatComposer";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { ChatTranscript } from "./ChatTranscript";
import { prepareAttachment, type PendingAttachment } from "./FileAttachment";
import {
  getAttachmentFailureReasonKey,
  markChatComposerContentEdited,
  startMountedLifecycle,
} from "./chatPanelRuntime";
import { useAccountSuggestions } from "./useAccountSuggestions";
import { getChatComposerCapabilities } from "../../stream/display/chatComposerCapabilities";
import { buildChatTranscriptMarkdown } from "../../stream/display/chatTranscriptMarkdown";
import {
  getNextChatDictationOperationEpoch,
  insertDictationTranscriptIntoDraft,
  isChatDictationOperationCurrent,
  transcribeChatAudio,
  type ChatDraftSelection,
  type ChatDictationState,
} from "../../stream/hooks/chatDictation";
import { useDesktopEnterToSend } from "../../stream/hooks/useDesktopEnterToSend";
import { useChatSessionController } from "../../session/controller/useChatSessionController";
import {
  areChatTargetsEqual,
  getChatTargetKey,
  type ChatTarget,
} from "../../workspace/chatWorkspaceState";
import type {
  ChatDraftSessionAdoption,
  ChatWorkspaceInvalidationSource,
} from "../../workspace/useChatWorkspaceController";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  mode: "sidebar" | "fullscreen";
  workspaceId: string;
}>;

type CopyStatus = "idle" | "success" | "error";

type ChatDictationOperation = Readonly<{
  epoch: number;
  ownership: ChatTargetOperationOwnership;
  selection: ChatDraftSelection | null;
  shouldRestoreFocus: boolean;
  recorder: MediaRecorder;
  stream: MediaStream;
  recordedChunks: Array<Blob>;
}>;

type ChatAttachmentPreparationOperation = Readonly<{
  operationId: number;
  ownership: ChatTargetOperationOwnership;
  target: ChatTarget;
  targetKey: string;
  selectionEpoch: number;
}>;

type ChatAttachmentIngestionResult = Readonly<{
  attachedFileCount: number;
  target: ChatTarget;
  selectionEpoch: number;
}>;

type ChatPreparedAttachmentIngestion = Readonly<{
  files: ReadonlyArray<File>;
  operationId: number;
}>;

type ChatComposerFocusRequest = Readonly<{
  requestId: number;
  scopeToken: ChatLayoutScopeToken;
  sourceTarget: ChatTarget;
  sourceSelectionEpoch: number;
  destinationTarget: ChatTarget | null;
  destinationSelectionEpoch: number | null;
}>;

type ChatComposerLifecycleSelection = Readonly<{
  scopeToken: ChatLayoutScopeToken;
  target: ChatTarget;
  selectionEpoch: number;
}>;

type ChatTextareaAdoptionHandoff = Readonly<{
  transitionId: symbol;
  scopeToken: ChatLayoutScopeToken;
  target: ChatTarget;
  selectionEpoch: number;
  hasObservedHistoryLoading: boolean;
}>;

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

const stopMediaStream = (stream: MediaStream | null): void => {
  if (stream === null) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
};

const chooseSupportedRecordingMimeType = (): string | null => {
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }

  const supportedMimeTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];

  for (const mimeType of supportedMimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return null;
};

const stopDictationOperationResources = (
  operation: ChatDictationOperation,
): void => {
  if (operation.recorder.state !== "inactive") {
    operation.recorder.stop();
  }
  stopMediaStream(operation.stream);
};

const stopMediaRecorder = (
  recorder: MediaRecorder,
  recordedChunks: Array<Blob>,
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const handleStop = (): void => {
      recorder.removeEventListener("error", handleError as EventListener);
      resolve(new Blob(recordedChunks, {
        type: recorder.mimeType === "" ? "audio/webm" : recorder.mimeType,
      }));
    };

    const handleError = (event: Event): void => {
      recorder.removeEventListener("stop", handleStop);
      if (event instanceof ErrorEvent && event.error instanceof Error) {
        reject(event.error);
        return;
      }

      reject(new Error("Microphone recording failed."));
    };

    recorder.addEventListener("stop", handleStop, { once: true });
    recorder.addEventListener("error", handleError as EventListener, { once: true });
    recorder.stop();
  });

const getMicrophoneErrorMessage = (
  error: unknown,
  t: (key: string) => string,
): string => {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return t("chat.dictationPermissionDenied");
  }

  if (error instanceof DOMException && error.name === "NotFoundError") {
    return t("chat.dictationNoMicrophone");
  }

  return error instanceof Error ? error.message : String(error);
};

export const ChatPanel = (props: Props): ReactElement => {
  const { mode, workspaceId } = props;
  const { t } = useTranslation();
  const accountSuggestionsState = useAccountSuggestions();
  const {
    setIsOpen,
    chatWidth,
    setChatWidth,
    chatWorkspace,
    chatLayoutScopeToken,
    isChatLayoutScopeCurrent,
    chatTargetAdoptionTransition,
    isSelectedWorkspaceDraftUntouched,
    chatTargetKey,
    chatDraftText: inputText,
    setChatDraftText: setInputText,
    setChatDraftTextForTarget,
    chatComposerMemory,
    createChatPendingSubmissionForTarget,
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
  } = useChatLayout();

  const [localWidth, setLocalWidth] = useState<number>(chatWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [dictationState, setDictationState] = useState<ChatDictationState>("idle");
  const [composerLifecycleKey, setComposerLifecycleKey] = useState<number>(0);
  const shouldSubmitOnEnter = useDesktopEnterToSend();
  const {
    pendingAttachments,
    attachmentErrors,
    isAttachmentProcessing,
    pendingSubmission: activePendingSubmission,
  } = chatComposerMemory;

  const dragCounterRef = useRef<number>(0);
  const nextAttachmentOperationIdRef = useRef<number>(0);
  const attachmentOperationsRef = useRef<
    Map<number, ChatAttachmentPreparationOperation>
  >(new Map<number, ChatAttachmentPreparationOperation>());
  const attachmentOperationIdsByTargetKeyRef = useRef<Map<string, number>>(
    new Map<string, number>(),
  );
  const nextComposerFocusRequestIdRef = useRef<number>(0);
  const pendingComposerFocusRequestRef =
    useRef<ChatComposerFocusRequest | null>(null);
  const composerFocusTimeoutRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelLifecycleTokenRef = useRef<ChatPanelLifecycleToken>({
    tokenId: Symbol("chat-panel"),
  });
  const copyStatusResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictationOperationEpochRef = useRef<number>(0);
  const activeDictationOperationRef = useRef<ChatDictationOperation | null>(null);
  const dictationOperationOwnershipsRef = useRef<
    Map<number, ChatTargetOperationOwnership>
  >(new Map<number, ChatTargetOperationOwnership>());
  const pendingTextareaSelectionRef = useRef<ChatDraftSelection | null>(null);
  const pendingTextareaFocusRestoreRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const selectedTargetRef = useRef<ChatTarget>(chatWorkspace.state.target);
  const dictationSelectionRef = useRef<Readonly<{
    scopeToken: ChatLayoutScopeToken;
    target: ChatTarget;
    selectionEpoch: number;
  }>>({
    scopeToken: chatLayoutScopeToken,
    target: chatWorkspace.state.target,
    selectionEpoch: chatWorkspace.selectionEpoch,
  });
  const historyOpenRef = useRef<boolean>(chatWorkspace.historyOpen);
  const committedComposerSelectionRef =
    useRef<ChatComposerLifecycleSelection>({
      scopeToken: chatLayoutScopeToken,
      target: chatWorkspace.state.target,
      selectionEpoch: chatWorkspace.selectionEpoch,
    });
  const processedAdoptionTransitionIdRef = useRef<symbol | null>(null);
  const textareaAdoptionHandoffRef =
    useRef<ChatTextareaAdoptionHandoff | null>(null);

  useLayoutEffect(() => {
    selectedTargetRef.current = chatWorkspace.state.target;
    historyOpenRef.current = chatWorkspace.historyOpen;
  }, [
    chatWorkspace.historyOpen,
    chatWorkspace.state.target,
  ]);

  const isCurrentScopeSelection = useCallback((
    target: ChatTarget,
    selectionEpoch: number,
  ): boolean =>
    isChatLayoutScopeCurrent(chatLayoutScopeToken)
    && chatWorkspace.isSelectionCurrent(target, selectionEpoch), [
    chatLayoutScopeToken,
    chatWorkspace.isSelectionCurrent,
    isChatLayoutScopeCurrent,
  ]);

  const refreshCurrentScopeCatalog = useCallback(async (): Promise<void> => {
    if (!isChatLayoutScopeCurrent(chatLayoutScopeToken)) {
      return;
    }
    await chatWorkspace.refreshCatalog();
  }, [
    chatLayoutScopeToken,
    chatWorkspace.refreshCatalog,
    isChatLayoutScopeCurrent,
  ]);

  const recoverCurrentScopeInvalidSessionSelection = useCallback((
    sessionId: string,
    errorMessage: string,
  ): boolean =>
    isChatLayoutScopeCurrent(chatLayoutScopeToken)
    && chatWorkspace.recoverInvalidSessionSelection(
      sessionId,
      errorMessage,
    ), [
    chatLayoutScopeToken,
    chatWorkspace.recoverInvalidSessionSelection,
    isChatLayoutScopeCurrent,
  ]);

  const promoteSelectedTargetToExplicit = useCallback((
    target: ChatTarget,
  ): number =>
    chatWorkspace.promoteSelectedTargetToExplicit(target), [
    chatWorkspace.promoteSelectedTargetToExplicit,
  ]);

  const scheduleComposerFocus = useCallback((
    requestId: number,
    target: ChatTarget,
    selectionEpoch: number,
  ): void => {
    if (composerFocusTimeoutRef.current !== null) {
      clearTimeout(composerFocusTimeoutRef.current);
    }
    composerFocusTimeoutRef.current = setTimeout((): void => {
      composerFocusTimeoutRef.current = null;
      const request = pendingComposerFocusRequestRef.current;
      if (request?.requestId !== requestId) {
        return;
      }
      if (
        !isMountedRef.current
        || !isCurrentScopeSelection(target, selectionEpoch)
      ) {
        pendingComposerFocusRequestRef.current = null;
        return;
      }
      if (historyOpenRef.current) {
        return;
      }
      const textarea = textareaRef.current;
      if (textarea === null || textarea.disabled) {
        return;
      }
      textarea.focus();
      if (document.activeElement !== textarea) {
        return;
      }
      pendingComposerFocusRequestRef.current = null;
    }, 0);
  }, [isCurrentScopeSelection]);

  const requestComposerFocusAfterNew = useCallback((
    sourceTarget: ChatTarget,
    sourceSelectionEpoch: number,
    destinationTarget: ChatTarget,
    destinationSelectionEpoch: number,
  ): void => {
    const requestId = nextComposerFocusRequestIdRef.current + 1;
    nextComposerFocusRequestIdRef.current = requestId;
    pendingComposerFocusRequestRef.current = {
      requestId,
      scopeToken: chatLayoutScopeToken,
      sourceTarget,
      sourceSelectionEpoch,
      destinationTarget,
      destinationSelectionEpoch,
    };
    scheduleComposerFocus(
      requestId,
      destinationTarget,
      destinationSelectionEpoch,
    );
  }, [
    chatLayoutScopeToken,
    scheduleComposerFocus,
  ]);

  const cancelComposerFocusRequest = useCallback((): void => {
    pendingComposerFocusRequestRef.current = null;
    if (composerFocusTimeoutRef.current !== null) {
      clearTimeout(composerFocusTimeoutRef.current);
      composerFocusTimeoutRef.current = null;
    }
  }, []);

  const invalidateAttachmentOperationForTarget = useCallback((
    target: ChatTarget,
  ): void => {
    const targetKey = getChatTargetKey(target);
    const operationId =
      attachmentOperationIdsByTargetKeyRef.current.get(targetKey);
    if (operationId === undefined) {
      return;
    }

    attachmentOperationIdsByTargetKeyRef.current.delete(targetKey);
    const operation = attachmentOperationsRef.current.get(operationId);
    attachmentOperationsRef.current.delete(operationId);
    if (operation !== undefined) {
      releaseChatTargetOperationOwnership(operation.ownership);
    }
  }, [releaseChatTargetOperationOwnership]);

  const cancelAllAttachmentOperations = useCallback((): void => {
    const operations = Array.from(attachmentOperationsRef.current.values());
    attachmentOperationsRef.current.clear();
    attachmentOperationIdsByTargetKeyRef.current.clear();
    for (const operation of operations) {
      const ownership = readChatTargetOperationOwnership(operation.ownership);
      releaseChatTargetOperationOwnership(operation.ownership);
      if (ownership !== null) {
        setChatComposerMemoryForTarget(ownership.target, (currentMemory) => ({
          ...currentMemory,
          isAttachmentProcessing: false,
        }));
      }
    }
  }, [
    readChatTargetOperationOwnership,
    releaseChatTargetOperationOwnership,
    setChatComposerMemoryForTarget,
  ]);

  const readCurrentAttachmentOperation = useCallback((
    operationId: number,
  ): ChatAttachmentPreparationOperation | null => {
    const operation = attachmentOperationsRef.current.get(operationId);
    if (operation === undefined) {
      return null;
    }
    const ownership = readChatTargetOperationOwnership(operation.ownership);
    if (ownership === null) {
      return null;
    }
    const currentTargetKey = getChatTargetKey(ownership.target);
    if (currentTargetKey === operation.targetKey) {
      return operation;
    }
    if (
      attachmentOperationIdsByTargetKeyRef.current.get(operation.targetKey)
      === operationId
    ) {
      attachmentOperationIdsByTargetKeyRef.current.delete(operation.targetKey);
    }
    const conflictingOperationId =
      attachmentOperationIdsByTargetKeyRef.current.get(currentTargetKey);
    if (
      conflictingOperationId !== undefined
      && conflictingOperationId !== operationId
    ) {
      releaseChatTargetOperationOwnership(operation.ownership);
      attachmentOperationsRef.current.delete(operationId);
      return null;
    }
    const currentOperation: ChatAttachmentPreparationOperation = {
      ...operation,
      target: ownership.target,
      targetKey: currentTargetKey,
      selectionEpoch: ownership.selectionEpoch,
    };
    attachmentOperationsRef.current.set(operationId, currentOperation);
    attachmentOperationIdsByTargetKeyRef.current.set(
      currentTargetKey,
      operationId,
    );
    return currentOperation;
  }, [
    readChatTargetOperationOwnership,
    releaseChatTargetOperationOwnership,
  ]);

  const cancelDictationOperation = useCallback((): void => {
    dictationOperationEpochRef.current = getNextChatDictationOperationEpoch(
      dictationOperationEpochRef.current,
    );
    const operation = activeDictationOperationRef.current;
    activeDictationOperationRef.current = null;
    for (const ownership of dictationOperationOwnershipsRef.current.values()) {
      releaseChatTargetOperationOwnership(ownership);
    }
    dictationOperationOwnershipsRef.current.clear();
    if (operation !== null) {
      stopDictationOperationResources(operation);
    }
    pendingTextareaSelectionRef.current = null;
    pendingTextareaFocusRestoreRef.current = false;
    if (isMountedRef.current) {
      setDictationState("idle");
    }
  }, [releaseChatTargetOperationOwnership]);

  useLayoutEffect(() => {
    cancelAllAttachmentOperations();
    cancelDictationOperation();
  }, [
    cancelAllAttachmentOperations,
    cancelDictationOperation,
    chatLayoutScopeToken,
  ]);

  const adoptDraftSession = useCallback((
    draftId: string,
    sessionId: string,
    expectedSelectionEpoch: number,
  ): ChatDraftSessionAdoption =>
    adoptChatPendingSubmissionSession(
      chatLayoutScopeToken,
      draftId,
      sessionId,
      expectedSelectionEpoch,
    ), [
    adoptChatPendingSubmissionSession,
    chatLayoutScopeToken,
  ]);

  useLayoutEffect(() => {
    const previousSelection = committedComposerSelectionRef.current;
    const currentSelection: ChatComposerLifecycleSelection = {
      scopeToken: chatLayoutScopeToken,
      target: chatWorkspace.state.target,
      selectionEpoch: chatWorkspace.selectionEpoch,
    };
    const adoptionTransition = chatTargetAdoptionTransition;
    const isUnconsumedAdoption =
      adoptionTransition !== null
      && adoptionTransition.transitionId
        !== processedAdoptionTransitionIdRef.current;
    const isExactSelectedAdoption =
      isUnconsumedAdoption
      && adoptionTransition.scopeToken === currentSelection.scopeToken
      && adoptionTransition.selectionEpoch === previousSelection.selectionEpoch
      && adoptionTransition.selectionEpoch === currentSelection.selectionEpoch
      && areChatTargetsEqual(
        adoptionTransition.sourceTarget,
        previousSelection.target,
      )
      && areChatTargetsEqual(
        adoptionTransition.destinationTarget,
        currentSelection.target,
      );

    if (isUnconsumedAdoption) {
      processedAdoptionTransitionIdRef.current =
        adoptionTransition.transitionId;
    }
    if (isExactSelectedAdoption) {
      if (adoptionTransition.stateDisposition === "destination_preserved") {
        invalidateAttachmentOperationForTarget(
          adoptionTransition.sourceTarget,
        );
        cancelDictationOperation();
      } else {
        for (const operationId of
          attachmentOperationsRef.current.keys()) {
          readCurrentAttachmentOperation(operationId);
        }
      }
    }

    const isSameCommittedTarget =
      previousSelection.scopeToken === currentSelection.scopeToken
      && previousSelection.selectionEpoch === currentSelection.selectionEpoch
      && areChatTargetsEqual(previousSelection.target, currentSelection.target);
    const preservesAdoptionLifecycle =
      isExactSelectedAdoption
      && adoptionTransition.stateDisposition === "transferred";
    const requiresTextareaAdoptionHandoff =
      preservesAdoptionLifecycle
      && adoptionTransition.originatingPanelLifecycleToken
        !== panelLifecycleTokenRef.current;
    if (requiresTextareaAdoptionHandoff) {
      textareaAdoptionHandoffRef.current = {
        transitionId: adoptionTransition.transitionId,
        scopeToken: currentSelection.scopeToken,
        target: currentSelection.target,
        selectionEpoch: currentSelection.selectionEpoch,
        hasObservedHistoryLoading: false,
      };
    } else if (!isSameCommittedTarget) {
      textareaAdoptionHandoffRef.current = null;
    }
    if (!isSameCommittedTarget && !preservesAdoptionLifecycle) {
      setComposerLifecycleKey((currentKey) => currentKey + 1);
    }
    committedComposerSelectionRef.current = currentSelection;
  }, [
    cancelDictationOperation,
    chatLayoutScopeToken,
    chatTargetAdoptionTransition,
    chatWorkspace.selectionEpoch,
    chatWorkspace.state.target,
    invalidateAttachmentOperationForTarget,
    readCurrentAttachmentOperation,
  ]);

  const observeCurrentScopeSessionInvalidation = useCallback((
    sessionId: string,
    version: number,
    source: ChatWorkspaceInvalidationSource,
  ): void => {
    if (!isChatLayoutScopeCurrent(chatLayoutScopeToken)) {
      return;
    }
    chatWorkspace.observeSessionInvalidation(sessionId, version, source);
  }, [
    chatLayoutScopeToken,
    chatWorkspace.observeSessionInvalidation,
    isChatLayoutScopeCurrent,
  ]);

  const {
    messages,
    runState,
    isHistoryLoaded,
    isAssistantRunActive,
    isLiveStreamConnected,
    isStopping,
    composerAction,
    sendMessage,
    stopMessage,
  } = useChatSessionController({
    workspaceId,
    target: chatWorkspace.state.target,
    selectionEpoch: chatWorkspace.selectionEpoch,
    isWorkspaceReady: chatWorkspace.isReady,
    isSelectionCurrent: isCurrentScopeSelection,
    adoptDraftSession,
    refreshCatalog: refreshCurrentScopeCatalog,
    observeSessionInvalidation: observeCurrentScopeSessionInvalidation,
    recoverInvalidSessionSelection:
      recoverCurrentScopeInvalidSessionSelection,
  });

  useLayoutEffect(() => {
    const handoff = textareaAdoptionHandoffRef.current;
    if (handoff === null) {
      return;
    }
    const isCurrentHandoff =
      handoff.scopeToken === chatLayoutScopeToken
      && chatTargetAdoptionTransition?.transitionId === handoff.transitionId
      && chatTargetAdoptionTransition.stateDisposition === "transferred"
      && handoff.selectionEpoch === chatWorkspace.selectionEpoch
      && areChatTargetsEqual(
        handoff.target,
        chatWorkspace.state.target,
      );
    if (!isCurrentHandoff) {
      textareaAdoptionHandoffRef.current = null;
      return;
    }
    if (!isHistoryLoaded && !handoff.hasObservedHistoryLoading) {
      textareaAdoptionHandoffRef.current = {
        ...handoff,
        hasObservedHistoryLoading: true,
      };
      return;
    }
    if (isHistoryLoaded && handoff.hasObservedHistoryLoading) {
      textareaAdoptionHandoffRef.current = null;
    }
  }, [
    chatLayoutScopeToken,
    chatTargetAdoptionTransition,
    chatWorkspace.selectionEpoch,
    chatWorkspace.state.target,
    isHistoryLoaded,
  ]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const isRtl = document.documentElement.dir === "rtl";
      const rawWidth = isRtl ? window.innerWidth - e.clientX : e.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(rawWidth, MAX_WIDTH));
      setLocalWidth(newWidth);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
      setChatWidth(localWidth);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging, localWidth, setChatWidth]);

  useEffect(() => {
    const finishMountedLifecycle = startMountedLifecycle(isMountedRef);

    return () => {
      finishMountedLifecycle();
      if (copyStatusResetRef.current !== null) {
        clearTimeout(copyStatusResetRef.current);
      }
      if (composerFocusTimeoutRef.current !== null) {
        clearTimeout(composerFocusTimeoutRef.current);
      }
      pendingComposerFocusRequestRef.current = null;
      cancelAllAttachmentOperations();
      cancelDictationOperation();
    };
  }, [cancelAllAttachmentOperations, cancelDictationOperation]);

  useEffect(() => {
    const request = pendingComposerFocusRequestRef.current;
    if (request === null) {
      return;
    }
    const currentTarget = chatWorkspace.state.target;
    const currentSelectionEpoch = chatWorkspace.selectionEpoch;
    if (
      request.scopeToken !== chatLayoutScopeToken
      || !isChatLayoutScopeCurrent(request.scopeToken)
    ) {
      pendingComposerFocusRequestRef.current = null;
      return;
    }
    if (
      request.destinationTarget !== null
      && request.destinationSelectionEpoch !== null
    ) {
      if (
        !areChatTargetsEqual(request.destinationTarget, currentTarget)
        || request.destinationSelectionEpoch !== currentSelectionEpoch
      ) {
        pendingComposerFocusRequestRef.current = null;
        if (composerFocusTimeoutRef.current !== null) {
          clearTimeout(composerFocusTimeoutRef.current);
          composerFocusTimeoutRef.current = null;
        }
        return;
      }
      scheduleComposerFocus(
        request.requestId,
        currentTarget,
        currentSelectionEpoch,
      );
      return;
    }

    const sourceIsStillCurrent =
      currentSelectionEpoch === request.sourceSelectionEpoch
      && areChatTargetsEqual(currentTarget, request.sourceTarget);
    const isExpectedTargetTransition =
      currentSelectionEpoch === request.sourceSelectionEpoch + 1;
    if (!sourceIsStillCurrent && !isExpectedTargetTransition) {
      pendingComposerFocusRequestRef.current = null;
      return;
    }
    pendingComposerFocusRequestRef.current = {
      ...request,
      destinationTarget: currentTarget,
      destinationSelectionEpoch: currentSelectionEpoch,
    };
    scheduleComposerFocus(
      request.requestId,
      currentTarget,
      currentSelectionEpoch,
    );
  }, [
    chatTargetKey,
    chatLayoutScopeToken,
    chatWorkspace.historyOpen,
    chatWorkspace.selectionEpoch,
    chatWorkspace.state.target,
    isChatLayoutScopeCurrent,
    isHistoryLoaded,
    scheduleComposerFocus,
  ]);

  useEffect(() => {
    if (dictationState !== "idle") {
      return;
    }

    const textarea = textareaRef.current;
    const pendingSelection = pendingTextareaSelectionRef.current;
    if (textarea === null || pendingSelection === null) {
      return;
    }

    const start = Math.max(0, Math.min(pendingSelection.start, textarea.value.length));
    const end = Math.max(0, Math.min(pendingSelection.end, textarea.value.length));

    if (pendingTextareaFocusRestoreRef.current) {
      textarea.focus();
    }

    textarea.setSelectionRange(start, end);
    pendingTextareaSelectionRef.current = null;
    pendingTextareaFocusRestoreRef.current = false;
  }, [dictationState, inputText]);

  const prepareAttachmentIngestion = useCallback((
    files: ReadonlyArray<File>,
  ): ChatPreparedAttachmentIngestion | null => {
    const target = chatWorkspace.state.target;
    const targetKey = chatTargetKey;
    if (
      files.length === 0
      || !isChatLayoutScopeCurrent(chatLayoutScopeToken)
      || attachmentOperationIdsByTargetKeyRef.current.has(targetKey)
    ) {
      return null;
    }

    const selectionEpoch = promoteSelectedTargetToExplicit(target);
    const operationId = nextAttachmentOperationIdRef.current + 1;
    nextAttachmentOperationIdRef.current = operationId;
    const ownership = registerChatTargetOperationOwnership(
      "attachment_preparation",
      target,
      selectionEpoch,
    );
    attachmentOperationsRef.current.set(operationId, {
      operationId,
      ownership,
      target,
      targetKey,
      selectionEpoch,
    });
    attachmentOperationIdsByTargetKeyRef.current.set(targetKey, operationId);
    try {
      setChatComposerMemoryForTarget(target, (currentMemory) => ({
        ...currentMemory,
        attachmentErrors: [],
        isAttachmentProcessing: true,
      }));
    } catch (error) {
      attachmentOperationsRef.current.delete(operationId);
      attachmentOperationIdsByTargetKeyRef.current.delete(targetKey);
      releaseChatTargetOperationOwnership(ownership);
      throw error;
    }
    return {
      files: [...files],
      operationId,
    };
  }, [
    chatTargetKey,
    chatLayoutScopeToken,
    chatWorkspace.state.target,
    isChatLayoutScopeCurrent,
    promoteSelectedTargetToExplicit,
    registerChatTargetOperationOwnership,
    releaseChatTargetOperationOwnership,
    setChatComposerMemoryForTarget,
  ]);

  const finishAttachmentIngestion = useCallback((
    operationId: number,
  ): void => {
    const registeredOperation =
      attachmentOperationsRef.current.get(operationId);
    const currentOperation = readCurrentAttachmentOperation(operationId);
    attachmentOperationsRef.current.delete(operationId);
    for (const [ownedTargetKey, ownedOperationId] of
      attachmentOperationIdsByTargetKeyRef.current.entries()) {
      if (ownedOperationId === operationId) {
        attachmentOperationIdsByTargetKeyRef.current.delete(ownedTargetKey);
      }
    }
    if (registeredOperation !== undefined) {
      releaseChatTargetOperationOwnership(registeredOperation.ownership);
    }
    if (currentOperation !== null) {
      setChatComposerMemoryForTarget(
        currentOperation.target,
        (currentMemory) => ({
          ...currentMemory,
          isAttachmentProcessing: false,
        }),
      );
    }
  }, [
    readCurrentAttachmentOperation,
    releaseChatTargetOperationOwnership,
    setChatComposerMemoryForTarget,
  ]);

  const runPreparedAttachmentIngestion = useCallback(async (
    ingestion: ChatPreparedAttachmentIngestion,
  ): Promise<ChatAttachmentIngestionResult | null> => {
    const initialOperation =
      readCurrentAttachmentOperation(ingestion.operationId);
    if (initialOperation === null) {
      finishAttachmentIngestion(ingestion.operationId);
      return null;
    }
    let attachedFileCount = 0;
    let resultTarget = initialOperation.target;

    try {
      for (const file of ingestion.files) {
        try {
          const attachment = await prepareAttachment(file);
          const currentOperation = readCurrentAttachmentOperation(
            ingestion.operationId,
          );
          if (currentOperation === null) {
            return null;
          }
          resultTarget = currentOperation.target;
          setChatComposerMemoryForTarget(
            currentOperation.target,
            (currentMemory) => markChatComposerContentEdited({
              ...currentMemory,
              pendingAttachments: [
                ...currentMemory.pendingAttachments,
                attachment,
              ],
            }),
          );
          attachedFileCount += 1;
        } catch (error) {
          const currentOperation = readCurrentAttachmentOperation(
            ingestion.operationId,
          );
          if (currentOperation === null) {
            return null;
          }
          resultTarget = currentOperation.target;
          const reason = t(getAttachmentFailureReasonKey(error));
          setChatComposerMemoryForTarget(
            currentOperation.target,
            (currentMemory) => ({
              ...currentMemory,
              attachmentErrors: [
                ...currentMemory.attachmentErrors,
                {
                  fileName: file.name,
                  message: t("chat.attachmentConversionFailed", {
                    fileName: file.name,
                    reason,
                  }),
                },
              ],
            }),
          );
        }
      }
    } finally {
      finishAttachmentIngestion(ingestion.operationId);
    }

    return {
      attachedFileCount,
      target: resultTarget,
      selectionEpoch: initialOperation.selectionEpoch,
    };
  }, [
    finishAttachmentIngestion,
    readCurrentAttachmentOperation,
    setChatComposerMemoryForTarget,
    t,
  ]);

  const ingestFilesForSelectedTarget = useCallback(async (
    files: ReadonlyArray<File>,
  ): Promise<ChatAttachmentIngestionResult | null> => {
    const ingestion = prepareAttachmentIngestion(files);
    return ingestion === null
      ? null
      : runPreparedAttachmentIngestion(ingestion);
  }, [prepareAttachmentIngestion, runPreparedAttachmentIngestion]);

  const ingestFiles = useCallback(async (
    files: ReadonlyArray<File>,
  ): Promise<number> => {
    const result = await ingestFilesForSelectedTarget(files);
    return result?.attachedFileCount ?? 0;
  }, [ingestFilesForSelectedTarget]);

  const prepareDeferredAttachmentIngestion = useCallback((
    files: ReadonlyArray<File>,
  ): DeferredAttachmentIngestion | null => {
    const ingestion = prepareAttachmentIngestion(files);
    if (ingestion === null) {
      return null;
    }

    return async (): Promise<void> => {
      const operation = readCurrentAttachmentOperation(
        ingestion.operationId,
      );
      if (
        operation === null
        || !isCurrentScopeSelection(
          operation.target,
          operation.selectionEpoch,
        )
      ) {
        finishAttachmentIngestion(ingestion.operationId);
        return;
      }
      await runPreparedAttachmentIngestion(ingestion);
    };
  }, [
    finishAttachmentIngestion,
    isCurrentScopeSelection,
    prepareAttachmentIngestion,
    readCurrentAttachmentOperation,
    runPreparedAttachmentIngestion,
  ]);

  const removeAttachment = useCallback((index: number): void => {
    const target = chatWorkspace.state.target;
    promoteSelectedTargetToExplicit(target);
    setChatComposerMemoryForTarget(
      target,
      (currentMemory) => markChatComposerContentEdited({
        ...currentMemory,
        pendingAttachments: [
          ...currentMemory.pendingAttachments.slice(0, index),
          ...currentMemory.pendingAttachments.slice(index + 1),
        ],
      }),
    );
  }, [
    chatWorkspace.state.target,
    promoteSelectedTargetToExplicit,
    setChatComposerMemoryForTarget,
  ]);

  const hasPendingMessage = inputText.trim().length > 0 || pendingAttachments.length > 0;
  const hasMeaningfulTargetActivity =
    inputText.length > 0
    || pendingAttachments.length > 0
    || attachmentErrors.length > 0
    || isAttachmentProcessing
    || activePendingSubmission !== null;
  useEffect(() => {
    if (!chatWorkspace.isReady || !hasMeaningfulTargetActivity) {
      return;
    }
    promoteSelectedTargetToExplicit(chatWorkspace.state.target);
  }, [
    chatWorkspace.isReady,
    chatWorkspace.state.target,
    hasMeaningfulTargetActivity,
    promoteSelectedTargetToExplicit,
  ]);
  const textareaAdoptionHandoff = textareaAdoptionHandoffRef.current;
  const isTextareaReady = isHistoryLoaded
    || (
      textareaAdoptionHandoff !== null
      && textareaAdoptionHandoff.scopeToken === chatLayoutScopeToken
      && chatTargetAdoptionTransition?.transitionId
        === textareaAdoptionHandoff.transitionId
      && chatTargetAdoptionTransition.stateDisposition === "transferred"
      && textareaAdoptionHandoff.selectionEpoch
        === chatWorkspace.selectionEpoch
      && areChatTargetsEqual(
        textareaAdoptionHandoff.target,
        chatWorkspace.state.target,
      )
    );
  const composerCapabilities = getChatComposerCapabilities({
    composerAction,
    isHistoryLoaded,
    isTextareaReady,
    isStopping,
    isLiveStreamConnected,
    isAttachmentProcessing,
    isSubmissionPending: activePendingSubmission !== null,
    dictationState,
    hasPendingMessage,
    shouldSubmitOnEnter,
  });

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();

    if (!composerCapabilities.isDropTargetEnabled) {
      return;
    }
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, [composerCapabilities.isDropTargetEnabled]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();

    if (!composerCapabilities.isDropTargetEnabled) {
      return;
    }
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, [composerCapabilities.isDropTargetEnabled]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();

    if (!composerCapabilities.isDropTargetEnabled) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "copy";
  }, [composerCapabilities.isDropTargetEnabled]);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (!composerCapabilities.isDropTargetEnabled) {
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    const ingestionResult = await ingestFilesForSelectedTarget(files);

    if (
      ingestionResult !== null
      && ingestionResult.attachedFileCount > 0
      && isCurrentScopeSelection(
        ingestionResult.target,
        ingestionResult.selectionEpoch,
      )
    ) {
      textareaRef.current?.focus();
    }
  }, [
    composerCapabilities.isDropTargetEnabled,
    ingestFilesForSelectedTarget,
    isCurrentScopeSelection,
  ]);

  const canSendPendingMessage = isHistoryLoaded
    && !isStopping
    && !isAssistantRunActive
    && !isLiveStreamConnected
    && !isAttachmentProcessing
    && activePendingSubmission === null
    && dictationState === "idle"
    && hasPendingMessage;

  useEffect(() => {
    if (composerCapabilities.isDropTargetEnabled) {
      return;
    }

    dragCounterRef.current = 0;
    setIsDragOver(false);
  }, [composerCapabilities.isDropTargetEnabled]);

  useEffect(() => {
    const previousSelection = dictationSelectionRef.current;
    const currentSelection = {
      scopeToken: chatLayoutScopeToken,
      target: chatWorkspace.state.target,
      selectionEpoch: chatWorkspace.selectionEpoch,
    } as const;
    dictationSelectionRef.current = currentSelection;
    const hasCurrentAdoptedDictationOwnership = Array.from(
      dictationOperationOwnershipsRef.current.values(),
    ).some((ownership): boolean => {
      const currentOwnership = readChatTargetOperationOwnership(ownership);
      return currentOwnership !== null
        && currentOwnership.selectionEpoch === currentSelection.selectionEpoch
        && areChatTargetsEqual(
          currentOwnership.target,
          currentSelection.target,
        );
    });
    if (
      previousSelection.scopeToken === currentSelection.scopeToken
      && previousSelection.selectionEpoch === currentSelection.selectionEpoch
      && (
        areChatTargetsEqual(
          previousSelection.target,
          currentSelection.target,
        )
        || hasCurrentAdoptedDictationOwnership
      )
    ) {
      return;
    }

    cancelDictationOperation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
  }, [
    cancelDictationOperation,
    chatLayoutScopeToken,
    chatWorkspace.selectionEpoch,
    chatWorkspace.state.target,
    readChatTargetOperationOwnership,
  ]);

  const startDictation = useCallback(async (): Promise<void> => {
    if (
      dictationState !== "idle"
      || activeDictationOperationRef.current !== null
    ) {
      return;
    }

    const textarea = textareaRef.current;
    const operationEpoch = getNextChatDictationOperationEpoch(
      dictationOperationEpochRef.current,
    );
    dictationOperationEpochRef.current = operationEpoch;
    const target = chatWorkspace.state.target;
    const selectionEpoch = promoteSelectedTargetToExplicit(target);
    const shouldRestoreFocus = textarea !== null && document.activeElement === textarea;
    const selection = shouldRestoreFocus && textarea !== null
      ? {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      }
      : null;

    if (typeof MediaRecorder === "undefined") {
      alert(t("chat.dictationUnavailable"));
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== "function") {
      alert(t("chat.dictationUnavailable"));
      return;
    }

    const ownership = registerChatTargetOperationOwnership(
      "dictation",
      target,
      selectionEpoch,
    );
    dictationOperationOwnershipsRef.current.set(operationEpoch, ownership);
    setDictationState("requesting_permission");

    let stream: MediaStream | null = null;
    let operation: ChatDictationOperation | null = null;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      const currentOwnership =
        readChatTargetOperationOwnership(ownership);
      if (
        !isMountedRef.current
        || currentOwnership === null
        || !isChatDictationOperationCurrent(
          operationEpoch,
          dictationOperationEpochRef.current,
        )
        || !isCurrentScopeSelection(
          currentOwnership.target,
          currentOwnership.selectionEpoch,
        )
      ) {
        dictationOperationOwnershipsRef.current.delete(operationEpoch);
        releaseChatTargetOperationOwnership(ownership);
        stopMediaStream(stream);
        return;
      }

      const recorderMimeType = chooseSupportedRecordingMimeType();
      const recorder = recorderMimeType === null
        ? new MediaRecorder(stream)
        : new MediaRecorder(stream, { mimeType: recorderMimeType });
      const recordedChunks: Array<Blob> = [];
      operation = {
        epoch: operationEpoch,
        ownership,
        selection,
        shouldRestoreFocus,
        recorder,
        stream,
        recordedChunks,
      };
      recorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      });
      recorder.start();
      activeDictationOperationRef.current = operation;
      if (
        isMountedRef.current
        && readChatTargetOperationOwnership(ownership) !== null
        && isChatDictationOperationCurrent(
          operationEpoch,
          dictationOperationEpochRef.current,
        )
      ) {
        setDictationState("recording");
      }
    } catch (error) {
      if (operation === null) {
        stopMediaStream(stream);
      } else {
        stopDictationOperationResources(operation);
      }
      if (activeDictationOperationRef.current?.epoch === operationEpoch) {
        activeDictationOperationRef.current = null;
      }
      const wasOwnershipCurrent =
        readChatTargetOperationOwnership(ownership) !== null;
      dictationOperationOwnershipsRef.current.delete(operationEpoch);
      releaseChatTargetOperationOwnership(ownership);
      if (
        isMountedRef.current
        && wasOwnershipCurrent
        && isChatDictationOperationCurrent(
          operationEpoch,
          dictationOperationEpochRef.current,
        )
      ) {
        alert(getMicrophoneErrorMessage(error, t));
        setDictationState("idle");
      }
    }
  }, [
    chatWorkspace.state.target,
    dictationState,
    isCurrentScopeSelection,
    promoteSelectedTargetToExplicit,
    readChatTargetOperationOwnership,
    registerChatTargetOperationOwnership,
    releaseChatTargetOperationOwnership,
    t,
  ]);

  const stopDictation = useCallback(async (): Promise<void> => {
    const operation = activeDictationOperationRef.current;
    if (operation === null || operation.recorder.state === "inactive") {
      cancelDictationOperation();
      return;
    }

    setDictationState("transcribing");

    try {
      const audioBlob = await stopMediaRecorder(
        operation.recorder,
        operation.recordedChunks,
      );
      stopMediaStream(operation.stream);
      const readCurrentOperationTarget = (): ChatTarget | null => {
        const ownership =
          readChatTargetOperationOwnership(operation.ownership);
        if (
          !isMountedRef.current
          || ownership === null
          || !isChatDictationOperationCurrent(
            operation.epoch,
            dictationOperationEpochRef.current,
          )
          || activeDictationOperationRef.current?.epoch !== operation.epoch
          || !isCurrentScopeSelection(
            ownership.target,
            ownership.selectionEpoch,
          )
        ) {
          return null;
        }
        return ownership.target;
      };
      if (readCurrentOperationTarget() === null) {
        return;
      }
      if (audioBlob.size <= 0) {
        return;
      }

      const transcription = await transcribeChatAudio(audioBlob, t);
      const currentTarget = readCurrentOperationTarget();
      if (currentTarget === null) {
        return;
      }
      setChatDraftTextForTarget(currentTarget, (currentText) => {
        const insertionResult = insertDictationTranscriptIntoDraft(
          currentText,
          transcription.text,
          operation.selection,
        );
        const nextSelection = operation.shouldRestoreFocus
          ? insertionResult.selection
          : null;
        pendingTextareaSelectionRef.current = nextSelection;
        pendingTextareaFocusRestoreRef.current = operation.shouldRestoreFocus;
        return insertionResult.text;
      });
      setChatComposerMemoryForTarget(
        currentTarget,
        markChatComposerContentEdited,
      );
    } catch (error) {
      if (
        isMountedRef.current
        && readChatTargetOperationOwnership(operation.ownership) !== null
        && isChatDictationOperationCurrent(
          operation.epoch,
          dictationOperationEpochRef.current,
        )
        && activeDictationOperationRef.current?.epoch === operation.epoch
      ) {
        alert(getMicrophoneErrorMessage(error, t));
      }
    } finally {
      stopMediaStream(operation.stream);
      if (activeDictationOperationRef.current?.epoch === operation.epoch) {
        activeDictationOperationRef.current = null;
      }
      dictationOperationOwnershipsRef.current.delete(operation.epoch);
      const wasOwnershipCurrent =
        readChatTargetOperationOwnership(operation.ownership) !== null;
      releaseChatTargetOperationOwnership(operation.ownership);
      if (
        isMountedRef.current
        && wasOwnershipCurrent
        && isChatDictationOperationCurrent(
          operation.epoch,
          dictationOperationEpochRef.current,
        )
      ) {
        setDictationState("idle");
      }
    }
  }, [
    cancelDictationOperation,
    isCurrentScopeSelection,
    readChatTargetOperationOwnership,
    releaseChatTargetOperationOwnership,
    setChatComposerMemoryForTarget,
    setChatDraftTextForTarget,
    t,
  ]);

  const handleToggleDictation = useCallback(async (): Promise<void> => {
    if (dictationState === "recording") {
      await stopDictation();
      return;
    }

    if (dictationState !== "idle") {
      return;
    }

    await startDictation();
  }, [dictationState, startDictation, stopDictation]);

  const sendPendingMessage = useCallback(async (): Promise<void> => {
    if (
      !canSendPendingMessage
      || attachmentOperationIdsByTargetKeyRef.current.has(chatTargetKey)
    ) {
      return;
    }

    const target = chatWorkspace.state.target;
    const submissionSelectionEpoch = chatWorkspace.selectionEpoch;
    const nextText = inputText;
    const submissionSnapshot = createChatPendingSubmissionForTarget(
      target,
      nextText,
    );
    const nextAttachments = submissionSnapshot.attachments;
    const pendingSubmission = target.kind === "draft"
      ? submissionSnapshot
      : null;
    const pendingSubmissionOwnership =
      target.kind === "draft" && pendingSubmission !== null
        ? registerChatPendingSubmissionOwnership(
            target,
            submissionSelectionEpoch,
            pendingSubmission,
            panelLifecycleTokenRef.current,
          )
        : null;
    let didClearInput = false;
    try {
      setInputText("");
      didClearInput = true;
      setChatComposerMemoryForTarget(target, (currentMemory) => ({
        ...currentMemory,
        pendingAttachments: [],
        attachmentErrors: [],
        pendingSubmission,
      }));
    } catch (error) {
      let rollbackError: Error | null = null;
      if (didClearInput) {
        try {
          setInputText(nextText);
        } catch (inputRollbackError) {
          rollbackError = inputRollbackError instanceof Error
            ? inputRollbackError
            : new Error(String(inputRollbackError));
        }
      }
      if (pendingSubmissionOwnership !== null) {
        if (!releaseChatPendingSubmissionOwnership(
          pendingSubmissionOwnership,
        )) {
          const ownershipError = new Error(
            "Chat submission staging could not release its exact ownership",
          );
          rollbackError ??= ownershipError;
        }
      }
      const stagingMessage = error instanceof Error
        ? error.message
        : String(error);
      if (rollbackError !== null) {
        throw new Error(
          `Chat submission staging failed and rollback also failed: `
          + `${stagingMessage}; rollback: ${rollbackError.message}`,
        );
      }
      throw new Error(`Chat submission staging failed: ${stagingMessage}`);
    }

    const rejectedSettlementFailureRef: {
      current: Readonly<{
        error: Error;
        retry: () => boolean;
      }> | null;
    } = { current: null };
    const unresolvedSettlementFailureRef: {
      current: Readonly<{
        error: Error;
        retry: () => boolean;
      }> | null;
    } = { current: null };
    const detachedSettlementFailureRef: {
      current: Error | null;
    } = { current: null };
    await sendMessage({
      text: nextText,
      attachments: nextAttachments,
      onSubmissionRejected: (): void => {
        if (pendingSubmissionOwnership === null) {
          return;
        }
        try {
          if (settleDetachedChatPendingSubmissionOwnership(
            pendingSubmissionOwnership,
          )) {
            return;
          }
        } catch (error) {
          detachedSettlementFailureRef.current = error instanceof Error
            ? error
            : new Error(String(error));
          return;
        }
        try {
          settleRejectedChatPendingSubmissionOwnership(
            pendingSubmissionOwnership,
          );
        } catch (error) {
          rejectedSettlementFailureRef.current = {
            error: error instanceof Error ? error : new Error(String(error)),
            retry: (): boolean =>
              settleRejectedChatPendingSubmissionOwnership(
                pendingSubmissionOwnership,
              ),
          };
        }
      },
      onSubmissionUnresolved: (): void => {
        if (pendingSubmissionOwnership === null) {
          return;
        }
        try {
          if (settleDetachedChatPendingSubmissionOwnership(
            pendingSubmissionOwnership,
          )) {
            return;
          }
        } catch (error) {
          detachedSettlementFailureRef.current = error instanceof Error
            ? error
            : new Error(String(error));
          return;
        }
        try {
          settleUnresolvedChatPendingSubmissionOwnership(
            pendingSubmissionOwnership,
          );
        } catch (error) {
          unresolvedSettlementFailureRef.current = {
            error: error instanceof Error ? error : new Error(String(error)),
            retry: (): boolean =>
              settleUnresolvedChatPendingSubmissionOwnership(
                pendingSubmissionOwnership,
              ),
          };
        }
      },
    });
    const rejectedSettlementFailure =
      rejectedSettlementFailureRef.current;
    if (rejectedSettlementFailure !== null) {
      let didRecover = rejectedSettlementFailure.retry();
      if (!didRecover && pendingSubmissionOwnership !== null) {
        didRecover = settleDetachedChatPendingSubmissionOwnership(
          pendingSubmissionOwnership,
        );
      }
      if (!didRecover) {
        if (!isChatLayoutScopeCurrent(chatLayoutScopeToken)) {
          return;
        }
        throw new Error(
          "Rejected chat submission settlement became stale before recovery",
        );
      }
      throw new Error(
        `Rejected chat submission settlement failed after controller `
        + `finalization and was recovered: `
        + `${rejectedSettlementFailure.error.message}`,
      );
    }
    const unresolvedSettlementFailure =
      unresolvedSettlementFailureRef.current;
    if (unresolvedSettlementFailure !== null) {
      let didRecover = unresolvedSettlementFailure.retry();
      if (!didRecover && pendingSubmissionOwnership !== null) {
        didRecover = settleDetachedChatPendingSubmissionOwnership(
          pendingSubmissionOwnership,
        );
      }
      if (!didRecover) {
        if (!isChatLayoutScopeCurrent(chatLayoutScopeToken)) {
          return;
        }
        throw new Error(
          "Unresolved chat submission settlement became stale before recovery",
        );
      }
      throw new Error(
        `Unresolved chat submission settlement failed after controller `
        + `finalization and was recovered: `
        + `${unresolvedSettlementFailure.error.message}`,
      );
    }
    const detachedSettlementFailure = detachedSettlementFailureRef.current;
    if (detachedSettlementFailure !== null) {
      if (!isChatLayoutScopeCurrent(chatLayoutScopeToken)) {
        return;
      }
      throw new Error(
        `Detached chat submission settlement failed after controller `
        + `finalization: ${detachedSettlementFailure.message}`,
      );
    }
  }, [
    canSendPendingMessage,
    chatTargetKey,
    chatLayoutScopeToken,
    chatWorkspace.selectionEpoch,
    chatWorkspace.state.target,
    inputText,
    isChatLayoutScopeCurrent,
    createChatPendingSubmissionForTarget,
    registerChatPendingSubmissionOwnership,
    releaseChatPendingSubmissionOwnership,
    settleRejectedChatPendingSubmissionOwnership,
    settleUnresolvedChatPendingSubmissionOwnership,
    settleDetachedChatPendingSubmissionOwnership,
    sendMessage,
    setChatComposerMemoryForTarget,
    setInputText,
  ]);

  const handleInputChange = useCallback((value: string): void => {
    const target = chatWorkspace.state.target;
    promoteSelectedTargetToExplicit(target);
    setChatDraftTextForTarget(target, value);
    setChatComposerMemoryForTarget(target, markChatComposerContentEdited);
  }, [
    chatWorkspace.state.target,
    promoteSelectedTargetToExplicit,
    setChatComposerMemoryForTarget,
    setChatDraftTextForTarget,
  ]);

  const handleCopyTranscript = useCallback(async (): Promise<void> => {
    const scopeToken = chatLayoutScopeToken;
    try {
      const { markdown } = await buildChatTranscriptMarkdown({
        messages,
        runState,
        exportedAt: Date.now(),
        t: (key, params) => t(key, params),
      });
      await navigator.clipboard.writeText(markdown);
      if (!isChatLayoutScopeCurrent(scopeToken)) {
        return;
      }
      setCopyStatus("success");
    } catch {
      if (!isChatLayoutScopeCurrent(scopeToken)) {
        return;
      }
      setCopyStatus("error");
    }

    if (copyStatusResetRef.current !== null) {
      clearTimeout(copyStatusResetRef.current);
    }
    copyStatusResetRef.current = setTimeout(() => {
      copyStatusResetRef.current = null;
      if (!isChatLayoutScopeCurrent(scopeToken)) {
        return;
      }
      setCopyStatus("idle");
    }, 1500);
  }, [
    chatLayoutScopeToken,
    isChatLayoutScopeCurrent,
    messages,
    runState,
    t,
  ]);

  const handleCreateDraft = useCallback((): void => {
    retryDetachedChatPendingSubmissionDisposals();
    const isUntouched =
      isSelectedWorkspaceDraftUntouched && messages.length === 0;
    const result = isUntouched
      ? reuseSelectedChatDraft()
      : replaceSelectedChatTargetWithDraft();
    cancelDictationOperation();
    if (result.disposedTarget !== null) {
      invalidateAttachmentOperationForTarget(result.disposedTarget);
    }
    requestComposerFocusAfterNew(
      result.sourceTarget,
      result.sourceSelectionEpoch,
      result.target,
      result.selectionEpoch,
    );
  }, [
    cancelDictationOperation,
    invalidateAttachmentOperationForTarget,
    isSelectedWorkspaceDraftUntouched,
    messages.length,
    replaceSelectedChatTargetWithDraft,
    requestComposerFocusAfterNew,
    reuseSelectedChatDraft,
    retryDetachedChatPendingSubmissionDisposals,
  ]);

  const copyButtonLabel = copyStatus === "success"
    ? t("chat.copied")
    : copyStatus === "error"
      ? t("chat.copyFailed")
      : t("chat.copyTranscript");
  const transcriptActionsDisabled = !isHistoryLoaded || messages.length === 0;
  const dictationStatusLabel = dictationState === "requesting_permission"
    ? t("chat.dictationWaitingPermission")
    : dictationState === "recording"
      ? t("chat.dictationRecording")
      : dictationState === "transcribing"
        ? t("chat.dictationTranscribing")
        : null;

  const rootClass = mode === "sidebar" ? styles.sidebar : styles.sidebarFullscreen;
  const sidebarStyle = mode === "sidebar" ? { width: localWidth } : undefined;

  return (
    <div
      className={rootClass}
      data-testid="chat-panel"
      style={sidebarStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {isDragOver && composerCapabilities.isDropTargetEnabled && (
        <div className={styles.dropOverlay} data-testid="chat-drop-overlay">
          {t("chat.dropFiles")}
        </div>
      )}
      {mode === "sidebar" && (
        <div
          className={cn(styles.resizeHandle, isDragging ? styles.resizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
      )}
      <ChatPanelHeader
        mode={mode}
        transcriptActionsDisabled={transcriptActionsDisabled}
        copyButtonLabel={copyButtonLabel}
        historyOpen={chatWorkspace.historyOpen}
        historySessions={chatWorkspace.state.summaries}
        selectedSessionId={chatWorkspace.state.target.kind === "session"
          ? chatWorkspace.state.target.sessionId
          : null}
        runningCount={chatWorkspace.runningCount}
        historyLoading={chatWorkspace.state.catalogRequest.isLoading}
        historyHasLoadedFirstPage={
          chatWorkspace.state.pagination.hasLoadedFirstPage
        }
        historyHasMore={chatWorkspace.state.pagination.nextCursor !== null}
        historyErrorMessage={chatWorkspace.historyErrorMessage}
        onCopyTranscript={() => void handleCopyTranscript()}
        onCreateDraft={handleCreateDraft}
        onHistoryOpenChange={chatWorkspace.setHistoryOpen}
        onSelectSession={chatWorkspace.selectSession}
        onLoadMoreHistory={() => void chatWorkspace.loadNextCatalogPage()}
        onCloseSidebar={() => setIsOpen(false)}
      />
      <ChatTranscript
        messages={messages}
        isAssistantRunActive={isAssistantRunActive}
        isLiveStreamConnected={isLiveStreamConnected}
      />
      <ChatComposer
        key={composerLifecycleKey}
        inputText={inputText}
        pendingAttachments={pendingAttachments}
        attachmentErrors={attachmentErrors}
        isAttachmentProcessing={isAttachmentProcessing}
        composerAction={composerAction}
        dictationState={dictationState}
        dictationStatusLabel={dictationStatusLabel}
        capabilities={composerCapabilities}
        accountSuggestionsState={accountSuggestionsState}
        textareaRef={textareaRef}
        onInputChange={handleInputChange}
        onIngestFiles={ingestFiles}
        onPrepareDeferredIngestion={prepareDeferredAttachmentIngestion}
        onRemoveAttachment={removeAttachment}
        onToggleDictation={handleToggleDictation}
        onSend={sendPendingMessage}
        onStop={stopMessage}
      />
    </div>
  );
};
