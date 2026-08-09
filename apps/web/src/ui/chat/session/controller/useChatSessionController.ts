"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

import {
  useChatHistory,
  type StoredMessage,
} from "@/ui/hooks/useChatHistory";
import type { ContentPart } from "@/server/chat/types";
import type { PendingAttachment } from "../../shell/panel/FileAttachment";
import type { ChatSessionSnapshot } from "../bootstrap/chatSessionSnapshot";
import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
  shouldSuppressStreamFailure,
  type ChatComposerAction,
  type ChatRunState,
} from "../../stream/streamRecovery";
import type {
  ChatTarget,
} from "../../workspace/chatWorkspaceState";
import type {
  ChatWorkspaceInvalidationSource,
  ChatDraftSessionAdoption,
} from "../../workspace/useChatWorkspaceController";
import {
  createChatSessionSyncScope,
  getChatSessionSyncSourceId,
  publishChatSessionSync,
  subscribeToChatSessionSync,
  type ChatSessionSyncScope,
} from "../invalidation/chatSessionSyncChannel";
import {
  assertCanonicalChatTurnId,
  beginChatSnapshotRequest,
  buildFailedChatSendHistory,
  buildPendingChatSendHistory,
  classifyConfirmedChatStopSnapshotFailure,
  cleanupChatSessionSyncEffect,
  completeChatTurnCancellation,
  createChatSessionSyncRefreshCoordinator,
  createSingleFlightChatSendReconciliationRunner,
  createSingleFlightChatSnapshotPoller,
  createSingleFlightChatTurnCancellationRunner,
  createChatSnapshotRequestCoordinator,
  createChatSendTransport,
  fetchChatSessionSnapshot,
  isDefinitiveChatRequestRejection,
  isChatSendReconciliationOwnerCurrent,
  isChatStopOperationOwnerCurrent,
  isChatStopSettlementOwned,
  isChatTurnCancellationSettlementOwned,
  isChatTurnOwnerForSession,
  postStopChatSession,
  prepareChatSendRequest,
  reconcileConfirmedChatStopSnapshot,
  requestChatSessionSyncRefresh,
  resolveChatExactTurnOwnership,
  resolveChatSendReconciliationDisposition,
  resolveDefinitiveChatSendSnapshotFailureHistory,
  resolveConfirmedChatStopSnapshotDisposition,
  resolveConfirmedChatTurnStopHistory,
  resolveChatSessionSyncFailureDisposition,
  resolveChatSnapshotFailureDisposition,
  resolveChatSnapshotRequest,
  restorePendingChatTurnAfterCancellationRejection,
  shouldRestoreChatRunAfterSnapshotFailure,
  shouldRestoreChatTurnAfterCancellationRejection,
  settleChatSessionSyncRefresh,
  shouldAbortChatStreamForControllerCleanup,
  shouldAbortChatStreamForSelectionChange,
  streamChatResponse,
  type ChatConfirmedStopSnapshotResolution,
  type ChatSelectionGuard,
  type ChatSendReconciliationOwner,
  type ChatSendReconciliationRunner,
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
  shouldReplaceHistoryForSnapshot,
  type ChatSessionControllerAction,
} from "./chatSessionControllerState";

type UseChatSessionControllerParams = Readonly<{
  workspaceId: string;
  target: ChatTarget;
  selectionEpoch: number;
  isWorkspaceReady: boolean;
  isSelectionCurrent: (
    target: ChatTarget,
    selectionEpoch: number,
  ) => boolean;
  adoptDraftSession: (
    draftId: string,
    sessionId: string,
    expectedSelectionEpoch: number,
  ) => ChatDraftSessionAdoption;
  refreshCatalog: () => Promise<void>;
  observeSessionInvalidation: (
    sessionId: string,
    version: number,
    source: ChatWorkspaceInvalidationSource,
  ) => void;
  recoverInvalidSessionSelection: (
    sessionId: string,
    errorMessage: string,
  ) => boolean;
}>;

export type SendChatMessageParams = Readonly<{
  text: string;
  attachments: ReadonlyArray<PendingAttachment>;
  onSubmissionRejected: () => void;
  onSubmissionUnresolved: () => void;
}>;

export type ChatSessionController = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  runState: ChatRunState;
  isHistoryLoaded: boolean;
  isTranscriptDisplayReady: boolean;
  isAssistantRunActive: boolean;
  isLiveStreamConnected: boolean;
  isStopping: boolean;
  currentSessionId: string | null;
  composerAction: ChatComposerAction;
  sendMessage: (params: SendChatMessageParams) => Promise<void>;
  stopMessage: () => Promise<void>;
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

type OwnedChatTurn = ChatSendReconciliationOwner & Readonly<{
  guard: ChatSelectionGuard;
}>;

type PendingChatTurn = OwnedChatTurn & Readonly<{
  requestBody: string;
  submittedContent: ReadonlyArray<ContentPart>;
  authoritativeMessages: ReadonlyArray<StoredMessage>;
  retryAbortController: AbortController;
  onSubmissionRejected: () => void;
}>;

type PendingChatTurnCancellation = OwnedChatTurn;

type ConfirmedChatTurnCancellation =
  OwnedChatTurn & Readonly<{
    response: ExactTurnStopChatSessionResponse;
  }>;

type FreshDraftChatTurn = Readonly<{
  ownerId: symbol;
  guard: ChatSelectionGuard;
  abortController: AbortController;
}>;

type OwnedChatStopOperation = ChatStopOperationOwner & Readonly<{
  guard: ChatSelectionGuard;
}>;

type ChatStopSnapshotReconciliationOwner = Readonly<{
  ownerId: symbol;
  sessionId: string;
  guard: ChatSelectionGuard;
  abortController: AbortController;
}>;

type IsChatOperationOwnerCurrent = () => boolean;

const isPendingChatTurnForSession = (
  pendingChatTurn: PendingChatTurn | null,
  sessionId: string | null,
): boolean =>
  pendingChatTurn !== null
  && pendingChatTurn.sessionId === sessionId;

const waitForChatReconciliationRetry = (
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const finish = (): void => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeoutId = window.setTimeout(
      finish,
      ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
    );
    signal.addEventListener("abort", finish, { once: true });
  });
};

const reportChatSessionSyncError = (error: Error): void => {
  queueMicrotask((): void => {
    if (typeof globalThis.reportError === "function") {
      globalThis.reportError(error);
      return;
    }
    throw error;
  });
};

export const useChatSessionController = (
  params: UseChatSessionControllerParams,
): ChatSessionController => {
  const { t } = useTranslation();
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
  } = useChatHistory();

  const [state, dispatch] = useReducer(
    reduceChatSessionControllerState,
    undefined,
    createInitialChatSessionControllerState,
  );
  const stateRef = useRef(state);
  const transcriptSelectionEpochRef = useRef<number | null>(null);
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const activeStreamSelectionEpochRef = useRef<number | null>(null);
  const activeStreamUnadoptedDraftIdRef = useRef<string | null>(null);
  const activeStreamAdoptedSessionIdRef = useRef<string | null>(null);
  const isControllerMountedRef = useRef<boolean>(true);
  const freshDraftChatTurnRef = useRef<FreshDraftChatTurn | null>(null);
  const pendingChatTurnRef = useRef<PendingChatTurn | null>(null);
  const activeChatTurnRef = useRef<OwnedChatTurn | null>(null);
  const pendingChatTurnCancellationRef =
    useRef<PendingChatTurnCancellation | null>(null);
  const confirmedChatTurnCancellationRef =
    useRef<ConfirmedChatTurnCancellation | null>(null);
  const stopOperationRef = useRef<OwnedChatStopOperation | null>(null);
  const selectedSessionPollAbortControllerRef =
    useRef<AbortController | null>(null);
  const stopSnapshotReconciliationRef =
    useRef<ChatStopSnapshotReconciliationOwner | null>(null);
  const snapshotAbortControllersRef = useRef<Set<AbortController>>(
    new Set<AbortController>(),
  );
  const snapshotRequestCoordinatorRef = useRef(
    createChatSnapshotRequestCoordinator(),
  );
  const sessionSyncScopeRef = useRef<ChatSessionSyncScope | null>(null);
  const sessionSyncSourceIdRef = useRef<string | null>(null);
  const lastSessionSyncEmittedAtRef = useRef<number>(0);
  const seenSessionSyncMessageKeysRef = useRef<Set<string>>(
    new Set<string>(),
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

  useEffect(() => {
    if (sessionSyncScopeRef.current !== null) {
      return;
    }
    sessionSyncScopeRef.current = createChatSessionSyncScope(
      params.workspaceId,
      document.cookie,
    );
  }, [params.workspaceId]);

  const createSnapshotAbortController = useCallback((): AbortController => {
    const abortController = new AbortController();
    snapshotAbortControllersRef.current.add(abortController);
    return abortController;
  }, []);

  const releaseSnapshotAbortController = useCallback((
    abortController: AbortController,
  ): void => {
    snapshotAbortControllersRef.current.delete(abortController);
  }, []);

  const publishSessionChange = useCallback((sessionId: string): void => {
    const scope = sessionSyncScopeRef.current;
    if (scope === null) {
      throw new Error(
        `Chat session sync scope is unavailable for sessionId=${sessionId}`,
      );
    }
    if (sessionSyncSourceIdRef.current === null) {
      sessionSyncSourceIdRef.current = getChatSessionSyncSourceId();
    }
    const emittedAt = Math.max(
      Date.now(),
      lastSessionSyncEmittedAtRef.current + 1,
    );
    lastSessionSyncEmittedAtRef.current = emittedAt;
    const publishResult = publishChatSessionSync({
      scope,
      sessionId,
      sourceId: sessionSyncSourceIdRef.current,
      emittedAt,
    });
    if (publishResult.error !== null) {
      reportChatSessionSyncError(publishResult.error);
    }
  }, []);

  const abortSelectedSessionPoll = useCallback((): void => {
    const abortController =
      selectedSessionPollAbortControllerRef.current;
    if (abortController === null) {
      return;
    }
    selectedSessionPollAbortControllerRef.current = null;
    abortController.abort();
  }, []);

  const isAssistantRunActive = selectIsAssistantRunActive(state);
  const isStopping = selectIsSelectedSessionStopping(state);
  const composerAction: ChatComposerAction = state.currentSessionId === null
    ? "send"
    : selectComposerAction(state);

  const isGuardCurrent = useCallback((
    guard: ChatSelectionGuard,
  ): boolean =>
    params.isSelectionCurrent(
      guard.target,
      guard.selectionEpoch,
    ), [params.isSelectionCurrent]);

  const isSelectedStreamRetainedByStop = useCallback((
    streamController: AbortController,
    sessionId: string,
    selectionEpoch: number,
  ): boolean => {
    const stopOperation = stopOperationRef.current;
    return stopOperation !== null
      && stopOperation.sessionId === sessionId
      && stopOperation.guard.selectionEpoch === selectionEpoch
      && isGuardCurrent(stopOperation.guard)
      && activeStreamAbortRef.current === streamController
      && activeStreamSelectionEpochRef.current === selectionEpoch
      && activeStreamAdoptedSessionIdRef.current === sessionId;
  }, [isGuardCurrent]);

  const loadChatSnapshot = useCallback(async (
    sessionId: string,
    guard: ChatSelectionGuard,
    signal: AbortSignal | undefined,
    replaceHistory: boolean,
  ): Promise<ChatSnapshotLoadResult> => {
    const snapshotPromise = fetchChatSessionSnapshot(sessionId, signal, t);
    const startedRequest = beginChatSnapshotRequest(
      snapshotRequestCoordinatorRef.current,
      sessionId,
      guard.selectionEpoch,
      snapshotPromise,
    );
    snapshotRequestCoordinatorRef.current = startedRequest.coordinator;
    const resolution = await resolveChatSnapshotRequest(
      () => snapshotRequestCoordinatorRef.current,
      {
        request: startedRequest.request,
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
    const normalizedSnapshot: NormalizedChatSessionSnapshot = {
      ...payload,
      authoritativeRunState: payload.runState,
      runState: selectEffectiveSnapshotRunState(
        stateRef.current,
        payload.sessionId,
        payload.runState,
      ),
    };
    if (
      resolution.kind === "superseded"
      || signal?.aborted === true
      || !isGuardCurrent(guard)
    ) {
      return {
        kind: "superseded",
        snapshot: resolution.kind === "superseded"
          && signal?.aborted !== true
          && isGuardCurrent(guard)
          ? normalizedSnapshot
          : null,
      };
    }

    const pendingChatTurnCandidate = pendingChatTurnRef.current;
    const pendingChatTurn =
      pendingChatTurnCandidate !== null
      && isGuardCurrent(pendingChatTurnCandidate.guard)
        ? pendingChatTurnCandidate
        : null;
    if (
      pendingChatTurnCandidate !== null
      && pendingChatTurn === null
    ) {
      pendingChatTurnCandidate.retryAbortController.abort();
      pendingChatTurnRef.current = null;
    }
    const activeChatTurnCandidate = activeChatTurnRef.current;
    const currentActiveChatTurn =
      activeChatTurnCandidate !== null
      && isGuardCurrent(activeChatTurnCandidate.guard)
        ? activeChatTurnCandidate
        : null;
    if (
      activeChatTurnCandidate !== null
      && currentActiveChatTurn === null
    ) {
      activeChatTurnRef.current = null;
    }
    const cancellationCandidate =
      pendingChatTurnCancellationRef.current;
    const currentCancellation =
      cancellationCandidate !== null
      && isGuardCurrent(cancellationCandidate.guard)
        ? cancellationCandidate
        : null;
    if (
      cancellationCandidate !== null
      && currentCancellation === null
    ) {
      pendingChatTurnCancellationRef.current = null;
    }
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
        snapshot: normalizedSnapshot,
      };
    }

    const exactTurnOwnership = resolveChatExactTurnOwnership(
      payload,
      pendingChatTurn,
      currentActiveChatTurn,
      currentCancellation,
    );
    if (exactTurnOwnership.pendingTurn === null) {
      pendingChatTurnRef.current = null;
    }
    if (exactTurnOwnership.activeTurn === null) {
      activeChatTurnRef.current = null;
    } else if (
      pendingChatTurn?.ownerId === exactTurnOwnership.activeTurn.ownerId
    ) {
      activeChatTurnRef.current = pendingChatTurn;
    } else if (
      currentActiveChatTurn?.ownerId
        === exactTurnOwnership.activeTurn.ownerId
    ) {
      activeChatTurnRef.current = currentActiveChatTurn;
    } else {
      activeChatTurnRef.current = {
        ...exactTurnOwnership.activeTurn,
        guard,
      };
    }
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
      confirmedCancellation !== null
      && (
        !isGuardCurrent(confirmedCancellation.guard)
        || (
          confirmedCancellation.sessionId === payload.sessionId
          && (
            payload.runState !== "running"
            || payload.activeTurnId !== confirmedCancellation.turnId
          )
        )
      )
    ) {
      confirmedChatTurnCancellationRef.current = null;
    }

    const currentState = stateRef.current;
    const shouldReplaceHistory = replaceHistory
      && shouldReplaceHistoryForSnapshot(currentState, payload.updatedAt);

    dispatchAction({
      type: "snapshot_applied",
      sessionId: payload.sessionId,
      runState: payload.runState,
      updatedAt: payload.updatedAt,
      mainContentInvalidationVersion: payload.mainContentInvalidationVersion,
    });
    params.observeSessionInvalidation(
      payload.sessionId,
      payload.mainContentInvalidationVersion,
      "snapshot",
    );

    if (shouldReplaceHistory) {
      replaceMessages(payload.messages);
    }

    return {
      kind: "applied",
      snapshot: normalizedSnapshot,
    };
  }, [
    dispatchAction,
    isGuardCurrent,
    params.observeSessionInvalidation,
    replaceMessages,
    t,
  ]);

  useEffect(() => {
    if (
      !params.isWorkspaceReady
      || params.target.kind !== "session"
    ) {
      return;
    }

    const scope = sessionSyncScopeRef.current;
    if (scope === null) {
      throw new Error(
        "Chat session sync subscription cannot start without a scope",
      );
    }
    if (sessionSyncSourceIdRef.current === null) {
      sessionSyncSourceIdRef.current = getChatSessionSyncSourceId();
    }
    const sourceId = sessionSyncSourceIdRef.current;
    const sessionId = params.target.sessionId;
    const guard: ChatSelectionGuard = {
      target: params.target,
      selectionEpoch: params.selectionEpoch,
    };
    let isDisposed = false;
    let activeAbortController: AbortController | null = null;
    let refreshCoordinator = createChatSessionSyncRefreshCoordinator();
    let pendingRetryAttempt: number | null = null;
    let retryTimeoutId: number | null = null;

    const surfaceRefreshFailure = (
      errorMessage: string,
      shouldBlockWorkspace: boolean,
    ): void => {
      startAssistantMessage();
      markAssistantError(t("chat.errorFailed", { message: errorMessage }));
      dispatchAction({
        type: shouldBlockWorkspace
          ? "bootstrap_blocked"
          : "bootstrap_failed",
      });
    };

    function startSessionSyncRefresh(
      transientRetryAttempt: number,
    ): void {
      if (isDisposed || !isGuardCurrent(guard)) {
        return;
      }
      const wasHistoryLoaded = stateRef.current.isHistoryLoaded;
      const matchingStreamController =
        activeStreamSelectionEpochRef.current === guard.selectionEpoch
        && activeStreamAdoptedSessionIdRef.current === sessionId
          ? activeStreamAbortRef.current
          : null;
      dispatchAction({
        type: "external_session_change_observed",
        sessionId,
      });
      abortSelectedSessionPoll();
      const abortController = createSnapshotAbortController();
      activeAbortController = abortController;
      void loadChatSnapshot(
        sessionId,
        guard,
        abortController.signal,
        true,
      ).then((snapshotResult) => {
        if (
          snapshotResult.kind !== "applied"
          || !isGuardCurrent(guard)
        ) {
          if (
            wasHistoryLoaded
            && !abortController.signal.aborted
            && isGuardCurrent(guard)
          ) {
            dispatchAction({ type: "bootstrap_succeeded" });
          }
          return;
        }

        if (
          snapshotResult.snapshot.authoritativeRunState !== "running"
          && matchingStreamController !== null
          && activeStreamAbortRef.current === matchingStreamController
          && activeStreamSelectionEpochRef.current === guard.selectionEpoch
          && activeStreamAdoptedSessionIdRef.current === sessionId
        ) {
          matchingStreamController.abort();
          activeStreamAbortRef.current = null;
          activeStreamSelectionEpochRef.current = null;
          activeStreamUnadoptedDraftIdRef.current = null;
          activeStreamAdoptedSessionIdRef.current = null;
          dispatchAction({ type: "live_stream_disconnected" });
        }
        dispatchAction({ type: "bootstrap_succeeded" });
      }).catch((error: unknown) => {
        if (
          abortController.signal.aborted
          || !isGuardCurrent(guard)
        ) {
          return;
        }

        const disposition = resolveChatSessionSyncFailureDisposition(
          error,
          transientRetryAttempt,
        );
        if (disposition === "retry_active_response") {
          retryTimeoutId = window.setTimeout(
            (): void => {
              retryTimeoutId = null;
              queueSessionSyncRefresh(0);
            },
            ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
          );
          return;
        }
        if (disposition === "retry_transient") {
          retryTimeoutId = window.setTimeout(
            (): void => {
              retryTimeoutId = null;
              queueSessionSyncRefresh(transientRetryAttempt + 1);
            },
            ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
          );
          return;
        }
        if (disposition === "recover_unavailable") {
          surfaceRefreshFailure(t("chat.sessionUnavailable"), false);
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        surfaceRefreshFailure(
          message,
          disposition === "block_workspace_reload",
        );
      }).finally(() => {
        releaseSnapshotAbortController(abortController);
        if (activeAbortController === abortController) {
          activeAbortController = null;
        }
        const settledRefresh = settleChatSessionSyncRefresh(
          refreshCoordinator,
        );
        refreshCoordinator = settledRefresh.coordinator;
        if (
          settledRefresh.shouldStartPendingRefresh
          && !isDisposed
          && isGuardCurrent(guard)
        ) {
          const nextRetryAttempt = pendingRetryAttempt ?? 0;
          pendingRetryAttempt = null;
          startSessionSyncRefresh(nextRetryAttempt);
        }
      });
    }

    function queueSessionSyncRefresh(
      transientRetryAttempt: number,
    ): void {
      if (isDisposed || !isGuardCurrent(guard)) {
        return;
      }
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
        retryTimeoutId = null;
      }

      const requestedRefresh = requestChatSessionSyncRefresh(
        refreshCoordinator,
      );
      refreshCoordinator = requestedRefresh.coordinator;
      if (!requestedRefresh.shouldStartRefresh) {
        pendingRetryAttempt = pendingRetryAttempt === null
          ? transientRetryAttempt
          : Math.min(pendingRetryAttempt, transientRetryAttempt);
        if (requestedRefresh.shouldAbortActiveRefresh) {
          activeAbortController?.abort();
        }
        return;
      }

      pendingRetryAttempt = null;
      startSessionSyncRefresh(transientRetryAttempt);
    }

    const subscription = subscribeToChatSessionSync({
      scope,
      sessionId,
      sourceId,
      seenMessageKeys: seenSessionSyncMessageKeysRef.current,
      onMessage: (): void => {
        queueSessionSyncRefresh(0);
      },
    });
    if (subscription.error !== null) {
      reportChatSessionSyncError(subscription.error);
    }

    return () => {
      isDisposed = true;
      cleanupChatSessionSyncEffect({
        unsubscribe: subscription.unsubscribe,
        clearRetryTimeout: (): void => {
          if (retryTimeoutId !== null) {
            window.clearTimeout(retryTimeoutId);
            retryTimeoutId = null;
          }
        },
        abortActiveRequest: (): void => {
          activeAbortController?.abort();
        },
        reportError: reportChatSessionSyncError,
      });
    };
  }, [
    abortSelectedSessionPoll,
    createSnapshotAbortController,
    dispatchAction,
    isGuardCurrent,
    loadChatSnapshot,
    markAssistantError,
    params.isWorkspaceReady,
    params.selectionEpoch,
    params.target,
    releaseSnapshotAbortController,
    startAssistantMessage,
    t,
  ]);

  const reconcileConfirmedStopSnapshotForOwner = useCallback(async (
    sessionId: string,
    turnId: string | null,
    guard: ChatSelectionGuard,
    operationSignal: AbortSignal,
    isOperationOwnerCurrent: IsChatOperationOwnerCurrent,
  ): Promise<
    ChatConfirmedStopSnapshotResolution<NormalizedChatSessionSnapshot>
  > => {
    stopSnapshotReconciliationRef.current?.abortController.abort();
    const reconciliationOwner: ChatStopSnapshotReconciliationOwner = {
      ownerId: Symbol(sessionId),
      sessionId,
      guard,
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
      && isGuardCurrent(guard)
      && isOperationOwnerCurrent();

    try {
      return await reconcileConfirmedChatStopSnapshot({
        signal: reconciliationOwner.abortController.signal,
        isOwnerCurrent: isReconciliationOwnerCurrent,
        loadSnapshot: async (
          signal,
        ): Promise<NormalizedChatSessionSnapshot | null> => {
          const snapshotResult = await loadChatSnapshot(
            sessionId,
            guard,
            signal,
            true,
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
  }, [isGuardCurrent, loadChatSnapshot]);

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
      isControllerMountedRef.current
      && isGuardCurrent(pendingChatTurn.guard)
      && !pendingChatTurn.retryAbortController.signal.aborted
      && isChatSendReconciliationOwnerCurrent(
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
      activeStreamAbortRef.current = attemptAbortController;
      activeStreamSelectionEpochRef.current =
        pendingChatTurn.guard.selectionEpoch;
      activeStreamUnadoptedDraftIdRef.current = null;
      activeStreamAdoptedSessionIdRef.current = pendingChatTurn.sessionId;
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
            if (!isOwnerCurrent()) {
              return;
            }
            dispatchAction({
              type: "main_content_invalidation_observed",
              version: nextVersion,
            });
            params.observeSessionInvalidation(
              pendingChatTurn.sessionId,
              nextVersion,
              "live",
            );
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
          publishSessionChange(pendingChatTurn.sessionId);
          abortSelectedSessionPoll();
          dispatchAction({ type: "live_stream_connected" });
          void params.refreshCatalog();
        },
      });

      if (!isOwnerCurrent()) {
        return;
      }
      if (streamResult.requestAcceptance === "accepted") {
        publishSessionChange(pendingChatTurn.sessionId);
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
        pendingChatTurn.onSubmissionRejected();
        replaceMessages(buildFailedChatSendHistory(
          pendingChatTurn.authoritativeMessages,
          pendingChatTurn.submittedContent,
          requestFailureMessage,
          Date.now(),
        ));
        dispatchAction({ type: "run_finished" });
        await params.refreshCatalog();
        return;
      }

      if (streamResult.wasAborted) {
        return;
      }

      try {
        const snapshotResult = await loadChatSnapshot(
          pendingChatTurn.sessionId,
          pendingChatTurn.guard,
          attemptAbortController.signal,
          true,
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
          await params.refreshCatalog();
          return;
        }
      } catch (error) {
        if (!isOwnerCurrent()) {
          return;
        }
        const disposition = resolveChatSnapshotFailureDisposition(error);
        if (
          disposition === "recover_unavailable"
          && params.recoverInvalidSessionSelection(
            pendingChatTurn.sessionId,
            t("chat.sessionUnavailable"),
          )
        ) {
          return;
        }
        const snapshotFailureMessage = error instanceof Error
          ? error.message
          : String(error);
        if (disposition === "block_workspace_reload") {
          markAssistantError(t("chat.errorFailed", {
            message: snapshotFailureMessage,
          }));
          dispatchAction({ type: "bootstrap_blocked" });
          return;
        }
        if (disposition === "retry_active_response") {
          if (streamResult.streamFailure !== null) {
            markAssistantError(t("chat.errorFailed", {
              message: streamResult.streamFailure.message,
            }));
          }
          return;
        }
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
          pendingChatTurn.onSubmissionRejected();
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
      await params.refreshCatalog();
    } finally {
      pendingChatTurn.retryAbortController.signal.removeEventListener(
        "abort",
        abortAttempt,
      );
      if (
        activeStreamAbortRef.current === attemptAbortController
        && !isSelectedStreamRetainedByStop(
          attemptAbortController,
          pendingChatTurn.sessionId,
          pendingChatTurn.guard.selectionEpoch,
        )
      ) {
        activeStreamAbortRef.current = null;
        activeStreamSelectionEpochRef.current = null;
        activeStreamUnadoptedDraftIdRef.current = null;
        activeStreamAdoptedSessionIdRef.current = null;
      }
    }
  }, [
    abortSelectedSessionPoll,
    appendAssistantChunk,
    dispatchAction,
    finalizeAssistant,
    isGuardCurrent,
    isSelectedStreamRetainedByStop,
    loadChatSnapshot,
    markAssistantError,
    params.observeSessionInvalidation,
    params.recoverInvalidSessionSelection,
    params.refreshCatalog,
    publishSessionChange,
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
        isGuardCurrent(cancellation.guard)
        && isChatTurnCancellationSettlementOwned(
          cancellation,
          pendingChatTurnCancellationRef.current,
          pendingChatTurnRef.current ?? activeChatTurnRef.current,
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
      },
    }), [isGuardCurrent, t]);
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
    exactChatTurn: OwnedChatTurn,
  ): Promise<ChatTurnCancellationResolution> => {
    const confirmedCancellation =
      confirmedChatTurnCancellationRef.current;
    if (
      confirmedCancellation?.sessionId === exactChatTurn.sessionId
      && confirmedCancellation.turnId === exactChatTurn.turnId
      && isGuardCurrent(confirmedCancellation.guard)
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
        ...exactChatTurn,
      };
    pendingChatTurnCancellationRef.current = cancellation;

    const resolution =
      await pendingChatTurnCancellationRunner.run(cancellation);
    if (
      resolution.kind === "confirmed"
      && stateRef.current.currentSessionId === exactChatTurn.sessionId
      && isGuardCurrent(exactChatTurn.guard)
    ) {
      const currentExactTurn = pendingChatTurnRef.current
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
  }, [
    isGuardCurrent,
    pendingChatTurnCancellationRunner,
    pendingChatTurnRunner,
  ]);

  const restoreChatTurnAfterCancellationRejection = useCallback((
    error: unknown,
    rejectedTurn: OwnedChatTurn,
  ): void => {
    const currentPendingTurn = pendingChatTurnRef.current;
    const currentTurn = currentPendingTurn ?? activeChatTurnRef.current;
    const currentSessionId = stateRef.current.currentSessionId;
    if (
      !isGuardCurrent(rejectedTurn.guard)
      || !shouldRestoreChatTurnAfterCancellationRejection(
        error,
        rejectedTurn,
        currentTurn,
        currentSessionId,
      )
    ) {
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
    }
    dispatchAction({ type: "run_started" });
  }, [dispatchAction, isGuardCurrent]);

  const releaseSupersededExactTurnStop = useCallback((
    exactChatTurn: OwnedChatTurn,
  ): void => {
    dispatchAction({
      type: "stop_completed",
      sessionId: exactChatTurn.sessionId,
    });
    const activeChatTurn = activeChatTurnRef.current;
    if (
      activeChatTurn?.sessionId === exactChatTurn.sessionId
      && activeChatTurn.ownerId !== exactChatTurn.ownerId
      && isGuardCurrent(activeChatTurn.guard)
    ) {
      dispatchAction({ type: "run_started" });
    }
  }, [dispatchAction, isGuardCurrent]);

  useEffect(() => {
    const stopOperation = stopOperationRef.current;
    if (
      stopOperation !== null
      && !isGuardCurrent(stopOperation.guard)
    ) {
      stopOperation.abortController.abort();
      stopOperationRef.current = null;
      dispatchAction({
        type: "stop_completed",
        sessionId: stopOperation.sessionId,
      });
    }
    const stopSnapshotReconciliation =
      stopSnapshotReconciliationRef.current;
    if (
      stopSnapshotReconciliation !== null
      && !isGuardCurrent(stopSnapshotReconciliation.guard)
    ) {
      stopSnapshotReconciliation.abortController.abort();
      stopSnapshotReconciliationRef.current = null;
    }
    if (
      confirmedChatTurnCancellationRef.current !== null
      && !isGuardCurrent(
        confirmedChatTurnCancellationRef.current.guard,
      )
    ) {
      confirmedChatTurnCancellationRef.current = null;
    }

    const pendingChatTurn = pendingChatTurnRef.current;
    if (
      pendingChatTurn !== null
      && !isGuardCurrent(pendingChatTurn.guard)
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
      && !isGuardCurrent(activeChatTurn.guard)
    ) {
      const activeCancellation = pendingChatTurnCancellationRef.current;
      if (activeCancellation?.ownerId === activeChatTurn.ownerId) {
        pendingChatTurnCancellationRunner.cancel(activeCancellation);
        pendingChatTurnCancellationRef.current = null;
      }
      activeChatTurnRef.current = null;
    }
  }, [
    dispatchAction,
    isGuardCurrent,
    params.selectionEpoch,
    params.target,
    pendingChatTurnCancellationRunner,
    pendingChatTurnRunner,
  ]);

  // The selection epoch is the lifecycle key. Same-epoch draft adoption is
  // an in-place target rekey and must not restart or detach this stream.
  useEffect(() => {
    const selectedTarget = params.target;
    const selectedSelectionEpoch = params.selectionEpoch;
    const activeStreamSelectionEpoch =
      activeStreamSelectionEpochRef.current;
    const ownsSameEpochAdoptedStream =
      selectedTarget.kind === "session"
      && activeStreamAbortRef.current !== null
      && activeStreamSelectionEpoch === selectedSelectionEpoch
      && activeStreamAdoptedSessionIdRef.current === selectedTarget.sessionId;
    if (ownsSameEpochAdoptedStream) {
      transcriptSelectionEpochRef.current = selectedSelectionEpoch;
      return;
    }
    if (
      activeStreamAbortRef.current !== null
      && (
        !params.isWorkspaceReady
        || activeStreamSelectionEpoch === null
        || shouldAbortChatStreamForSelectionChange(
          activeStreamSelectionEpoch,
          selectedSelectionEpoch,
          activeStreamUnadoptedDraftIdRef.current,
        )
      )
    ) {
      activeStreamAbortRef.current.abort();
      activeStreamAbortRef.current = null;
      activeStreamSelectionEpochRef.current = null;
      activeStreamUnadoptedDraftIdRef.current = null;
      activeStreamAdoptedSessionIdRef.current = null;
    }
    transcriptSelectionEpochRef.current = selectedSelectionEpoch;
    replaceMessages([]);

    const selectedSessionId = selectedTarget.kind === "session"
      ? selectedTarget.sessionId
      : null;
    dispatchAction({
      type: "selection_changed",
      sessionId: selectedSessionId,
    });
    if (!params.isWorkspaceReady) {
      return;
    }

    const guard: ChatSelectionGuard = {
      target: selectedTarget,
      selectionEpoch: selectedSelectionEpoch,
    };
    if (selectedTarget.kind === "draft") {
      dispatchAction({ type: "bootstrap_succeeded" });
      return;
    }

    let isDisposed = false;
    let activeAbortController: AbortController | null = null;
    let retryTimeoutId: number | null = null;
    const loadSelectedSnapshot = (): void => {
      if (isDisposed || !isGuardCurrent(guard)) {
        return;
      }

      const abortController = createSnapshotAbortController();
      activeAbortController = abortController;
      void loadChatSnapshot(
        selectedTarget.kind === "session"
          ? selectedTarget.sessionId
          : "",
        guard,
        abortController.signal,
        true,
      ).then((snapshotResult) => {
        if (
          snapshotResult.kind === "applied"
          && isGuardCurrent(guard)
        ) {
          dispatchAction({ type: "bootstrap_succeeded" });
        }
      }).catch((error: unknown) => {
        if (abortController.signal.aborted || !isGuardCurrent(guard)) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const disposition = resolveChatSnapshotFailureDisposition(error);
        if (
          disposition === "recover_unavailable"
          && params.recoverInvalidSessionSelection(
            selectedTarget.kind === "session"
              ? selectedTarget.sessionId
              : "",
            t("chat.sessionUnavailable"),
          )
        ) {
          return;
        }
        if (disposition === "retry_active_response") {
          retryTimeoutId = window.setTimeout(
            loadSelectedSnapshot,
            ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
          );
          return;
        }

        replaceMessages([{
          role: "assistant",
          content: [{ type: "text", text: t("chat.errorFailed", { message }) }],
          timestamp: Date.now(),
          isError: true,
          isStopped: false,
        }]);
        dispatchAction({
          type: disposition === "block_workspace_reload"
            ? "bootstrap_blocked"
            : "bootstrap_failed",
        });
      }).finally(() => {
        releaseSnapshotAbortController(abortController);
        if (activeAbortController === abortController) {
          activeAbortController = null;
        }
      });
    };
    loadSelectedSnapshot();

    return () => {
      isDisposed = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
      activeAbortController?.abort();
    };
  }, [
    params.isWorkspaceReady,
    params.selectionEpoch,
    params.target,
  ]);

  useEffect(() => {
    isControllerMountedRef.current = true;
    return () => {
      isControllerMountedRef.current = false;
      stopOperationRef.current?.abortController.abort();
      stopOperationRef.current = null;
      abortSelectedSessionPoll();
      stopSnapshotReconciliationRef.current?.abortController.abort();
      stopSnapshotReconciliationRef.current = null;
      confirmedChatTurnCancellationRef.current = null;
      pendingChatTurnRef.current?.retryAbortController.abort();
      pendingChatTurnRunner.cancelActive();
      pendingChatTurnCancellationRunner.cancelActive();
      if (
        activeStreamAbortRef.current !== null
        && shouldAbortChatStreamForControllerCleanup(
          activeStreamUnadoptedDraftIdRef.current,
        )
      ) {
        activeStreamAbortRef.current.abort();
        activeStreamAbortRef.current = null;
        activeStreamSelectionEpochRef.current = null;
        activeStreamUnadoptedDraftIdRef.current = null;
        activeStreamAdoptedSessionIdRef.current = null;
      }
      for (const abortController of snapshotAbortControllersRef.current) {
        abortController.abort();
      }
      snapshotAbortControllersRef.current.clear();
    };
  }, [
    abortSelectedSessionPoll,
    pendingChatTurnCancellationRunner,
    pendingChatTurnRunner,
  ]);

  useEffect(() => {
    if (
      !state.isHistoryLoaded
      || state.currentSessionId === null
      || state.runState !== "running"
      || state.isLiveStreamConnected
      || params.target.kind !== "session"
      || state.currentSessionId !== params.target.sessionId
    ) {
      return;
    }

    const guard: ChatSelectionGuard = {
      target: params.target,
      selectionEpoch: params.selectionEpoch,
    };
    let activePollAbortController: AbortController | null = null;
    const selectedSessionId = params.target.sessionId;
    const pollSnapshot = createSingleFlightChatSnapshotPoller(
      async (): Promise<void> => {
        if (
          !isGuardCurrent(guard)
          || stateRef.current.isLiveStreamConnected
        ) {
          return;
        }
        const pendingChatTurn = pendingChatTurnRef.current;
        if (
          pendingChatTurn !== null
          && pendingChatTurn.sessionId === selectedSessionId
          && isGuardCurrent(pendingChatTurn.guard)
          && !pendingChatTurn.retryAbortController.signal.aborted
        ) {
          await pendingChatTurnRunner.run(pendingChatTurn);
          return;
        }

        const abortController = createSnapshotAbortController();
        activePollAbortController = abortController;
        selectedSessionPollAbortControllerRef.current = abortController;
        try {
          await loadChatSnapshot(
            selectedSessionId,
            guard,
            abortController.signal,
            true,
          );
        } catch (error) {
          if (
            abortController.signal.aborted
            || !isGuardCurrent(guard)
            || stateRef.current.isLiveStreamConnected
          ) {
            return;
          }

          const message = error instanceof Error
            ? error.message
            : String(error);
          const disposition = resolveChatSnapshotFailureDisposition(error);
          if (
            disposition === "recover_unavailable"
            && params.recoverInvalidSessionSelection(
              selectedSessionId,
              t("chat.sessionUnavailable"),
            )
          ) {
            return;
          }
          if (disposition === "retry_active_response") {
            return;
          }
          if (disposition === "block_workspace_reload") {
            startAssistantMessage();
            markAssistantError(t("chat.errorFailed", { message }));
            dispatchAction({ type: "bootstrap_blocked" });
            return;
          }

          markAssistantError(t("chat.errorFailed", { message }));
          if (!isPendingChatTurnForSession(
            pendingChatTurnRef.current,
            stateRef.current.currentSessionId,
          )) {
            dispatchAction({ type: "run_interrupted" });
          }
        } finally {
          releaseSnapshotAbortController(abortController);
          if (activePollAbortController === abortController) {
            activePollAbortController = null;
          }
          if (
            selectedSessionPollAbortControllerRef.current
              === abortController
          ) {
            selectedSessionPollAbortControllerRef.current = null;
          }
        }
      },
    );

    const intervalId = window.setInterval(
      () => {
        void pollSnapshot();
      },
      ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(intervalId);
      activePollAbortController?.abort();
      if (
        selectedSessionPollAbortControllerRef.current
          === activePollAbortController
      ) {
        selectedSessionPollAbortControllerRef.current = null;
      }
    };
  }, [
    createSnapshotAbortController,
    dispatchAction,
    isGuardCurrent,
    loadChatSnapshot,
    markAssistantError,
    pendingChatTurnRunner,
    params.selectionEpoch,
    params.target,
    params.recoverInvalidSessionSelection,
    releaseSnapshotAbortController,
    startAssistantMessage,
    state.currentSessionId,
    state.isHistoryLoaded,
    state.isLiveStreamConnected,
    state.runState,
    t,
  ]);

  const sendMessage = useCallback(async (
    sendParams: SendChatMessageParams,
  ): Promise<void> => {
    const currentState = stateRef.current;
    if (
      selectIsAssistantRunActive(currentState)
      || currentState.isLiveStreamConnected
      || selectIsSelectedSessionStopping(currentState)
      || !currentState.isHistoryLoaded
      || currentState.currentSessionId !== (
        params.target.kind === "session"
          ? params.target.sessionId
          : null
      )
      || (
        pendingChatTurnCancellationRef.current !== null
        && isGuardCurrent(
          pendingChatTurnCancellationRef.current.guard,
        )
      )
      || (
        activeChatTurnRef.current !== null
        && isGuardCurrent(activeChatTurnRef.current.guard)
        && isChatTurnOwnerForSession(
          activeChatTurnRef.current,
          currentState.currentSessionId,
        )
      )
      || (
        confirmedChatTurnCancellationRef.current !== null
        && isGuardCurrent(
          confirmedChatTurnCancellationRef.current.guard,
        )
        && isChatTurnOwnerForSession(
          confirmedChatTurnCancellationRef.current,
          currentState.currentSessionId,
        )
      )
      || (
        pendingChatTurnRef.current !== null
        && isGuardCurrent(pendingChatTurnRef.current.guard)
        && isPendingChatTurnForSession(
          pendingChatTurnRef.current,
          currentState.currentSessionId,
        )
      )
      || (
        freshDraftChatTurnRef.current !== null
        && isGuardCurrent(freshDraftChatTurnRef.current.guard)
      )
    ) {
      sendParams.onSubmissionRejected();
      return;
    }

    const initialGuard: ChatSelectionGuard = {
      target: params.target,
      selectionEpoch: params.selectionEpoch,
    };
    if (!isGuardCurrent(initialGuard)) {
      sendParams.onSubmissionRejected();
      return;
    }

    const authoritativeMessagesBeforeSend = messages;
    const preparedRequest = prepareChatSendRequest(
      sendParams.text,
      sendParams.attachments,
      t,
    );
    if (preparedRequest.kind === "empty") {
      sendParams.onSubmissionRejected();
      return;
    }
    if (preparedRequest.kind === "invalid_attachment") {
      sendParams.onSubmissionRejected();
      startAssistantMessage();
      markAssistantError(preparedRequest.errorMessage);
      return;
    }

    appendUserMessage(preparedRequest.contentParts);
    dispatchAction({ type: "run_started" });
    startAssistantMessage();

    if (preparedRequest.kind === "too_large") {
      sendParams.onSubmissionRejected();
      markAssistantError(preparedRequest.errorMessage);
      dispatchAction({ type: "run_finished" });
      return;
    }

    const turnId = crypto.randomUUID();
    assertCanonicalChatTurnId(turnId);
    if (initialGuard.target.kind === "session") {
      const transport = createChatSendTransport(
        initialGuard.target,
        preparedRequest.contentParts,
        turnId,
      );
      const pendingChatTurn: PendingChatTurn = {
        ownerId: Symbol(turnId),
        sessionId: initialGuard.target.sessionId,
        turnId,
        guard: initialGuard,
        requestBody: transport.requestBody,
        submittedContent: preparedRequest.contentParts,
        authoritativeMessages: authoritativeMessagesBeforeSend,
        retryAbortController: new AbortController(),
        onSubmissionRejected: sendParams.onSubmissionRejected,
      };
      pendingChatTurnRef.current = pendingChatTurn;
      pendingChatTurnCancellationRef.current = null;
      await pendingChatTurnRunner.run(pendingChatTurn);
      return;
    }

    const abortController = new AbortController();
    const freshDraftChatTurn: FreshDraftChatTurn = {
      ownerId: Symbol(turnId),
      guard: initialGuard,
      abortController,
    };
    freshDraftChatTurnRef.current = freshDraftChatTurn;
    activeStreamAbortRef.current = abortController;
    activeStreamSelectionEpochRef.current = initialGuard.selectionEpoch;
    activeStreamAdoptedSessionIdRef.current = null;
    let runGuard = initialGuard;
    const freshDraftId = params.target.kind === "draft"
      ? params.target.draftId
      : null;
    activeStreamUnadoptedDraftIdRef.current = freshDraftId;
    const transport = createChatSendTransport(
      params.target,
      preparedRequest.contentParts,
      turnId,
    );

    const acceptResponseSessionId = (sessionId: string): void => {
      if (freshDraftId === null) {
        if (
          runGuard.target.kind !== "session"
          || runGuard.target.sessionId !== sessionId
          || !isGuardCurrent(runGuard)
        ) {
          return;
        }
        dispatchAction({
          type: "server_session_accepted",
          sessionId,
        });
        return;
      }

      const ownsFreshDraftStream =
        freshDraftChatTurnRef.current?.ownerId === freshDraftChatTurn.ownerId
        && activeStreamAbortRef.current === abortController
        && activeStreamSelectionEpochRef.current
          === initialGuard.selectionEpoch
        && activeStreamUnadoptedDraftIdRef.current === freshDraftId
        && activeStreamAdoptedSessionIdRef.current === null;
      const adoption = params.adoptDraftSession(
        freshDraftId,
        sessionId,
        initialGuard.selectionEpoch,
      );
      const ownsSelectedAdoption =
        adoption.kind === "selected" && ownsFreshDraftStream;
      if (freshDraftChatTurnRef.current?.ownerId === freshDraftChatTurn.ownerId) {
        freshDraftChatTurnRef.current = null;
      }
      if (ownsFreshDraftStream) {
        activeStreamUnadoptedDraftIdRef.current = null;
        activeStreamAdoptedSessionIdRef.current = sessionId;
        if (ownsSelectedAdoption) {
          activeStreamSelectionEpochRef.current = adoption.selectionEpoch;
        }
      }

      runGuard = {
        target: adoption.target,
        selectionEpoch: ownsSelectedAdoption
          ? adoption.selectionEpoch
          : runGuard.selectionEpoch,
      };
      if (
        ownsSelectedAdoption
        && isControllerMountedRef.current
        && isGuardCurrent(runGuard)
      ) {
        replaceMessages(buildPendingChatSendHistory(
          authoritativeMessagesBeforeSend,
          preparedRequest.contentParts,
          Date.now(),
        ));
        dispatchAction({
          type: "server_session_created",
          sessionId,
        });
        dispatchAction({ type: "run_started" });
      } else {
        abortController.abort();
      }
      params.observeSessionInvalidation(sessionId, 0, "snapshot");
    };

    const streamResult = await streamChatResponse({
      url: transport.url,
      requestBody: transport.requestBody,
      signal: abortController.signal,
      abortStream: (): void => {
        abortController.abort();
      },
      t,
      handlers: {
        appendAssistantChunk: (text, streamPosition): void => {
          if (isControllerMountedRef.current && isGuardCurrent(runGuard)) {
            appendAssistantChunk(text, streamPosition);
          }
        },
        upsertReasoningSummary: (reasoningSummary): void => {
          if (isControllerMountedRef.current && isGuardCurrent(runGuard)) {
            upsertReasoningSummary(reasoningSummary);
          }
        },
        upsertToolCall: (toolCall): void => {
          if (isControllerMountedRef.current && isGuardCurrent(runGuard)) {
            upsertToolCall(toolCall);
          }
        },
        markAssistantError: (errorMessage): void => {
          if (isControllerMountedRef.current && isGuardCurrent(runGuard)) {
            markAssistantError(errorMessage);
          }
        },
        applyMainContentInvalidationVersion: (nextVersion): void => {
          if (
            isControllerMountedRef.current
            && runGuard.target.kind === "session"
            && isGuardCurrent(runGuard)
          ) {
            dispatchAction({
              type: "main_content_invalidation_observed",
              version: nextVersion,
            });
            params.observeSessionInvalidation(
              runGuard.target.sessionId,
              nextVersion,
              "live",
            );
          }
        },
      },
      onSessionIdReceived: acceptResponseSessionId,
      onLiveStreamConnected: (): void => {
        if (isControllerMountedRef.current && isGuardCurrent(runGuard)) {
          if (runGuard.target.kind === "session") {
            publishSessionChange(runGuard.target.sessionId);
          }
          abortSelectedSessionPoll();
          dispatchAction({ type: "live_stream_connected" });
          if (freshDraftId === null) {
            void params.refreshCatalog();
          }
        }
      },
    });

    if (
      activeStreamAbortRef.current === abortController
      && (
        runGuard.target.kind !== "session"
        || !isSelectedStreamRetainedByStop(
          abortController,
          runGuard.target.sessionId,
          runGuard.selectionEpoch,
        )
      )
    ) {
      activeStreamAbortRef.current = null;
      activeStreamSelectionEpochRef.current = null;
      activeStreamUnadoptedDraftIdRef.current = null;
      activeStreamAdoptedSessionIdRef.current = null;
    }
    if (freshDraftChatTurnRef.current?.ownerId === freshDraftChatTurn.ownerId) {
      freshDraftChatTurnRef.current = null;
    }
    const isUnadoptedFreshDraft = freshDraftId !== null
      && runGuard.target.kind === "draft";
    if (isUnadoptedFreshDraft) {
      if (streamResult.requestAcceptance === "rejected") {
        sendParams.onSubmissionRejected();
      } else {
        sendParams.onSubmissionUnresolved();
      }
    }
    if (
      !isControllerMountedRef.current
      || !isGuardCurrent(runGuard)
    ) {
      return;
    }
    if (
      streamResult.requestAcceptance === "accepted"
      && runGuard.target.kind === "session"
    ) {
      publishSessionChange(runGuard.target.sessionId);
    }

    if (streamResult.receivedContent) {
      finalizeAssistant();
    }
    dispatchAction({ type: "live_stream_disconnected" });

    if (isUnadoptedFreshDraft) {
      const requestFailureMessage = streamResult.streamFailure === null
        ? t("chat.errorNoResponse")
        : streamResult.streamFailure.message;
      markAssistantError(requestFailureMessage);
      dispatchAction({ type: "run_finished" });
      await params.refreshCatalog();
      return;
    }

    if (
      isDefinitiveChatRequestRejection(streamResult)
      && !streamResult.wasAborted
    ) {
      const requestFailureMessage = streamResult.streamFailure === null
        ? t("chat.errorNoResponse")
        : streamResult.streamFailure.message;
      sendParams.onSubmissionRejected();
      markAssistantError(requestFailureMessage);
      dispatchAction({ type: "run_finished" });
      await params.refreshCatalog();
      return;
    }

    if (
      !streamResult.wasAborted
      && runGuard.target.kind === "session"
    ) {
      const snapshotAbortController = createSnapshotAbortController();
      try {
        const snapshotResult = await loadChatSnapshot(
          runGuard.target.sessionId,
          runGuard,
          snapshotAbortController.signal,
          true,
        );
        if (
          snapshotResult.snapshot !== null
          && shouldSuppressStreamFailure(snapshotResult.snapshot)
        ) {
          await params.refreshCatalog();
          return;
        }
      } catch (error) {
        if (
          !snapshotAbortController.signal.aborted
          && isGuardCurrent(runGuard)
        ) {
          const disposition = resolveChatSnapshotFailureDisposition(error);
          if (
            disposition === "recover_unavailable"
            && params.recoverInvalidSessionSelection(
              runGuard.target.kind === "session"
                ? runGuard.target.sessionId
                : "",
              t("chat.sessionUnavailable"),
            )
          ) {
            await params.refreshCatalog();
            return;
          }
          if (disposition === "retry_active_response") {
            await params.refreshCatalog();
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          if (disposition === "block_workspace_reload") {
            markAssistantError(t("chat.errorFailed", { message }));
            dispatchAction({ type: "bootstrap_blocked" });
            await params.refreshCatalog();
            return;
          }
          if (streamResult.streamFailure === null) {
            markAssistantError(t("chat.errorFailed", { message }));
            dispatchAction({ type: "run_interrupted" });
          }
        }
      } finally {
        releaseSnapshotAbortController(snapshotAbortController);
      }
    }

    if (
      streamResult.streamFailure !== null
      && !streamResult.wasAborted
      && isGuardCurrent(runGuard)
    ) {
      markAssistantError(t("chat.errorFailed", {
        message: streamResult.streamFailure.message,
      }));
      dispatchAction({ type: "run_interrupted" });
    }
    await params.refreshCatalog();
  }, [
    abortSelectedSessionPoll,
    appendAssistantChunk,
    appendUserMessage,
    createSnapshotAbortController,
    dispatchAction,
    finalizeAssistant,
    isGuardCurrent,
    isSelectedStreamRetainedByStop,
    loadChatSnapshot,
    markAssistantError,
    messages,
    params.adoptDraftSession,
    params.observeSessionInvalidation,
    params.recoverInvalidSessionSelection,
    params.refreshCatalog,
    params.selectionEpoch,
    params.target,
    pendingChatTurnRunner,
    publishSessionChange,
    releaseSnapshotAbortController,
    replaceMessages,
    startAssistantMessage,
    t,
    upsertReasoningSummary,
    upsertToolCall,
  ]);

  const stopMessage = useCallback(async (): Promise<void> => {
    const currentState = stateRef.current;
    if (
      params.target.kind !== "session"
      || currentState.currentSessionId !== params.target.sessionId
      || !selectIsAssistantRunActive(currentState)
      || selectIsSelectedSessionStopping(currentState)
    ) {
      return;
    }

    const sessionId = params.target.sessionId;
    const guard: ChatSelectionGuard = {
      target: params.target,
      selectionEpoch: params.selectionEpoch,
    };
    if (!isGuardCurrent(guard)) {
      return;
    }

    stopOperationRef.current?.abortController.abort();
    const stopOwner: OwnedChatStopOperation = {
      ownerId: Symbol(sessionId),
      sessionId,
      guard,
      abortController: new AbortController(),
    };
    stopOperationRef.current = stopOwner;
    const isStopOwnerCurrent = (): boolean =>
      isGuardCurrent(stopOwner.guard)
      && isChatStopOperationOwnerCurrent(
        stopOwner,
        stopOperationRef.current,
        stateRef.current.currentSessionId,
      );
    const getSelectedStreamController = (): AbortController | null =>
      activeStreamSelectionEpochRef.current === guard.selectionEpoch
        && activeStreamAdoptedSessionIdRef.current === sessionId
        ? activeStreamAbortRef.current
        : null;
    const stopStreamController = getSelectedStreamController();
    const pendingChatTurn = pendingChatTurnRef.current;
    const exactChatTurn =
      pendingChatTurn?.sessionId === sessionId
        && isGuardCurrent(pendingChatTurn.guard)
        ? pendingChatTurn
        : activeChatTurnRef.current?.sessionId === sessionId
            && isGuardCurrent(activeChatTurnRef.current.guard)
          ? activeChatTurnRef.current
          : confirmedChatTurnCancellationRef.current?.sessionId === sessionId
              && isGuardCurrent(
                confirmedChatTurnCancellationRef.current.guard,
              )
            ? confirmedChatTurnCancellationRef.current
            : null;
    const retainedStoppedChatTurn =
      pendingChatTurn?.ownerId === exactChatTurn?.ownerId
        ? pendingChatTurn
        : null;
    if (
      pendingChatTurn !== null
      && pendingChatTurn.sessionId === sessionId
    ) {
      pendingChatTurn.retryAbortController.abort();
      pendingChatTurnRunner.cancel(pendingChatTurn);
    }

    dispatchAction({
      type: "stop_requested",
      sessionId,
    });

    let exactCancellationResolution: ChatTurnCancellationResolution | null =
      null;
    let sessionStopConfirmed = false;
    let stopRequestFailed = false;
    try {
      if (exactChatTurn !== null) {
        exactCancellationResolution = await cancelExactChatTurn(exactChatTurn);
      } else {
        await postStopChatSession(
          sessionId,
          null,
          stopOwner.abortController.signal,
          t,
        );
        sessionStopConfirmed = true;
      }
    } catch (error) {
      stopRequestFailed = true;
      if (isStopOwnerCurrent()) {
        if (exactChatTurn !== null) {
          restoreChatTurnAfterCancellationRejection(error, exactChatTurn);
        }
        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        dispatchAction({
          type: "stop_failed",
          sessionId,
        });
      }
    }

    if (!isStopOwnerCurrent()) {
      return;
    }
    stopStreamController?.abort();
    const isStopStreamSettlementOwned = isChatStopSettlementOwned(
      sessionId,
      stateRef.current.currentSessionId,
      stopStreamController,
      getSelectedStreamController(),
    );
    if (isStopStreamSettlementOwned) {
      activeStreamAbortRef.current = null;
      activeStreamSelectionEpochRef.current = null;
      activeStreamUnadoptedDraftIdRef.current = null;
      activeStreamAdoptedSessionIdRef.current = null;
      dispatchAction({ type: "live_stream_disconnected" });
    }

    if (stopRequestFailed) {
      if (stopOperationRef.current?.ownerId === stopOwner.ownerId) {
        stopOperationRef.current = null;
      }
      await params.refreshCatalog();
      return;
    }

    if (exactCancellationResolution?.kind === "superseded") {
      if (exactChatTurn !== null) {
        releaseSupersededExactTurnStop(exactChatTurn);
      }
      if (stopOperationRef.current?.ownerId === stopOwner.ownerId) {
        stopOperationRef.current = null;
      }
      await params.refreshCatalog();
      return;
    }

    const stopConfirmed =
      exactCancellationResolution?.kind === "confirmed"
      || sessionStopConfirmed;
    if (stopConfirmed) {
      publishSessionChange(sessionId);
    }
    const isStopSettlementOwnerCurrent = (): boolean =>
      isStopOwnerCurrent()
      && !stopOwner.abortController.signal.aborted
      && isChatStopSettlementOwned(
        sessionId,
        stateRef.current.currentSessionId,
        null,
        getSelectedStreamController(),
      );
    let stopSnapshotSettled = false;
    let stopWasSupersededBySnapshot = false;
    if (stopConfirmed && isStopStreamSettlementOwned) {
      try {
        const snapshotResolution =
          await reconcileConfirmedStopSnapshotForOwner(
            sessionId,
            exactChatTurn?.turnId ?? null,
            guard,
            stopOwner.abortController.signal,
            isStopSettlementOwnerCurrent,
          );
        if (
          snapshotResolution.kind === "settled"
          && isStopSettlementOwnerCurrent()
        ) {
          if (retainedStoppedChatTurn !== null) {
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
          const disposition = resolveChatSnapshotFailureDisposition(error);
          dispatchAction({
            type: "stop_failed",
            sessionId,
          });
          if (
            disposition === "recover_unavailable"
            && params.recoverInvalidSessionSelection(
              sessionId,
              t("chat.sessionUnavailable"),
            )
          ) {
            stopWasSupersededBySnapshot = true;
          } else {
            const message = error instanceof Error
              ? error.message
              : String(error);
            markAssistantError(t("chat.errorFailed", { message }));
            if (disposition === "block_workspace_reload") {
              dispatchAction({ type: "bootstrap_blocked" });
            }
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
    }
    if (
      isStopOwnerCurrent()
      && !stopWasSupersededBySnapshot
      && stopConfirmed
      && stopSnapshotSettled
    ) {
      dispatchAction({
        type: "stop_completed",
        sessionId,
      });
      publishSessionChange(sessionId);
    }
    if (stopOperationRef.current?.ownerId === stopOwner.ownerId) {
      stopOperationRef.current = null;
    }
    await params.refreshCatalog();
  }, [
    cancelExactChatTurn,
    dispatchAction,
    isGuardCurrent,
    markAssistantError,
    params.refreshCatalog,
    params.recoverInvalidSessionSelection,
    params.selectionEpoch,
    params.target,
    pendingChatTurnRunner,
    publishSessionChange,
    reconcileConfirmedStopSnapshotForOwner,
    releaseSupersededExactTurnStop,
    replaceMessages,
    restoreChatTurnAfterCancellationRejection,
    t,
  ]);

  return {
    messages,
    runState: state.runState,
    isHistoryLoaded: state.isHistoryLoaded,
    isTranscriptDisplayReady:
      transcriptSelectionEpochRef.current === params.selectionEpoch
      && state.bootstrapStatus !== "loading",
    isAssistantRunActive,
    isLiveStreamConnected: state.isLiveStreamConnected,
    isStopping,
    currentSessionId: state.currentSessionId,
    composerAction,
    sendMessage,
    stopMessage,
  };
};
