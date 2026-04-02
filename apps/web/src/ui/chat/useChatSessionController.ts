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
import type { PendingAttachment } from "./FileAttachment";
import type { ChatSessionSnapshot } from "./chatSessionSnapshot";
import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
  shouldSuppressStreamFailure,
  type ChatComposerAction,
  type ChatRunState,
} from "./streamRecovery";
import {
  deleteChatConversation,
  fetchChatSessionSnapshot,
  postStopChatSession,
  prepareChatSendRequest,
  streamChatResponse,
} from "./chatSessionControllerRuntime";
import {
  createInitialChatSessionControllerState,
  reduceChatSessionControllerState,
  selectComposerAction,
  selectEffectiveSnapshotRunState,
  selectIsAssistantRunActive,
  shouldRefreshMainContentForVersion,
  shouldReplaceHistoryForSnapshot,
  type ChatMainContentInvalidationSource,
  type ChatSessionControllerAction,
} from "./chatSessionControllerState";

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
  sendMessage: (params: SendChatMessageParams) => Promise<void>;
  stopMessage: () => Promise<void>;
  clearConversation: () => Promise<void>;
}>;

type NormalizedChatSessionSnapshot = Readonly<{
  sessionId: string;
  runState: ChatRunState;
  updatedAt: number;
  mainContentInvalidationVersion: number;
  messages: ChatSessionSnapshot["messages"];
}>;

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

    if (!shouldRefresh || mode !== "sidebar") {
      return;
    }

    startTransition(() => {
      router.refresh();
    });
  }, [dispatchAction, mode, router]);

  const loadChatSnapshot = useCallback(async (
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    replaceHistory: boolean,
  ): Promise<NormalizedChatSessionSnapshot> => {
    const payload = await fetchChatSessionSnapshot(sessionId, signal, t);
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

    if (shouldRefresh && mode === "sidebar") {
      startTransition(() => {
        router.refresh();
      });
    }

    return {
      ...payload,
      runState: effectiveRunState,
    };
  }, [dispatchAction, mode, replaceMessages, router, t]);

  useEffect(() => {
    const abortController = new AbortController();
    dispatchAction({ type: "workspace_reset" });
    replaceMessages([]);

    void (async (): Promise<void> => {
      let didFail = false;

      try {
        await loadChatSnapshot(undefined, abortController.signal, true);
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
    if (!state.isHistoryLoaded || state.currentSessionId === null || state.runState !== "running") {
      return;
    }

    const intervalId = setInterval(() => {
      void loadChatSnapshot(state.currentSessionId ?? undefined, undefined, true).catch((error) => {
        if (stateRef.current.isLiveStreamConnected) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        dispatchAction({ type: "run_interrupted" });
      });
    }, ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [
    dispatchAction,
    loadChatSnapshot,
    markAssistantError,
    state.currentSessionId,
    state.isHistoryLoaded,
    state.runState,
    t,
  ]);

  const sendMessage = useCallback(async (
    sendParams: SendChatMessageParams,
  ): Promise<void> => {
    const currentState = stateRef.current;
    if (selectIsAssistantRunActive(currentState) || currentState.isLiveStreamConnected || currentState.isStopping) {
      return;
    }

    if (!currentState.isHistoryLoaded) {
      return;
    }

    const preparedRequest = prepareChatSendRequest(
      sendParams.text,
      sendParams.attachments,
      currentState.currentSessionId,
      t,
    );
    if (preparedRequest.kind === "empty") {
      return;
    }

    appendUserMessage(preparedRequest.contentParts);
    dispatchAction({ type: "run_started" });
    startAssistantMessage();

    const abortController = new AbortController();
    abortRef.current = abortController;

    if (preparedRequest.kind === "too_large") {
      markAssistantError(preparedRequest.errorMessage);
      dispatchAction({ type: "run_finished" });
      abortRef.current = null;
      return;
    }

    const streamResult = await streamChatResponse({
      requestBody: preparedRequest.requestBody,
      signal: abortController.signal,
      abortStream: (): void => {
        abortController.abort();
      },
      t,
      handlers: {
        appendAssistantChunk,
        upsertReasoningSummary,
        upsertToolCall,
        markAssistantError,
        applyMainContentInvalidationVersion: (nextVersion): void => {
          applyMainContentInvalidationVersion(nextVersion, "live");
        },
      },
      onSessionIdReceived: (sessionId): void => {
        dispatchAction({
          type: "server_session_accepted",
          sessionId,
        });
      },
      onLiveStreamConnected: (): void => {
        dispatchAction({ type: "live_stream_connected" });
      },
    });

    if (streamResult.receivedContent) {
      finalizeAssistant();
    }

    dispatchAction({ type: "live_stream_disconnected" });
    abortRef.current = null;

    if (streamResult.failureStage === "request" && !streamResult.wasAborted) {
      const requestFailureMessage = streamResult.streamFailure === null
        ? t("chat.errorNoResponse")
        : streamResult.streamFailure.message;
      markAssistantError(requestFailureMessage);
      dispatchAction({ type: "run_finished" });
      return;
    }

    const sessionIdToReload = streamResult.responseSessionId ?? stateRef.current.currentSessionId ?? undefined;
    if (!streamResult.wasAborted && sessionIdToReload !== undefined) {
      try {
        const snapshot = await loadChatSnapshot(sessionIdToReload, undefined, true);
        if (shouldSuppressStreamFailure(snapshot)) {
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (streamResult.streamFailure === null) {
          markAssistantError(t("chat.errorFailed", { message }));
          dispatchAction({ type: "run_interrupted" });
        }
      }
    }

    if (streamResult.streamFailure !== null && !streamResult.wasAborted) {
      markAssistantError(t("chat.errorFailed", { message: streamResult.streamFailure.message }));
      dispatchAction({ type: "run_interrupted" });
    }
  }, [
    appendAssistantChunk,
    appendUserMessage,
    applyMainContentInvalidationVersion,
    dispatchAction,
    finalizeAssistant,
    loadChatSnapshot,
    markAssistantError,
    startAssistantMessage,
    t,
    upsertReasoningSummary,
    upsertToolCall,
  ]);

  const stopMessage = useCallback(async (): Promise<void> => {
    const currentState = stateRef.current;
    if (currentState.currentSessionId === null || !selectIsAssistantRunActive(currentState) || currentState.isStopping) {
      return;
    }

    dispatchAction({
      type: "stop_requested",
      sessionId: currentState.currentSessionId,
    });

    try {
      await postStopChatSession(currentState.currentSessionId);
    } catch {
      // The stop request is best-effort, but we still abort the local stream below.
    } finally {
      if (abortRef.current !== null) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      dispatchAction({ type: "live_stream_disconnected" });

      try {
        await loadChatSnapshot(currentState.currentSessionId, undefined, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        dispatchAction({ type: "run_interrupted" });
      } finally {
        dispatchAction({ type: "stop_completed" });
      }
    }
  }, [dispatchAction, loadChatSnapshot, markAssistantError, t]);

  const clearConversation = useCallback(async (): Promise<void> => {
    const currentState = stateRef.current;
    if (currentState.currentSessionId !== null && selectIsAssistantRunActive(currentState)) {
      try {
        await postStopChatSession(currentState.currentSessionId);
      } catch {
        // Continue clearing the UI even if stop fails.
      }
    }

    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    dispatchAction({ type: "live_stream_disconnected" });
    dispatchAction({ type: "stop_completed" });
    if (currentState.currentSessionId !== null) {
      dispatchAction({
        type: "stopped_session_cleared",
        sessionId: currentState.currentSessionId,
      });
    }

    try {
      const payload = await deleteChatConversation(currentState.currentSessionId, t);
      dispatchAction({
        type: "conversation_cleared",
        sessionId: payload.sessionId,
      });
      clearHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markAssistantError(t("chat.errorFailed", { message }));
    }
  }, [clearHistory, dispatchAction, markAssistantError, t]);

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
    isStopping: state.isStopping,
    currentSessionId: state.currentSessionId,
    composerAction,
    acceptServerSessionId,
    sendMessage,
    stopMessage,
    clearConversation,
  };
};
