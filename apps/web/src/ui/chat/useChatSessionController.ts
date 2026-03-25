"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "next/navigation";

import { fetchWithCsrf } from "@/lib/csrf";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { ContentPart } from "@/server/chat/types";
import {
  useChatHistory,
  type StoredMessage,
} from "@/ui/hooks/useChatHistory";
import type { PendingAttachment } from "./FileAttachment";
import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
  getChatComposerAction,
  getEffectiveSnapshotRunState,
  isChatRunActive,
  shouldRefreshMainContentFromLiveEvent,
  shouldRefreshMainContentFromSnapshot,
  shouldReplaceHistoryFromSnapshot,
  shouldSuppressStreamFailure,
  type ChatComposerAction,
  type ChatRunState,
} from "./streamRecovery";
import type { ChatSessionSnapshot } from "./chatSessionSnapshot";
import {
  applyChatStreamEvent,
  drainChatStreamChunk,
} from "./chatStreamTransport";

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
  sendMessage: (params: SendChatMessageParams) => Promise<void>;
  stopMessage: () => Promise<void>;
  clearConversation: () => Promise<void>;
}>;

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// 90 MB — safely under Cloudflare (100 MB) and Next.js proxyClientMaxBodySize (100 MB)
const MAX_BODY_BYTES = 90 * 1024 * 1024;

const buildContentParts = (
  text: string,
  attachments: ReadonlyArray<PendingAttachment>,
): ReadonlyArray<ContentPart> => {
  const parts: Array<ContentPart> = [];

  for (const attachment of attachments) {
    if (IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
      parts.push({
        type: "image",
        mediaType: attachment.mediaType,
        base64Data: attachment.base64Data,
      });
      continue;
    }

    parts.push({
      type: "file",
      mediaType: attachment.mediaType,
      base64Data: attachment.base64Data,
      fileName: attachment.fileName,
    });
  }

  if (text.trim().length > 0) {
    parts.push({
      type: "text",
      text: text.trim(),
    });
  }

  return parts;
};

const sanitizeErrorText = (
  status: number,
  raw: string,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string => {
  if (raw.trim().length === 0 && status === 500) {
    return t("chat.errorTooLarge", { sizeMb: "?", limitMb: "?" });
  }

  if (raw.includes("<html") || raw.includes("<!DOCTYPE")) {
    const titleMatch = raw.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch !== null) {
      return titleMatch[1];
    }

    return t("chat.errorBlocked");
  }

  return raw;
};

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

  const [isHistoryLoaded, setIsHistoryLoaded] = useState<boolean>(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [runState, setRunState] = useState<ChatRunState>("idle");
  const [isLiveStreamConnected, setIsLiveStreamConnected] = useState<boolean>(false);
  const [isStopping, setIsStopping] = useState<boolean>(false);

  const abortRef = useRef<AbortController | null>(null);
  const stoppedSessionIdsRef = useRef<Set<string>>(new Set());
  const lastSnapshotUpdatedAtRef = useRef<number | null>(null);
  const lastMainContentInvalidationVersionRef = useRef<number | null>(null);

  const isAssistantRunActive = isChatRunActive(runState);
  const composerAction = getChatComposerAction(runState);

  /**
   * Applies the canonical session-level invalidation version observed through
   * either live SSE or `/api/chat` snapshot polling.
   *
   * A completed tool-call transcript item alone must not refresh the route.
   * The sidebar refreshes only after the runtime has persisted a newer
   * `mainContentInvalidationVersion`, which guarantees that a successful
   * mutating tool call committed to local state.
   */
  const applyMainContentInvalidationVersion = useCallback((
    nextVersion: number,
    source: "live" | "snapshot",
  ): void => {
    const previousVersion = lastMainContentInvalidationVersionRef.current;
    const shouldRefresh = source === "live"
      ? shouldRefreshMainContentFromLiveEvent(previousVersion, nextVersion)
      : shouldRefreshMainContentFromSnapshot(previousVersion, nextVersion);

    lastMainContentInvalidationVersionRef.current = previousVersion === null
      ? nextVersion
      : Math.max(previousVersion, nextVersion);

    if (!shouldRefresh || mode !== "sidebar") {
      return;
    }

    startTransition(() => {
      router.refresh();
    });
  }, [mode, router]);

  const loadChatSnapshot = useCallback(async (
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    replaceHistory: boolean,
  ): Promise<ChatSessionSnapshot> => {
    const url = sessionId === undefined
      ? "/api/chat"
      : `/api/chat?sessionId=${encodeURIComponent(sessionId)}`;
    const response = await fetchWithCsrf(url, {
      method: "GET",
      signal,
    });

    if (!response.ok) {
      const rawError = await response.text();
      throw new Error(`Error ${response.status}: ${sanitizeErrorText(response.status, rawError, t)}`);
    }

    const payload = await response.json() as ChatSessionSnapshot;
    applyMainContentInvalidationVersion(payload.mainContentInvalidationVersion, "snapshot");

    const isUserStoppedSession = stoppedSessionIdsRef.current.has(payload.sessionId);
    const effectiveRunState = getEffectiveSnapshotRunState(
      payload.runState,
      isUserStoppedSession,
    );

    setCurrentSessionId(payload.sessionId);
    setRunState(effectiveRunState);

    const shouldReplaceHistory = replaceHistory && shouldReplaceHistoryFromSnapshot(
      lastSnapshotUpdatedAtRef.current,
      payload.updatedAt,
    );
    lastSnapshotUpdatedAtRef.current = payload.updatedAt;

    if (shouldReplaceHistory) {
      replaceMessages(payload.messages);
    }

    return {
      ...payload,
      runState: effectiveRunState,
    };
  }, [applyMainContentInvalidationVersion, replaceMessages, t]);

  useEffect(() => {
    const abortController = new AbortController();

    setIsHistoryLoaded(false);
    setCurrentSessionId(null);
    setRunState("idle");
    setIsLiveStreamConnected(false);
    setIsStopping(false);
    stoppedSessionIdsRef.current.clear();
    lastSnapshotUpdatedAtRef.current = null;
    lastMainContentInvalidationVersionRef.current = null;
    replaceMessages([]);

    void (async (): Promise<void> => {
      try {
        await loadChatSnapshot(undefined, abortController.signal, true);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

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
          setIsHistoryLoaded(true);
        }
      }
    })();

    return () => abortController.abort();
  }, [loadChatSnapshot, replaceMessages, t, workspaceId]);

  useEffect(() => {
    if (!isHistoryLoaded || currentSessionId === null || runState !== "running") {
      return;
    }

    const intervalId = setInterval(() => {
      void loadChatSnapshot(currentSessionId, undefined, true).catch((error) => {
        if (isLiveStreamConnected) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        setRunState("interrupted");
        setIsLiveStreamConnected(false);
      });
    }, ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [
    currentSessionId,
    isHistoryLoaded,
    isLiveStreamConnected,
    loadChatSnapshot,
    markAssistantError,
    runState,
    t,
  ]);

  const sendMessage = useCallback(async (
    sendParams: SendChatMessageParams,
  ): Promise<void> => {
    if (isAssistantRunActive || isLiveStreamConnected || isStopping) {
      return;
    }

    if (!isHistoryLoaded) {
      return;
    }

    const contentParts = buildContentParts(sendParams.text, sendParams.attachments);
    if (contentParts.length === 0) {
      return;
    }

    appendUserMessage(contentParts);
    stoppedSessionIdsRef.current.clear();
    setRunState("running");
    setIsLiveStreamConnected(false);

    startAssistantMessage();

    const abortController = new AbortController();
    abortRef.current = abortController;

    const requestBody = JSON.stringify({
      sessionId: currentSessionId,
      model: CHAT_MODEL_ID,
      content: contentParts,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    if (requestBody.length > MAX_BODY_BYTES) {
      const sizeMb = (requestBody.length / (1024 * 1024)).toFixed(1);
      const limitMb = (MAX_BODY_BYTES / (1024 * 1024)).toFixed(0);
      markAssistantError(t("chat.errorTooLarge", { sizeMb, limitMb }));
      setIsLiveStreamConnected(false);
      setRunState("idle");
      abortRef.current = null;
      return;
    }

    let responseSessionId: string | null = null;
    let streamFailure: Error | null = null;

    try {
      const response = await fetchWithCsrf("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: abortController.signal,
      });

      if (!response.ok) {
        const rawError = await response.text();
        markAssistantError(`Error ${response.status}: ${sanitizeErrorText(response.status, rawError, t)}`);
        setIsLiveStreamConnected(false);
        setRunState("idle");
        return;
      }

      const reader = response.body?.getReader();
      if (reader === undefined) {
        markAssistantError(t("chat.errorNoResponse"));
        setIsLiveStreamConnected(false);
        setRunState("idle");
        return;
      }

      responseSessionId = response.headers.get("X-Chat-Session-Id");
      if (responseSessionId !== null && responseSessionId.length > 0) {
        setCurrentSessionId(responseSessionId);
      }
      setIsLiveStreamConnected(true);

      const decoder = new TextDecoder();
      let buffer = "";
      let receivedContent = false;
      let reachedTerminalState = false;
      const STREAM_TIMEOUT_MS = 6 * 60 * 1000;

      while (true) {
        const timeout = new Promise<never>((_, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error("No response from AI model — please try again"));
            abortController.abort();
          }, STREAM_TIMEOUT_MS);

          abortController.signal.addEventListener("abort", () => clearTimeout(timeoutId));
        });

        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) {
          break;
        }

        const drainedChunk = drainChatStreamChunk({
          buffer,
          chunk: decoder.decode(value, { stream: true }),
        });
        buffer = drainedChunk.buffer;

        for (const event of drainedChunk.events) {
          const transportResult = applyChatStreamEvent(event, {
            appendAssistantChunk,
            upsertReasoningSummary,
            upsertToolCall,
            markAssistantError,
            applyMainContentInvalidationVersion: (nextVersion) => {
              applyMainContentInvalidationVersion(nextVersion, "live");
            },
          });

          if (transportResult.receivedContent) {
            receivedContent = true;
          }

          if (transportResult.reachedTerminalState) {
            reachedTerminalState = true;
            break;
          }
        }

        if (reachedTerminalState) {
          break;
        }
      }

      if (receivedContent) {
        finalizeAssistant();
      } else {
        streamFailure = new Error(t("chat.errorEmptyResponse"));
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        streamFailure = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      setIsLiveStreamConnected(false);
      abortRef.current = null;

      const sessionIdToReload = responseSessionId ?? currentSessionId ?? undefined;
      if (!abortController.signal.aborted && sessionIdToReload !== undefined) {
        try {
          const snapshot = await loadChatSnapshot(sessionIdToReload, undefined, true);
          if (shouldSuppressStreamFailure(snapshot)) {
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (streamFailure === null) {
            markAssistantError(t("chat.errorFailed", { message }));
            setRunState("interrupted");
          }
        }
      }

      if (streamFailure !== null && !abortController.signal.aborted) {
        markAssistantError(t("chat.errorFailed", { message: streamFailure.message }));
        setRunState("interrupted");
      }
    }
  }, [
    appendAssistantChunk,
    appendUserMessage,
    applyMainContentInvalidationVersion,
    currentSessionId,
    finalizeAssistant,
    isAssistantRunActive,
    isHistoryLoaded,
    isLiveStreamConnected,
    isStopping,
    loadChatSnapshot,
    markAssistantError,
    startAssistantMessage,
    t,
    upsertReasoningSummary,
    upsertToolCall,
  ]);

  const stopMessage = useCallback(async (): Promise<void> => {
    if (currentSessionId === null || !isAssistantRunActive || isStopping) {
      return;
    }

    stoppedSessionIdsRef.current.add(currentSessionId);
    setIsStopping(true);

    try {
      await fetchWithCsrf("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId }),
      });
    } catch {
      // The stop request is best-effort, but we still abort the local stream below.
    } finally {
      if (abortRef.current !== null) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      setIsLiveStreamConnected(false);

      try {
        await loadChatSnapshot(currentSessionId, undefined, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        setRunState("interrupted");
      } finally {
        setIsStopping(false);
      }
    }
  }, [currentSessionId, isAssistantRunActive, isStopping, loadChatSnapshot, markAssistantError, t]);

  const clearConversation = useCallback(async (): Promise<void> => {
    if (currentSessionId !== null && isAssistantRunActive) {
      try {
        await fetchWithCsrf("/api/chat/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: currentSessionId }),
        });
      } catch {
        // Continue clearing the UI even if stop fails.
      }
    }

    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    setIsLiveStreamConnected(false);
    setIsStopping(false);
    if (currentSessionId !== null) {
      stoppedSessionIdsRef.current.delete(currentSessionId);
    }

    try {
      const clearUrl = currentSessionId === null
        ? "/api/chat"
        : `/api/chat?sessionId=${encodeURIComponent(currentSessionId)}`;
      const response = await fetchWithCsrf(clearUrl, {
        method: "DELETE",
      });

      if (!response.ok) {
        const rawError = await response.text();
        markAssistantError(`Error ${response.status}: ${sanitizeErrorText(response.status, rawError, t)}`);
        return;
      }

      const payload = await response.json() as Readonly<{ ok: boolean; sessionId: string }>;
      setCurrentSessionId(payload.sessionId);
      setRunState("idle");
      clearHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markAssistantError(t("chat.errorFailed", { message }));
    }
  }, [clearHistory, currentSessionId, isAssistantRunActive, markAssistantError, t]);

  return {
    messages,
    runState,
    isHistoryLoaded,
    isAssistantRunActive,
    isLiveStreamConnected,
    isStopping,
    currentSessionId,
    composerAction,
    sendMessage,
    stopMessage,
    clearConversation,
  };
};
