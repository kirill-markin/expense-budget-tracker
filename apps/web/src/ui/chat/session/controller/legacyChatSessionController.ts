"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "next/navigation";

import {
  useChatHistory,
  type StoredMessage,
} from "@/ui/hooks/useChatHistory";
import type { ContentPart } from "@/server/chat/types";
import type { PendingAttachment } from "../../shell/panel/FileAttachment";
import {
  createChatBootstrapLocalState,
  deriveLastUserMessageAt,
  readChatBootstrapLocalState,
  readChatBootstrapLocalStateFromStorageEvent,
  resolveChatBootstrapMode,
  writeChatBootstrapLocalState,
} from "../bootstrap/chatBootstrapLocalState";
import type { ChatSessionSnapshot } from "../bootstrap/chatSessionSnapshot";
import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
  shouldSuppressStreamFailure,
  type ChatComposerAction,
  type ChatRunState,
} from "../../stream/streamRecovery";
import {
  assertCanonicalChatTurnId,
  beginChatSnapshotRequest,
  buildChatSendRequestBody,
  buildFailedChatSendHistory,
  buildPendingChatSendHistory,
  buildStoppedChatSendHistory,
  classifyConfirmedChatStopSnapshotFailure,
  completeChatTurnCancellation,
  createChatSession,
  createSingleFlightChatClearOperationRunner,
  createSingleFlightChatSendReconciliationRunner,
  createSingleFlightChatTurnCancellationRunner,
  createChatSnapshotRequestCoordinator,
  createSingleFlightChatSnapshotPoller,
  deleteChatConversation,
  fetchChatSessionSnapshot,
  isDefinitiveChatRequestRejection,
  isChatClearOperationOwnerCurrent,
  isChatPreSessionSendOwnerCurrent,
  isChatSnapshotPollingOwnerCurrent,
  isChatSendReconciliationOwnerCurrent,
  isChatStopOperationOwnerCurrent,
  isChatStopSettlementOwned,
  isChatTurnOwnerForSession,
  isChatTurnCancellationSettlementOwned,
  postStopChatSession,
  prepareChatSendRequest,
  reconcileConfirmedChatStopSnapshot,
  resolveChatExactTurnOwnership,
  resolveChatPreSessionSendAdoption,
  resolveChatSendReconciliationDisposition,
  resolveDefinitiveChatSendSnapshotFailureHistory,
  resolveConfirmedChatStopSnapshotDisposition,
  resolveConfirmedChatTurnStopHistory,
  resolveChatSnapshotRequest,
  restorePendingChatTurnAfterCancellationRejection,
  shouldRestoreChatRunAfterSnapshotFailure,
  shouldRestoreChatTurnAfterCancellationRejection,
  streamChatResponse,
  type ChatSendReconciliationOwner,
  type ChatSendReconciliationRunner,
  type ChatClearOperationOwner,
  type ChatClearOperationRunner,
  type ChatConfirmedStopSnapshotResolution,
  type ChatPreSessionSendOwner,
  type ChatStopOperationOwner,
  type ChatTurnCancellationResolution,
  type ChatTurnCancellationRunner,
  type ExactTurnStopChatSessionResponse,
} from "./chatSessionControllerRuntime";
import {
  createInitialChatSessionControllerState,
  reduceChatSessionControllerState,
  selectComposerAction,
  selectEffectiveSnapshotRunState,
  selectIsAssistantRunActive,
  selectIsSelectedSessionStopping,
  shouldRefreshMainContentForVersion,
  shouldReplaceHistoryForSnapshot,
  type ChatMainContentInvalidationSource,
  type ChatSessionControllerAction,
} from "./chatSessionControllerState";
import {
  getMainContentInvalidationSourceId,
  publishMainContentInvalidation,
} from "../invalidation/mainContentInvalidationChannel";

type UseChatSessionControllerParams = Readonly<{
  mode: "sidebar" | "fullscreen";
  workspaceId: string;
}>;

export type SendChatMessageParams = Readonly<{
  text: string;
  attachments: ReadonlyArray<PendingAttachment>;
}>;

export type ChatSessionController = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  runState: ChatRunState;
  isHistoryLoaded: boolean;
  isAssistantRunActive: boolean;
  isLiveStreamConnected: boolean;
  isStopping: boolean;
  currentSessionId: string | null;
  composerAction: ChatComposerAction;
  acceptServerSessionId: (sessionId: string) => void;
  ensureWritableSessionId: () => Promise<string>;
  sendMessage: (params: SendChatMessageParams) => Promise<void>;
  stopMessage: () => Promise<void>;
  clearConversation: () => Promise<void>;
}>;

type NormalizedChatSessionSnapshot = Readonly<{
  sessionId: string;
  runState: ChatRunState;
  authoritativeRunState: ChatRunState;
  activeTurnId: string | null;
  updatedAt: number;
  mainContentInvalidationVersion: number;
  messages: ChatSessionSnapshot["messages"];
}>;

type ChatSnapshotLoadResult =
  | Readonly<{
    kind: "applied";
    snapshot: NormalizedChatSessionSnapshot;
  }>
  | Readonly<{
    kind: "superseded";
    snapshot: NormalizedChatSessionSnapshot | null;
  }>;

type PendingChatTurn = ChatSendReconciliationOwner & Readonly<{
  requestBody: string;
  submittedContent: ReadonlyArray<ContentPart>;
  authoritativeMessages: ReadonlyArray<StoredMessage>;
  retryAbortController: AbortController;
}>;

type PendingChatTurnCancellation = ChatSendReconciliationOwner;

type ConfirmedChatTurnCancellation =
  ChatSendReconciliationOwner & Readonly<{
    response: ExactTurnStopChatSessionResponse;
  }>;

type PreSessionChatTurn = ChatPreSessionSendOwner & Readonly<{
  authoritativeMessages: ReadonlyArray<StoredMessage>;
  retryAbortController: AbortController;
  submittedContent: ReadonlyArray<ContentPart>;
}>;

type ChatStopSnapshotReconciliationOwner = Readonly<{
  ownerId: symbol;
  sessionId: string;
  abortController: AbortController;
}>;

type IsChatOperationOwnerCurrent = () => boolean;

const toExactChatTurnOwner = (
  preSessionChatTurn: PreSessionChatTurn | null,
): ChatSendReconciliationOwner | null => {
  if (
    preSessionChatTurn === null
    || preSessionChatTurn.initialSessionId === null
  ) {
    return null;
  }

  return {
    ownerId: preSessionChatTurn.ownerId,
    sessionId: preSessionChatTurn.initialSessionId,
    turnId: preSessionChatTurn.turnId,
  };
};

const isPendingChatTurnForSession = (
  pendingChatTurn: PendingChatTurn | null,
  sessionId: string | null,
): boolean =>
  pendingChatTurn !== null
  && pendingChatTurn.sessionId === sessionId;

const isPendingChatTurnOwnerCurrent = (
  pendingChatTurn: PendingChatTurn,
  currentPendingChatTurn: PendingChatTurn | null,
  currentSessionId: string | null,
): boolean =>
  !pendingChatTurn.retryAbortController.signal.aborted
  && isChatSendReconciliationOwnerCurrent(
    pendingChatTurn,
    currentPendingChatTurn,
    currentSessionId,
  );

const waitForChatReconciliationRetry = (
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const finish = (): void => {
      window.clearTimeout(intervalId);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const intervalId = window.setTimeout(
      finish,
      ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
    );
    signal.addEventListener("abort", finish, { once: true });
  });
};

const shouldAlwaysAdoptChatSnapshot = (
  _snapshot: ChatSessionSnapshot,
): boolean => true;

export const useChatSessionController = (
  params: UseChatSessionControllerParams,
): ChatSessionController => {
  const { mode, workspaceId } = params;
  const { t } = useTranslation();
  const router = useRouter();
  const {
    messages,
    replaceMessages,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    upsertReasoningSummary,
    upsertToolCall,
    finalizeAssistant,
    markAssistantError,
    clearHistory,
  } = useChatHistory();

  const [state, dispatch] = useReducer(
    reduceChatSessionControllerState,
    undefined,
    createInitialChatSessionControllerState,
  );
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  const pendingSessionIdRef = useRef<Promise<string> | null>(null);
  const preSessionChatTurnRef = useRef<PreSessionChatTurn | null>(null);
  const pendingChatTurnRef = useRef<PendingChatTurn | null>(null);
  const activeChatTurnRef = useRef<ChatSendReconciliationOwner | null>(null);
  const pendingChatTurnCancellationRef =
    useRef<PendingChatTurnCancellation | null>(null);
  const confirmedChatTurnCancellationRef =
    useRef<ConfirmedChatTurnCancellation | null>(null);
  const clearOperationRef = useRef<ChatClearOperationOwner | null>(null);
  const stopOperationRef = useRef<ChatStopOperationOwner | null>(null);
  const stopSnapshotReconciliationRef =
    useRef<ChatStopSnapshotReconciliationOwner | null>(null);
  const invalidationSourceIdRef = useRef<string | null>(null);
  const snapshotRequestCoordinatorRef = useRef(
    createChatSnapshotRequestCoordinator(),
  );

  const dispatchAction = useCallback((
    action: ChatSessionControllerAction,
  ): void => {
    stateRef.current = reduceChatSessionControllerState(stateRef.current, action);
    dispatch(action);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const isAssistantRunActive = selectIsAssistantRunActive(state);
  const composerAction = selectComposerAction(state);

  const getInvalidationSourceId = useCallback((): string => {
    if (invalidationSourceIdRef.current === null) {
      invalidationSourceIdRef.current = getMainContentInvalidationSourceId();
    }

    return invalidationSourceIdRef.current;
  }, []);

  const refreshMainContent = useCallback((nextVersion: number): void => {
    publishMainContentInvalidation({
      workspaceId,
      version: nextVersion,
      sourceId: getInvalidationSourceId(),
      emittedAt: Date.now(),
    });

    if (mode === "sidebar") {
      startTransition(() => {
        router.refresh();
      });
    }
  }, [getInvalidationSourceId, mode, router, workspaceId]);

  const applyMainContentInvalidationVersion = useCallback((
    nextVersion: number,
    source: ChatMainContentInvalidationSource,
  ): void => {
    const currentState = stateRef.current;
    const shouldRefresh = shouldRefreshMainContentForVersion(
      currentState,
      source,
      nextVersion,
    );

    dispatchAction({
      type: "main_content_invalidation_observed",
      version: nextVersion,
    });

    if (!shouldRefresh) {
      return;
    }

    refreshMainContent(nextVersion);
  }, [dispatchAction, refreshMainContent]);

  const loadChatSnapshot = useCallback(async (
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    replaceHistory: boolean,
    shouldAdoptSnapshot: (snapshot: ChatSessionSnapshot) => boolean,
  ): Promise<ChatSnapshotLoadResult> => {
    const snapshotPromise = fetchChatSessionSnapshot(sessionId, signal, t);
    const snapshotRequest = beginChatSnapshotRequest(
      snapshotRequestCoordinatorRef.current,
      sessionId ?? stateRef.current.currentSessionId ?? workspaceId,
      0,
      snapshotPromise,
    );
    snapshotRequestCoordinatorRef.current = snapshotRequest.coordinator;

    const resolution = await resolveChatSnapshotRequest(
      () => snapshotRequestCoordinatorRef.current,
      {
        request: snapshotRequest.request,
        snapshot: snapshotPromise,
      },
    );
    if (resolution.snapshot === null) {
      return {
        kind: "superseded",
        snapshot: null,
      };
    }

    const payload = resolution.snapshot;
    if (resolution.kind === "superseded") {
      return {
        kind: "superseded",
        snapshot: {
          ...payload,
          authoritativeRunState: payload.runState,
          runState: selectEffectiveSnapshotRunState(
            stateRef.current,
            payload.sessionId,
            payload.runState,
          ),
        },
      };
    }
    if (!shouldAdoptSnapshot(payload)) {
      return {
        kind: "superseded",
        snapshot: null,
      };
    }
    const pendingChatTurn = pendingChatTurnRef.current;
    if (
      pendingChatTurn !== null
      && pendingChatTurn.sessionId === payload.sessionId
      && resolveChatSendReconciliationDisposition(
        pendingChatTurn.turnId,
        payload,
      ) === "acceptance_unknown"
    ) {
      return {
        kind: "superseded",
        snapshot: {
          ...payload,
          authoritativeRunState: payload.runState,
          runState: selectEffectiveSnapshotRunState(
            stateRef.current,
            payload.sessionId,
            payload.runState,
          ),
        },
      };
    }
    const exactTurnOwnership = resolveChatExactTurnOwnership(
      payload,
      pendingChatTurnRef.current,
      activeChatTurnRef.current,
      pendingChatTurnCancellationRef.current,
    );
    if (exactTurnOwnership.pendingTurn === null) {
      pendingChatTurnRef.current = null;
    }
    activeChatTurnRef.current = exactTurnOwnership.activeTurn;
    const currentExactTurn = pendingChatTurnRef.current
      ?? activeChatTurnRef.current;
    if (
      pendingChatTurnCancellationRef.current !== null
      && currentExactTurn?.ownerId
        !== pendingChatTurnCancellationRef.current.ownerId
    ) {
      pendingChatTurnCancellationRef.current = null;
    }
    const confirmedCancellation = confirmedChatTurnCancellationRef.current;
    if (
      confirmedCancellation?.sessionId === payload.sessionId
      && (
        payload.runState !== "running"
        || payload.activeTurnId !== confirmedCancellation.turnId
      )
    ) {
      confirmedChatTurnCancellationRef.current = null;
    }

    const currentState = stateRef.current;
    const shouldRefresh = shouldRefreshMainContentForVersion(
      currentState,
      "snapshot",
      payload.mainContentInvalidationVersion,
    );
    const shouldReplaceHistory = replaceHistory
      && shouldReplaceHistoryForSnapshot(currentState, payload.updatedAt);
    const effectiveRunState = selectEffectiveSnapshotRunState(
      currentState,
      payload.sessionId,
      payload.runState,
    );

    dispatchAction({
      type: "snapshot_applied",
      sessionId: payload.sessionId,
      runState: payload.runState,
      updatedAt: payload.updatedAt,
      mainContentInvalidationVersion: payload.mainContentInvalidationVersion,
    });

    if (shouldReplaceHistory) {
      replaceMessages(payload.messages);
    }

    if (shouldRefresh) {
      refreshMainContent(payload.mainContentInvalidationVersion);
    }

    return {
      kind: "applied",
      snapshot: {
        ...payload,
        authoritativeRunState: payload.runState,
        runState: effectiveRunState,
      },
    };
  }, [dispatchAction, refreshMainContent, replaceMessages, t, workspaceId]);

  const reconcileConfirmedStopSnapshotForOwner = useCallback(async (
    sessionId: string,
    turnId: string | null,
    operationSignal: AbortSignal,
    isOperationOwnerCurrent: IsChatOperationOwnerCurrent,
  ): Promise<
    ChatConfirmedStopSnapshotResolution<NormalizedChatSessionSnapshot>
  > => {
    stopSnapshotReconciliationRef.current?.abortController.abort();
    const reconciliationOwner: ChatStopSnapshotReconciliationOwner = {
      ownerId: Symbol(sessionId),
      sessionId,
      abortController: new AbortController(),
    };
    stopSnapshotReconciliationRef.current = reconciliationOwner;
    const abortReconciliation = (): void => {
      reconciliationOwner.abortController.abort();
    };
    if (operationSignal.aborted) {
      abortReconciliation();
    } else {
      operationSignal.addEventListener(
        "abort",
        abortReconciliation,
        { once: true },
      );
    }
    const isReconciliationOwnerCurrent = (): boolean =>
      !operationSignal.aborted
      && !reconciliationOwner.abortController.signal.aborted
      && stopSnapshotReconciliationRef.current?.ownerId
        === reconciliationOwner.ownerId
      && stateRef.current.currentSessionId === sessionId
      && isOperationOwnerCurrent();
    const shouldAdoptSnapshot = (
      _snapshot: ChatSessionSnapshot,
    ): boolean =>
      isReconciliationOwnerCurrent();

    try {
      return await reconcileConfirmedChatStopSnapshot({
        signal: reconciliationOwner.abortController.signal,
        isOwnerCurrent: isReconciliationOwnerCurrent,
        loadSnapshot: async (
          signal,
        ): Promise<NormalizedChatSessionSnapshot | null> => {
          const snapshotResult = await loadChatSnapshot(
            sessionId,
            signal,
            true,
            shouldAdoptSnapshot,
          );
          return snapshotResult.snapshot;
        },
        resolveSnapshot: (snapshot) =>
          resolveConfirmedChatStopSnapshotDisposition(
            turnId,
            {
              runState: snapshot.authoritativeRunState,
              activeTurnId: snapshot.activeTurnId,
            },
          ),
        classifyFailure: classifyConfirmedChatStopSnapshotFailure,
        waitForRetry: waitForChatReconciliationRetry,
      });
    } finally {
      operationSignal.removeEventListener("abort", abortReconciliation);
      if (
        stopSnapshotReconciliationRef.current?.ownerId
        === reconciliationOwner.ownerId
      ) {
        stopSnapshotReconciliationRef.current = null;
      }
    }
  }, [loadChatSnapshot]);

  const performPendingChatTurnCycle = useCallback(async (
    pendingChatTurn: PendingChatTurn,
    attemptAbortController: AbortController,
  ): Promise<void> => {
    const abortAttempt = (): void => {
      attemptAbortController.abort();
    };
    if (pendingChatTurn.retryAbortController.signal.aborted) {
      return;
    }
    pendingChatTurn.retryAbortController.signal.addEventListener(
      "abort",
      abortAttempt,
      { once: true },
    );

    const isOwnerCurrent = (): boolean =>
      isPendingChatTurnOwnerCurrent(
        pendingChatTurn,
        pendingChatTurnRef.current,
        stateRef.current.currentSessionId,
      );

    try {
      if (!isOwnerCurrent()) {
        return;
      }

      replaceMessages(buildPendingChatSendHistory(
        pendingChatTurn.authoritativeMessages,
        pendingChatTurn.submittedContent,
        Date.now(),
      ));
      abortRef.current = attemptAbortController;
      const streamResult = await streamChatResponse({
        url: "/api/chat",
        requestBody: pendingChatTurn.requestBody,
        signal: attemptAbortController.signal,
        abortStream: (): void => {
          attemptAbortController.abort();
        },
        t,
        handlers: {
          appendAssistantChunk: (text, streamPosition): void => {
            if (isOwnerCurrent()) {
              appendAssistantChunk(text, streamPosition);
            }
          },
          upsertReasoningSummary: (reasoningSummary): void => {
            if (isOwnerCurrent()) {
              upsertReasoningSummary(reasoningSummary);
            }
          },
          upsertToolCall: (toolCall): void => {
            if (isOwnerCurrent()) {
              upsertToolCall(toolCall);
            }
          },
          markAssistantError: (errorMessage): void => {
            if (isOwnerCurrent()) {
              markAssistantError(errorMessage);
            }
          },
          applyMainContentInvalidationVersion: (nextVersion): void => {
            if (isOwnerCurrent()) {
              applyMainContentInvalidationVersion(nextVersion, "live");
            }
          },
        },
        onSessionIdReceived: (sessionId): void => {
          if (isOwnerCurrent() && sessionId === pendingChatTurn.sessionId) {
            dispatchAction({
              type: "server_session_accepted",
              sessionId,
            });
          }
        },
        onLiveStreamConnected: (): void => {
          if (!isOwnerCurrent()) {
            return;
          }
          dispatchAction({ type: "live_stream_connected" });
        },
      });

      if (!isOwnerCurrent()) {
        return;
      }
      if (streamResult.receivedContent) {
        finalizeAssistant();
      }
      dispatchAction({ type: "live_stream_disconnected" });

      if (
        isDefinitiveChatRequestRejection(streamResult)
        && !streamResult.wasAborted
      ) {
        const requestFailureMessage = streamResult.streamFailure === null
          ? t("chat.errorNoResponse")
          : streamResult.streamFailure.message;
        pendingChatTurnRef.current = null;
        replaceMessages(buildFailedChatSendHistory(
          pendingChatTurn.authoritativeMessages,
          pendingChatTurn.submittedContent,
          requestFailureMessage,
          Date.now(),
        ));
        dispatchAction({ type: "run_finished" });
        return;
      }

      if (streamResult.wasAborted) {
        return;
      }

      try {
        const snapshotResult = await loadChatSnapshot(
          pendingChatTurn.sessionId,
          attemptAbortController.signal,
          true,
          (): boolean => isOwnerCurrent(),
        );
        if (!isOwnerCurrent()) {
          return;
        }
        if (snapshotResult.snapshot === null) {
          if (streamResult.streamFailure !== null) {
            markAssistantError(t("chat.errorFailed", {
              message: streamResult.streamFailure.message,
            }));
          }
          return;
        }
        const reconciliationDisposition = resolveChatSendReconciliationDisposition(
          pendingChatTurn.turnId,
          snapshotResult.snapshot,
        );
        if (reconciliationDisposition === "acceptance_unknown") {
          if (streamResult.streamFailure !== null) {
            markAssistantError(t("chat.errorFailed", {
              message: streamResult.streamFailure.message,
            }));
          }
          return;
        }
        if (shouldSuppressStreamFailure(snapshotResult.snapshot)) {
          return;
        }
      } catch (error) {
        if (!isOwnerCurrent()) {
          return;
        }
        const snapshotFailureMessage = error instanceof Error
          ? error.message
          : String(error);
        const failedHistory =
          resolveDefinitiveChatSendSnapshotFailureHistory(
            error,
            pendingChatTurn,
            pendingChatTurnRef.current,
            stateRef.current.currentSessionId,
            t("chat.errorFailed", { message: snapshotFailureMessage }),
            Date.now(),
          );
        if (failedHistory !== null) {
          pendingChatTurnRef.current = null;
          replaceMessages(failedHistory);
          dispatchAction({ type: "run_finished" });
          return;
        }
        const retryableFailureMessage = streamResult.streamFailure?.message
          ?? snapshotFailureMessage;
        markAssistantError(t("chat.errorFailed", {
          message: retryableFailureMessage,
        }));
        return;
      }

      if (
        streamResult.streamFailure !== null
        && isOwnerCurrent()
      ) {
        markAssistantError(t("chat.errorFailed", {
          message: streamResult.streamFailure.message,
        }));
      }
    } finally {
      pendingChatTurn.retryAbortController.signal.removeEventListener(
        "abort",
        abortAttempt,
      );
      if (
        abortRef.current === attemptAbortController
        && !pendingChatTurn.retryAbortController.signal.aborted
      ) {
        abortRef.current = null;
      }
    }
  }, [
    appendAssistantChunk,
    applyMainContentInvalidationVersion,
    dispatchAction,
    finalizeAssistant,
    loadChatSnapshot,
    markAssistantError,
    replaceMessages,
    t,
    upsertReasoningSummary,
    upsertToolCall,
  ]);

  const performPendingChatTurnCycleRef = useRef(performPendingChatTurnCycle);
  performPendingChatTurnCycleRef.current = performPendingChatTurnCycle;
  const pendingChatTurnRunnerRef = useRef<
    ChatSendReconciliationRunner<PendingChatTurn> | null
  >(null);
  if (pendingChatTurnRunnerRef.current === null) {
    pendingChatTurnRunnerRef.current =
      createSingleFlightChatSendReconciliationRunner(
        (pendingChatTurn, abortController): Promise<void> =>
          performPendingChatTurnCycleRef.current(
            pendingChatTurn,
            abortController,
          ),
      );
  }
  const pendingChatTurnRunner = pendingChatTurnRunnerRef.current;

  const performPendingChatTurnCancellation = useCallback(async (
    cancellation: PendingChatTurnCancellation,
    attemptAbortController: AbortController,
  ): Promise<ChatTurnCancellationResolution> =>
    completeChatTurnCancellation({
      signal: attemptAbortController.signal,
      isOwnerCurrent: (): boolean =>
        isChatTurnCancellationSettlementOwned(
          cancellation,
          pendingChatTurnCancellationRef.current,
          pendingChatTurnRef.current
            ?? toExactChatTurnOwner(preSessionChatTurnRef.current)
            ?? activeChatTurnRef.current,
          stateRef.current.currentSessionId,
        ),
      requestCancellation: (signal) =>
        postStopChatSession(
          cancellation.sessionId,
          cancellation.turnId,
          signal,
          t,
        ),
      waitForRetry: waitForChatReconciliationRetry,
      clearCancellationAttempt: (): void => {
        if (
          pendingChatTurnCancellationRef.current?.ownerId
          === cancellation.ownerId
        ) {
          pendingChatTurnCancellationRef.current = null;
        }
      },
      clearExactTurnOwnership: (): void => {
        if (pendingChatTurnRef.current?.ownerId === cancellation.ownerId) {
          pendingChatTurnRef.current = null;
        }
        if (activeChatTurnRef.current?.ownerId === cancellation.ownerId) {
          activeChatTurnRef.current = null;
        }
        if (preSessionChatTurnRef.current?.ownerId === cancellation.ownerId) {
          preSessionChatTurnRef.current = null;
        }
      },
    }), [t]);
  const performPendingChatTurnCancellationRef =
    useRef(performPendingChatTurnCancellation);
  performPendingChatTurnCancellationRef.current =
    performPendingChatTurnCancellation;
  const pendingChatTurnCancellationRunnerRef = useRef<
    ChatTurnCancellationRunner<PendingChatTurnCancellation> | null
  >(null);
  if (pendingChatTurnCancellationRunnerRef.current === null) {
    pendingChatTurnCancellationRunnerRef.current =
      createSingleFlightChatTurnCancellationRunner(
        (cancellation, abortController) =>
          performPendingChatTurnCancellationRef.current(
            cancellation,
            abortController,
          ),
      );
  }
  const pendingChatTurnCancellationRunner =
    pendingChatTurnCancellationRunnerRef.current;

  const cancelExactChatTurn = useCallback(async (
    exactChatTurn: ChatSendReconciliationOwner,
  ): Promise<ChatTurnCancellationResolution> => {
    const confirmedCancellation =
      confirmedChatTurnCancellationRef.current;
    if (
      confirmedCancellation?.sessionId === exactChatTurn.sessionId
      && confirmedCancellation.turnId === exactChatTurn.turnId
    ) {
      return {
        kind: "confirmed",
        response: confirmedCancellation.response,
      };
    }

    const pendingChatTurn = pendingChatTurnRef.current;
    if (pendingChatTurn?.ownerId === exactChatTurn.ownerId) {
      pendingChatTurn.retryAbortController.abort();
      pendingChatTurnRunner.cancel(pendingChatTurn);
    }

    const existingCancellation = pendingChatTurnCancellationRef.current;
    const cancellation = existingCancellation?.ownerId === exactChatTurn.ownerId
      ? existingCancellation
      : {
        ownerId: exactChatTurn.ownerId,
        sessionId: exactChatTurn.sessionId,
        turnId: exactChatTurn.turnId,
      };
    pendingChatTurnCancellationRef.current = cancellation;

    const resolution =
      await pendingChatTurnCancellationRunner.run(cancellation);
    if (
      resolution.kind === "confirmed"
      && stateRef.current.currentSessionId === exactChatTurn.sessionId
    ) {
      const currentExactTurn = pendingChatTurnRef.current
        ?? toExactChatTurnOwner(preSessionChatTurnRef.current)
        ?? activeChatTurnRef.current;
      if (
        currentExactTurn?.sessionId === exactChatTurn.sessionId
        && currentExactTurn.turnId !== exactChatTurn.turnId
      ) {
        return { kind: "superseded" };
      }
      confirmedChatTurnCancellationRef.current = {
        ...exactChatTurn,
        response: resolution.response,
      };
    }
    return resolution;
  }, [pendingChatTurnCancellationRunner, pendingChatTurnRunner]);

  const restoreChatTurnAfterCancellationRejection = useCallback((
    error: unknown,
    rejectedTurn: ChatSendReconciliationOwner,
  ): void => {
    const currentPendingTurn = pendingChatTurnRef.current;
    const currentPreSessionTurn = preSessionChatTurnRef.current;
    const currentPreSessionExactTurn = toExactChatTurnOwner(
      currentPreSessionTurn,
    );
    const currentTurn = currentPendingTurn
      ?? currentPreSessionExactTurn
      ?? activeChatTurnRef.current;
    const currentSessionId = stateRef.current.currentSessionId;
    if (!shouldRestoreChatTurnAfterCancellationRejection(
      error,
      rejectedTurn,
      currentTurn,
      currentSessionId,
    )) {
      return;
    }

    const restoredPendingTurn =
      restorePendingChatTurnAfterCancellationRejection(
        error,
        rejectedTurn,
        currentPendingTurn,
        currentSessionId,
      );
    if (restoredPendingTurn !== null) {
      pendingChatTurnRef.current = restoredPendingTurn;
    } else if (
      currentPreSessionTurn !== null
      && currentPreSessionExactTurn?.ownerId === rejectedTurn.ownerId
      && currentPreSessionTurn.initialSessionId !== null
    ) {
      const resumablePendingTurn: PendingChatTurn = {
        ownerId: currentPreSessionTurn.ownerId,
        sessionId: currentPreSessionTurn.initialSessionId,
        turnId: currentPreSessionTurn.turnId,
        requestBody: buildChatSendRequestBody(
          currentPreSessionTurn.submittedContent,
          currentPreSessionTurn.initialSessionId,
          currentPreSessionTurn.turnId,
        ),
        submittedContent: currentPreSessionTurn.submittedContent,
        authoritativeMessages: currentPreSessionTurn.authoritativeMessages,
        retryAbortController: currentPreSessionTurn.retryAbortController,
      };
      const restoredPreSessionTurn =
        restorePendingChatTurnAfterCancellationRejection(
          error,
          rejectedTurn,
          resumablePendingTurn,
          currentSessionId,
        );
      if (restoredPreSessionTurn !== null) {
        preSessionChatTurnRef.current = null;
        pendingChatTurnRef.current = restoredPreSessionTurn;
      }
    }

    dispatchAction({ type: "run_started" });
  }, [dispatchAction]);

  const releaseSupersededExactTurnStop = useCallback((
    exactChatTurn: ChatSendReconciliationOwner,
  ): void => {
    dispatchAction({
      type: "stop_completed",
      sessionId: exactChatTurn.sessionId,
    });
    const activeChatTurn = activeChatTurnRef.current;
    if (
      activeChatTurn?.sessionId === exactChatTurn.sessionId
      && activeChatTurn.ownerId !== exactChatTurn.ownerId
    ) {
      dispatchAction({ type: "run_started" });
    }
  }, [dispatchAction]);

  const performClearOperation = useCallback(async (
    owner: ChatClearOperationOwner,
    attemptAbortController: AbortController,
  ): Promise<void> => {
    const isOwnerCurrent = (): boolean =>
      !attemptAbortController.signal.aborted
      && isChatClearOperationOwnerCurrent(
        owner,
        clearOperationRef.current,
        stateRef.current.currentSessionId,
      );

    if (!isOwnerCurrent()) {
      return;
    }
    if (owner.targetSessionId !== null) {
      dispatchAction({
        type: "stop_requested",
        sessionId: owner.targetSessionId,
      });
    }

    const preSessionChatTurn = preSessionChatTurnRef.current;
    if (
      preSessionChatTurn !== null
      && preSessionChatTurn.initialSessionId === null
    ) {
      preSessionChatTurn.retryAbortController.abort();
      preSessionChatTurnRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      if (!isOwnerCurrent()) {
        return;
      }
      dispatchAction({ type: "live_stream_disconnected" });
      dispatchAction({ type: "run_finished" });
      clearHistory();
      return;
    }

    const pendingChatTurn = pendingChatTurnRef.current;
    const preSessionExactChatTurn = toExactChatTurnOwner(
      preSessionChatTurnRef.current,
    );
    const exactChatTurn =
      preSessionExactChatTurn?.sessionId === owner.targetSessionId
        ? preSessionExactChatTurn
        : pendingChatTurn?.sessionId === owner.targetSessionId
          ? pendingChatTurn
          : activeChatTurnRef.current?.sessionId === owner.targetSessionId
            ? activeChatTurnRef.current
            : confirmedChatTurnCancellationRef.current?.sessionId
                === owner.targetSessionId
              ? confirmedChatTurnCancellationRef.current
              : null;

    if (exactChatTurn !== null) {
      let cancellationResolution: ChatTurnCancellationResolution;
      try {
        if (preSessionExactChatTurn?.ownerId === exactChatTurn.ownerId) {
          preSessionChatTurnRef.current?.retryAbortController.abort();
        }
        cancellationResolution = await cancelExactChatTurn(
          exactChatTurn,
        );
      } catch (error) {
        if (!isOwnerCurrent()) {
          return;
        }
        restoreChatTurnAfterCancellationRejection(error, exactChatTurn);
        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        if (owner.targetSessionId !== null) {
          dispatchAction({
            type: "stop_failed",
            sessionId: owner.targetSessionId,
          });
        }
        return;
      }
      if (!isOwnerCurrent()) {
        return;
      }
      if (cancellationResolution.kind === "superseded") {
        releaseSupersededExactTurnStop(exactChatTurn);
        return;
      }
      if (cancellationResolution.response.stillRunning) {
        let snapshotResolution: ChatConfirmedStopSnapshotResolution<
          NormalizedChatSessionSnapshot
        >;
        try {
          snapshotResolution =
            await reconcileConfirmedStopSnapshotForOwner(
              exactChatTurn.sessionId,
              exactChatTurn.turnId,
              attemptAbortController.signal,
              isOwnerCurrent,
            );
        } catch (error) {
          if (!isOwnerCurrent()) {
            return;
          }
          const message = error instanceof Error
            ? error.message
            : String(error);
          markAssistantError(t("chat.errorFailed", { message }));
          dispatchAction({
            type: "stop_failed",
            sessionId: exactChatTurn.sessionId,
          });
          if (shouldRestoreChatRunAfterSnapshotFailure(
            exactChatTurn,
            activeChatTurnRef.current,
            stateRef.current.currentSessionId,
          )) {
            dispatchAction({ type: "run_started" });
          }
          return;
        }
        if (!isOwnerCurrent()) {
          return;
        }
        if (snapshotResolution.kind === "superseded") {
          if (snapshotResolution.snapshot !== null) {
            releaseSupersededExactTurnStop(exactChatTurn);
          }
          return;
        }
      } else if (
        confirmedChatTurnCancellationRef.current?.sessionId
          === exactChatTurn.sessionId
        && confirmedChatTurnCancellationRef.current?.turnId
          === exactChatTurn.turnId
      ) {
        confirmedChatTurnCancellationRef.current = null;
      }
    } else if (
      owner.targetSessionId !== null
      && selectIsAssistantRunActive(stateRef.current)
    ) {
      try {
        await postStopChatSession(
          owner.targetSessionId,
          null,
          attemptAbortController.signal,
          t,
        );
      } catch {
        if (!isOwnerCurrent()) {
          return;
        }
        // Preserve the existing best-effort session stop before reset.
      }
    }

    if (!isOwnerCurrent()) {
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    dispatchAction({ type: "live_stream_disconnected" });

    try {
      const payload = await deleteChatConversation(
        owner.targetSessionId,
        attemptAbortController.signal,
        t,
      );
      if (!isOwnerCurrent()) {
        return;
      }

      clearHistory();
      if (
        confirmedChatTurnCancellationRef.current?.sessionId
        === owner.targetSessionId
      ) {
        confirmedChatTurnCancellationRef.current = null;
      }
      if (owner.targetSessionId !== null) {
        dispatchAction({
          type: "stop_completed",
          sessionId: owner.targetSessionId,
        });
        dispatchAction({
          type: "stopped_session_cleared",
          sessionId: owner.targetSessionId,
        });
      }
      dispatchAction({
        type: "conversation_cleared",
        sessionId: payload.sessionId,
      });
    } catch (error) {
      if (!isOwnerCurrent()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      markAssistantError(t("chat.errorFailed", { message }));
      if (owner.targetSessionId !== null) {
        dispatchAction({
          type: "stop_failed",
          sessionId: owner.targetSessionId,
        });
      }
    }
  }, [
    cancelExactChatTurn,
    clearHistory,
    dispatchAction,
    markAssistantError,
    reconcileConfirmedStopSnapshotForOwner,
    releaseSupersededExactTurnStop,
    restoreChatTurnAfterCancellationRejection,
    t,
  ]);
  const performClearOperationRef = useRef(performClearOperation);
  performClearOperationRef.current = performClearOperation;
  const clearOperationRunnerRef = useRef<ChatClearOperationRunner | null>(null);
  if (clearOperationRunnerRef.current === null) {
    clearOperationRunnerRef.current =
      createSingleFlightChatClearOperationRunner(
        async (owner, abortController): Promise<void> => {
          try {
            await performClearOperationRef.current(owner, abortController);
          } finally {
            if (clearOperationRef.current?.ownerId === owner.ownerId) {
              clearOperationRef.current = null;
            }
          }
        },
      );
  }
  const clearOperationRunner = clearOperationRunnerRef.current;

  useEffect(() => (): void => {
    stopOperationRef.current?.abortController.abort();
    stopOperationRef.current = null;
    stopSnapshotReconciliationRef.current?.abortController.abort();
    stopSnapshotReconciliationRef.current = null;
    confirmedChatTurnCancellationRef.current = null;
    clearOperationRef.current = null;
    clearOperationRunner.cancelActive();
    preSessionChatTurnRef.current?.retryAbortController.abort();
    pendingChatTurnRef.current?.retryAbortController.abort();
    pendingChatTurnRunner.cancelActive();
    pendingChatTurnCancellationRunner.cancelActive();
  }, [
    clearOperationRunner,
    pendingChatTurnCancellationRunner,
    pendingChatTurnRunner,
  ]);

  useEffect(() => {
    const stopOperation = stopOperationRef.current;
    if (
      stopOperation !== null
      && stopOperation.sessionId !== state.currentSessionId
    ) {
      stopOperation.abortController.abort();
      stopOperationRef.current = null;
    }
    const stopSnapshotReconciliation =
      stopSnapshotReconciliationRef.current;
    if (
      stopSnapshotReconciliation !== null
      && stopSnapshotReconciliation.sessionId !== state.currentSessionId
    ) {
      stopSnapshotReconciliation.abortController.abort();
      stopSnapshotReconciliationRef.current = null;
    }
    if (
      confirmedChatTurnCancellationRef.current !== null
      && confirmedChatTurnCancellationRef.current.sessionId
        !== state.currentSessionId
    ) {
      confirmedChatTurnCancellationRef.current = null;
    }

    const clearOperation = clearOperationRef.current;
    if (
      clearOperation !== null
      && clearOperation.targetSessionId !== state.currentSessionId
    ) {
      clearOperationRunner.cancel(clearOperation);
      clearOperationRef.current = null;
      if (clearOperation.targetSessionId !== null) {
        dispatchAction({
          type: "stop_completed",
          sessionId: clearOperation.targetSessionId,
        });
      }
    }

    const preSessionChatTurn = preSessionChatTurnRef.current;
    if (
      preSessionChatTurn !== null
      && preSessionChatTurn.initialSessionId !== state.currentSessionId
    ) {
      preSessionChatTurn.retryAbortController.abort();
      const preSessionCancellation = pendingChatTurnCancellationRef.current;
      if (preSessionCancellation?.ownerId === preSessionChatTurn.ownerId) {
        pendingChatTurnCancellationRunner.cancel(preSessionCancellation);
        pendingChatTurnCancellationRef.current = null;
      }
      preSessionChatTurnRef.current = null;
    }

    const pendingChatTurn = pendingChatTurnRef.current;
    if (
      pendingChatTurn !== null
      && pendingChatTurn.sessionId !== state.currentSessionId
    ) {
      pendingChatTurn.retryAbortController.abort();
      pendingChatTurnRunner.cancel(pendingChatTurn);
      const pendingCancellation = pendingChatTurnCancellationRef.current;
      if (pendingCancellation?.ownerId === pendingChatTurn.ownerId) {
        pendingChatTurnCancellationRunner.cancel(pendingCancellation);
        pendingChatTurnCancellationRef.current = null;
      }
      pendingChatTurnRef.current = null;
    }

    const activeChatTurn = activeChatTurnRef.current;
    if (
      activeChatTurn !== null
      && activeChatTurn.sessionId !== state.currentSessionId
    ) {
      const activeCancellation = pendingChatTurnCancellationRef.current;
      if (activeCancellation?.ownerId === activeChatTurn.ownerId) {
        pendingChatTurnCancellationRunner.cancel(activeCancellation);
        pendingChatTurnCancellationRef.current = null;
      }
      activeChatTurnRef.current = null;
    }

    if (
      (
        pendingChatTurn !== null
        && pendingChatTurn.sessionId !== state.currentSessionId
      )
      || (
        activeChatTurn !== null
        && activeChatTurn.sessionId !== state.currentSessionId
      )
    ) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [
    clearOperationRunner,
    dispatchAction,
    pendingChatTurnCancellationRunner,
    pendingChatTurnRunner,
    state.currentSessionId,
  ]);

  useEffect(() => {
    if (!state.isHistoryLoaded) {
      return;
    }

    if (state.currentSessionId === null && state.runState !== "idle") {
      return;
    }

    writeChatBootstrapLocalState(
      workspaceId,
      createChatBootstrapLocalState(
        state.currentSessionId,
        deriveLastUserMessageAt(messages),
        state.runState,
        state.lastSnapshotUpdatedAt,
      ),
    );
  }, [
    messages,
    state.currentSessionId,
    state.isHistoryLoaded,
    state.lastSnapshotUpdatedAt,
    state.runState,
    workspaceId,
  ]);

  useEffect(() => {
    const abortController = new AbortController();
    dispatchAction({ type: "workspace_reset" });
    replaceMessages([]);

    void (async (): Promise<void> => {
      let didFail = false;

      try {
        const bootstrapMode = resolveChatBootstrapMode(
          readChatBootstrapLocalState(workspaceId),
          Date.now(),
        );
        if (bootstrapMode.kind === "local_empty") {
          if (bootstrapMode.sessionId !== null) {
            dispatchAction({
              type: "server_session_accepted",
              sessionId: bootstrapMode.sessionId,
            });
          }
          return;
        }

        await loadChatSnapshot(
          undefined,
          abortController.signal,
          true,
          shouldAlwaysAdoptChatSnapshot,
        );
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        didFail = true;
        const message = error instanceof Error ? error.message : String(error);
        replaceMessages([{
          role: "assistant",
          content: [{ type: "text", text: t("chat.errorFailed", { message }) }],
          timestamp: Date.now(),
          isError: true,
          isStopped: false,
        }]);
      } finally {
        if (!abortController.signal.aborted) {
          dispatchAction({
            type: didFail ? "bootstrap_failed" : "bootstrap_succeeded",
          });
        }
      }
    })();

    return () => abortController.abort();
  }, [dispatchAction, loadChatSnapshot, replaceMessages, t, workspaceId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStorage = (event: StorageEvent): void => {
      const currentState = stateRef.current;
      if (
        !currentState.isHistoryLoaded
        || selectIsAssistantRunActive(currentState)
        || currentState.isLiveStreamConnected
        || selectIsSelectedSessionStopping(currentState)
      ) {
        return;
      }

      const nextLocalState = readChatBootstrapLocalStateFromStorageEvent(
        workspaceId,
        event.key,
        event.newValue,
      );
      if (nextLocalState === undefined) {
        return;
      }

      const bootstrapMode = resolveChatBootstrapMode(nextLocalState, Date.now());
      if (bootstrapMode.kind === "local_empty") {
        replaceMessages([]);
        dispatchAction({ type: "workspace_reset" });
        if (bootstrapMode.sessionId !== null) {
          dispatchAction({
            type: "server_session_accepted",
            sessionId: bootstrapMode.sessionId,
          });
        }
        dispatchAction({ type: "bootstrap_succeeded" });
        return;
      }

      if (nextLocalState === null || nextLocalState.sessionId === null) {
        return;
      }

      const shouldReloadSnapshot = nextLocalState.sessionId !== currentState.currentSessionId
        || (
          nextLocalState.lastSnapshotUpdatedAt !== null
          && (
            currentState.lastSnapshotUpdatedAt === null
            || nextLocalState.lastSnapshotUpdatedAt > currentState.lastSnapshotUpdatedAt
          )
        )
        || nextLocalState.lastKnownRunState !== currentState.runState;

      if (!shouldReloadSnapshot) {
        return;
      }

      void loadChatSnapshot(
        nextLocalState.sessionId,
        undefined,
        true,
        shouldAlwaysAdoptChatSnapshot,
      ).catch(() => undefined);
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [dispatchAction, loadChatSnapshot, replaceMessages, workspaceId]);

  useEffect(() => {
    if (!state.isHistoryLoaded || state.currentSessionId === null || state.runState !== "running") {
      return;
    }

    const requestedSessionId = state.currentSessionId;
    const pollAbortController = new AbortController();
    const isPollingOwnerCurrent = (): boolean =>
      isChatSnapshotPollingOwnerCurrent(
        requestedSessionId,
        stateRef.current.currentSessionId,
        pollAbortController.signal,
      )
      && clearOperationRef.current === null;
    const pollSnapshot = createSingleFlightChatSnapshotPoller(
      async (): Promise<void> => {
        try {
          const pendingChatTurn = pendingChatTurnRef.current;
          if (
            pendingChatTurn !== null
            && pendingChatTurn.sessionId === requestedSessionId
            && !pendingChatTurn.retryAbortController.signal.aborted
          ) {
            await pendingChatTurnRunner.run(pendingChatTurn);
            return;
          }

          await loadChatSnapshot(
            requestedSessionId,
            pollAbortController.signal,
            true,
            (snapshot): boolean =>
              snapshot.sessionId === requestedSessionId
              && isPollingOwnerCurrent(),
          );
        } catch (error) {
          if (!isPollingOwnerCurrent()) {
            return;
          }
          if (stateRef.current.isLiveStreamConnected) {
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          markAssistantError(t("chat.errorFailed", { message }));
          if (isPendingChatTurnForSession(
            pendingChatTurnRef.current,
            stateRef.current.currentSessionId,
          )) {
            return;
          }
          dispatchAction({ type: "run_interrupted" });
        }
      },
    );
    const intervalId = setInterval(() => {
      void pollSnapshot();
    }, ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      pollAbortController.abort();
    };
  }, [
    dispatchAction,
    loadChatSnapshot,
    markAssistantError,
    pendingChatTurnRunner,
    state.currentSessionId,
    state.isHistoryLoaded,
    state.runState,
    t,
  ]);

  const ensureWritableSessionId = useCallback(async (): Promise<string> => {
    const currentSessionId = stateRef.current.currentSessionId;
    if (currentSessionId !== null) {
      return currentSessionId;
    }

    if (pendingSessionIdRef.current !== null) {
      return pendingSessionIdRef.current;
    }

    const pendingSessionId = createChatSession(t)
      .finally(() => {
        pendingSessionIdRef.current = null;
      });

    pendingSessionIdRef.current = pendingSessionId;
    const writableSessionId = await pendingSessionId;

    return writableSessionId;
  }, [t]);

  const sendMessage = useCallback(async (
    sendParams: SendChatMessageParams,
  ): Promise<void> => {
    const currentState = stateRef.current;
    if (
      selectIsAssistantRunActive(currentState)
      || currentState.isLiveStreamConnected
      || selectIsSelectedSessionStopping(currentState)
      || clearOperationRef.current !== null
      || pendingChatTurnCancellationRef.current !== null
      || isChatTurnOwnerForSession(
        activeChatTurnRef.current,
        currentState.currentSessionId,
      )
      || isChatTurnOwnerForSession(
        confirmedChatTurnCancellationRef.current,
        currentState.currentSessionId,
      )
      || isPendingChatTurnForSession(
        pendingChatTurnRef.current,
        currentState.currentSessionId,
      )
    ) {
      return;
    }

    if (!currentState.isHistoryLoaded) {
      return;
    }

    const authoritativeMessagesBeforeSend = messages;
    const preparedRequest = prepareChatSendRequest(
      sendParams.text,
      sendParams.attachments,
      t,
    );
    if (preparedRequest.kind === "empty") {
      return;
    }
    if (preparedRequest.kind === "invalid_attachment") {
      startAssistantMessage();
      markAssistantError(preparedRequest.errorMessage);
      return;
    }

    if (preparedRequest.kind === "too_large") {
      appendUserMessage(preparedRequest.contentParts);
      dispatchAction({ type: "run_started" });
      startAssistantMessage();
      markAssistantError(preparedRequest.errorMessage);
      dispatchAction({ type: "run_finished" });
      return;
    }

    const turnId = crypto.randomUUID();
    assertCanonicalChatTurnId(turnId);
    const preSessionChatTurn: PreSessionChatTurn = {
      ownerId: Symbol(turnId),
      initialSessionId: currentState.currentSessionId,
      turnId,
      authoritativeMessages: authoritativeMessagesBeforeSend,
      retryAbortController: new AbortController(),
      submittedContent: preparedRequest.contentParts,
    };
    preSessionChatTurnRef.current = preSessionChatTurn;

    appendUserMessage(preparedRequest.contentParts);
    dispatchAction({ type: "run_started" });
    startAssistantMessage();

    let writableSessionId: string;
    try {
      writableSessionId = await ensureWritableSessionId();
    } catch (error) {
      if (!isChatPreSessionSendOwnerCurrent(
        preSessionChatTurn,
        preSessionChatTurnRef.current,
        stateRef.current.currentSessionId,
      ) || preSessionChatTurn.retryAbortController.signal.aborted) {
        return;
      }
      preSessionChatTurnRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      markAssistantError(t("chat.errorFailed", { message }));
      dispatchAction({ type: "run_finished" });
      return;
    }

    const adoptedTurnOwner = resolveChatPreSessionSendAdoption(
      preSessionChatTurn,
      preSessionChatTurnRef.current,
      stateRef.current.currentSessionId,
      writableSessionId,
      preSessionChatTurn.retryAbortController.signal,
    );
    if (adoptedTurnOwner === null) {
      return;
    }

    const pendingChatTurn: PendingChatTurn = {
      ...adoptedTurnOwner,
      requestBody: buildChatSendRequestBody(
        preparedRequest.contentParts,
        writableSessionId,
        turnId,
      ),
      submittedContent: preparedRequest.contentParts,
      authoritativeMessages: authoritativeMessagesBeforeSend,
      retryAbortController: preSessionChatTurn.retryAbortController,
    };
    preSessionChatTurnRef.current = null;
    pendingChatTurnRef.current = pendingChatTurn;
    pendingChatTurnCancellationRef.current = null;
    if (stateRef.current.currentSessionId !== writableSessionId) {
      dispatchAction({
        type: "server_session_created",
        sessionId: writableSessionId,
      });
    }
    await pendingChatTurnRunner.run(pendingChatTurn);
  }, [
    appendUserMessage,
    dispatchAction,
    ensureWritableSessionId,
    markAssistantError,
    messages,
    pendingChatTurnRunner,
    startAssistantMessage,
    t,
  ]);

  const stopMessage = useCallback(async (): Promise<void> => {
    const currentState = stateRef.current;
    if (!selectIsAssistantRunActive(currentState) || selectIsSelectedSessionStopping(currentState)) {
      return;
    }
    const preSessionChatTurn = preSessionChatTurnRef.current;
    if (currentState.currentSessionId === null) {
      if (preSessionChatTurn === null) {
        return;
      }
      preSessionChatTurn.retryAbortController.abort();
      preSessionChatTurnRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      replaceMessages(buildStoppedChatSendHistory(
        preSessionChatTurn.authoritativeMessages,
        preSessionChatTurn.submittedContent,
        Date.now(),
      ));
      dispatchAction({ type: "live_stream_disconnected" });
      dispatchAction({ type: "run_finished" });
      return;
    }
    const stoppedSessionId = currentState.currentSessionId;
    stopOperationRef.current?.abortController.abort();
    const stopOwner: ChatStopOperationOwner = {
      ownerId: Symbol(stoppedSessionId),
      sessionId: stoppedSessionId,
      abortController: new AbortController(),
    };
    stopOperationRef.current = stopOwner;
    const isStopOwnerCurrent = (): boolean =>
      isChatStopOperationOwnerCurrent(
        stopOwner,
        stopOperationRef.current,
        stateRef.current.currentSessionId,
      );
    const stopStreamController = abortRef.current;
    const preSessionExactChatTurn = toExactChatTurnOwner(
      preSessionChatTurnRef.current,
    );
    const pendingChatTurn = pendingChatTurnRef.current;
    const exactChatTurn = preSessionExactChatTurn?.sessionId === stoppedSessionId
      ? preSessionExactChatTurn
      : pendingChatTurn?.sessionId === stoppedSessionId
        ? pendingChatTurn
        : activeChatTurnRef.current?.sessionId === stoppedSessionId
          ? activeChatTurnRef.current
          : confirmedChatTurnCancellationRef.current?.sessionId
              === stoppedSessionId
            ? confirmedChatTurnCancellationRef.current
            : null;
    const retainedStoppedChatTurn =
      preSessionExactChatTurn?.ownerId === exactChatTurn?.ownerId
        && preSessionChatTurn !== null
        ? preSessionChatTurn
        : pendingChatTurn?.ownerId === exactChatTurn?.ownerId
          ? pendingChatTurn
          : null;
    if (preSessionExactChatTurn?.ownerId === exactChatTurn?.ownerId) {
      preSessionChatTurnRef.current?.retryAbortController.abort();
    }
    if (
      pendingChatTurn !== null
      && pendingChatTurn.sessionId === stoppedSessionId
    ) {
      pendingChatTurn.retryAbortController.abort();
      pendingChatTurnRunner.cancel(pendingChatTurn);
    }

    dispatchAction({
      type: "stop_requested",
      sessionId: stoppedSessionId,
    });

    let exactCancellationResolution: ChatTurnCancellationResolution | null =
      null;
    let sessionStopConfirmed = false;
    let stopSnapshotSettled = false;
    let stopWasSupersededBySnapshot = false;
    try {
      if (
        exactChatTurn !== null
      ) {
        exactCancellationResolution = await cancelExactChatTurn(exactChatTurn);
      } else {
        await postStopChatSession(
          stoppedSessionId,
          null,
          stopOwner.abortController.signal,
          t,
        );
        sessionStopConfirmed = true;
      }
    } catch (error) {
      if (isStopOwnerCurrent()) {
        if (exactChatTurn !== null) {
          restoreChatTurnAfterCancellationRejection(error, exactChatTurn);
        }
        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        dispatchAction({
          type: "stop_failed",
          sessionId: stoppedSessionId,
        });
      }
    } finally {
      if (!isStopOwnerCurrent()) {
        return;
      }
      stopStreamController?.abort();
      const isStopStreamSettlementOwned = isChatStopSettlementOwned(
        stoppedSessionId,
        stateRef.current.currentSessionId,
        stopStreamController,
        abortRef.current,
      );
      if (isStopStreamSettlementOwned) {
        abortRef.current = null;
        dispatchAction({ type: "live_stream_disconnected" });
      }

      if (exactCancellationResolution?.kind === "superseded") {
        if (clearOperationRef.current === null && exactChatTurn !== null) {
          releaseSupersededExactTurnStop(exactChatTurn);
        }
      } else {
        const stopConfirmed =
          exactCancellationResolution?.kind === "confirmed"
          || sessionStopConfirmed;
        const isStopSettlementOwnerCurrent = (): boolean =>
          isStopOwnerCurrent()
          && !stopOwner.abortController.signal.aborted
          && clearOperationRef.current === null
          && isChatStopSettlementOwned(
            stoppedSessionId,
            stateRef.current.currentSessionId,
            null,
            abortRef.current,
          );

        if (stopConfirmed && isStopStreamSettlementOwned) {
          try {
            const snapshotResolution =
              await reconcileConfirmedStopSnapshotForOwner(
                stoppedSessionId,
                exactChatTurn?.turnId ?? null,
                stopOwner.abortController.signal,
                isStopSettlementOwnerCurrent,
              );

            if (
              snapshotResolution.kind === "settled"
              && isStopSettlementOwnerCurrent()
            ) {
              if (
                retainedStoppedChatTurn !== null
              ) {
                const stoppedHistory = resolveConfirmedChatTurnStopHistory(
                  snapshotResolution.snapshot,
                  retainedStoppedChatTurn,
                  Date.now(),
                );
                if (stoppedHistory !== null) {
                  replaceMessages(stoppedHistory);
                }
              }
              stopSnapshotSettled = true;
            } else if (
              snapshotResolution.kind === "superseded"
              && snapshotResolution.snapshot !== null
              && exactChatTurn !== null
              && isStopSettlementOwnerCurrent()
            ) {
              releaseSupersededExactTurnStop(exactChatTurn);
              stopWasSupersededBySnapshot = true;
            }
          } catch (error) {
            if (isStopSettlementOwnerCurrent()) {
              const message = error instanceof Error
                ? error.message
                : String(error);
              markAssistantError(t("chat.errorFailed", { message }));
              dispatchAction({
                type: "stop_failed",
                sessionId: stoppedSessionId,
              });
              if (
                exactChatTurn !== null
                && shouldRestoreChatRunAfterSnapshotFailure(
                  exactChatTurn,
                  activeChatTurnRef.current,
                  stateRef.current.currentSessionId,
                )
              ) {
                dispatchAction({ type: "run_started" });
              }
            }
          }
        }
        if (
          isStopOwnerCurrent()
          && !stopWasSupersededBySnapshot
          && stopConfirmed
          && stopSnapshotSettled
        ) {
          dispatchAction({
            type: "stop_completed",
            sessionId: stoppedSessionId,
          });
        }
      }
      if (stopOperationRef.current?.ownerId === stopOwner.ownerId) {
        stopOperationRef.current = null;
      }
    }
  }, [
    dispatchAction,
    markAssistantError,
    cancelExactChatTurn,
    pendingChatTurnRunner,
    reconcileConfirmedStopSnapshotForOwner,
    releaseSupersededExactTurnStop,
    replaceMessages,
    restoreChatTurnAfterCancellationRejection,
    t,
  ]);

  const clearConversation = useCallback((): Promise<void> => {
    stopOperationRef.current?.abortController.abort();
    stopOperationRef.current = null;
    stopSnapshotReconciliationRef.current?.abortController.abort();
    stopSnapshotReconciliationRef.current = null;
    const targetSessionId = stateRef.current.currentSessionId;
    const existingOperation = clearOperationRef.current;
    if (
      existingOperation !== null
      && existingOperation.targetSessionId === targetSessionId
    ) {
      return clearOperationRunner.run(existingOperation);
    }

    if (existingOperation !== null) {
      clearOperationRunner.cancel(existingOperation);
      if (existingOperation.targetSessionId !== null) {
        dispatchAction({
          type: "stop_completed",
          sessionId: existingOperation.targetSessionId,
        });
      }
    }

    const owner: ChatClearOperationOwner = {
      ownerId: Symbol(targetSessionId ?? "local-clear"),
      targetSessionId,
    };
    clearOperationRef.current = owner;
    return clearOperationRunner.run(owner);
  }, [
    clearOperationRunner,
    dispatchAction,
  ]);

  const acceptServerSessionId = useCallback((sessionId: string): void => {
    dispatchAction({
      type: "server_session_accepted",
      sessionId,
    });
  }, [dispatchAction]);

  return {
    messages,
    runState: state.runState,
    isHistoryLoaded: state.isHistoryLoaded,
    isAssistantRunActive,
    isLiveStreamConnected: state.isLiveStreamConnected,
    isStopping: selectIsSelectedSessionStopping(state),
    currentSessionId: state.currentSessionId,
    composerAction,
    acceptServerSessionId,
    ensureWritableSessionId,
    sendMessage,
    stopMessage,
    clearConversation,
  };
};
