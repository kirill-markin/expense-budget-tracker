"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "next/navigation";

import { fetchWithCsrf } from "@/lib/csrf";
import { CHAT_MODEL_BADGE_LABEL, CHAT_MODEL_ID } from "@/lib/chatModels";
import { cn } from "@/lib/cn";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { useChatHistory, type StoredMessage } from "@/ui/hooks/useChatHistory";
import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
  shouldReplaceHistoryFromSnapshot,
  shouldSuppressStreamFailure,
} from "./streamRecovery";
import { getAssistantStreamingIndicator } from "./thinkingSummary";
import { useChatLayout } from "./ChatLayoutProvider";
import { FileAttachment, prepareAttachment, checkFileSize, type PendingAttachment } from "./FileAttachment";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  mode: "sidebar" | "fullscreen";
  workspaceId: string;
}>;

type ChatHistoryResponse = Readonly<{
  sessionId: string;
  runState: "idle" | "running" | "interrupted";
  updatedAt: number;
  messages: ReadonlyArray<StoredMessage>;
}>;

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const buildContentParts = (
  text: string,
  attachments: ReadonlyArray<PendingAttachment>,
): ReadonlyArray<ContentPart> => {
  const parts: Array<ContentPart> = [];

  for (const att of attachments) {
    if (IMAGE_MEDIA_TYPES.has(att.mediaType)) {
      parts.push({ type: "image", mediaType: att.mediaType, base64Data: att.base64Data });
    } else {
      parts.push({
        type: "file",
        mediaType: att.mediaType,
        base64Data: att.base64Data,
        fileName: att.fileName,
      });
    }
  }

  if (text.trim().length > 0) {
    parts.push({ type: "text", text: text.trim() });
  }

  return parts;
};

// 90 MB — safely under Cloudflare (100 MB) and Next.js proxyClientMaxBodySize (100 MB)
const MAX_BODY_BYTES = 90 * 1024 * 1024;

const sanitizeErrorText = (status: number, raw: string, t: (key: string) => string): string => {
  if (raw.trim().length === 0 && status === 500) {
    return t("chat.errorTooLarge").replace("{{sizeMb}}", "?").replace("{{limitMb}}", "?");
  }
  if (raw.includes("<html") || raw.includes("<!DOCTYPE")) {
    const titleMatch = raw.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch !== null) return titleMatch[1];
    return t("chat.errorBlocked");
  }
  return raw;
};

const parseSSELine = (line: string): ChatStreamEvent | null => {
  if (!line.startsWith("data: ")) return null;
  try {
    return JSON.parse(line.slice(6)) as ChatStreamEvent;
  } catch {
    return null;
  }
};

const formatToolLabel = (name: string, t: (key: string) => string): string => {
  if (name === "query_database") return t("chat.toolDbQuery");
  if (name === "code_execution") return t("chat.toolCodeExec");
  if (name === "code_interpreter_call" || name === "code_interpreter") return t("chat.toolCodeInterpreter");
  if (name === "web_search_call" || name === "web_search") return t("chat.toolWebSearch");
  return name;
};

const formatToolStatusLabel = (
  status: "started" | "completed",
  providerStatus: string | null | undefined,
  t: (key: string) => string,
): string => {
  const normalizedStatus = providerStatus ?? (status === "completed" ? "completed" : "running");
  if (normalizedStatus === "running") return t("chat.toolStatusRunning");
  if (normalizedStatus === "in_progress") return t("chat.toolStatusInProgress");
  if (normalizedStatus === "interpreting") return t("chat.toolStatusInterpreting");
  if (normalizedStatus === "searching") return t("chat.toolStatusSearching");
  if (normalizedStatus === "completed") return t("chat.toolStatusCompleted");
  if (normalizedStatus === "failed") return t("chat.toolStatusFailed");
  if (normalizedStatus === "incomplete") return t("chat.toolStatusIncomplete");
  return normalizedStatus.replaceAll("_", " ");
};

const formatStructuredToolText = (
  value: string | null,
): string | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "string"
      || typeof parsed === "number"
      || typeof parsed === "boolean"
      || parsed === null
    ) {
      return String(parsed);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
};

const formatToolInput = (name: string, input: string | null): string | null => {
  if (input === null) return null;
  if (name === "query_database") {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      if (typeof parsed.sql === "string") return parsed.sql;
    } catch {
      // fall through
    }
  }
  return formatStructuredToolText(input);
};

const MAX_OUTPUT_DISPLAY_LENGTH = 10_000;

const formatToolOutput = (name: string, output: string | null): string | null => {
  if (output === null) return null;
  let formattedOutput: string | null = output;
  if (name === "query_database") {
    try {
      const parsed = JSON.parse(output) as unknown;
      formattedOutput = JSON.stringify(parsed, null, 2);
    } catch {
      // fall through
    }
  } else {
    formattedOutput = formatStructuredToolText(output);
  }
  if (formattedOutput === null) {
    return null;
  }
  if (formattedOutput.length > MAX_OUTPUT_DISPLAY_LENGTH) {
    return formattedOutput.slice(0, MAX_OUTPUT_DISPLAY_LENGTH) + "\n[truncated]";
  }
  return formattedOutput;
};

const renderMessageContent = (msg: StoredMessage, t: (key: string) => string): ReactElement => {
  const fileParts = msg.content.filter((p) => p.type === "file" || p.type === "image");
  const filePrefix = fileParts.length > 0
    ? `[${fileParts.map((p) => (p.type === "file" ? p.fileName : "[image]")).join(", ")}]\n`
    : "";

  const elements: Array<ReactElement> = [];
  let fileHeaderAdded = false;

  for (let i = 0; i < msg.content.length; i++) {
    const part = msg.content[i];
    if (part.type === "text") {
      const text = !fileHeaderAdded && filePrefix.length > 0
        ? filePrefix + part.text
        : part.text;
      fileHeaderAdded = true;
      elements.push(<span key={`t-${i}`}>{text}</span>);
    } else if (part.type === "tool_call") {
      const label = formatToolLabel(part.name, t);
      const statusLabel = formatToolStatusLabel(part.status, part.providerStatus, t);
      const displayInput = formatToolInput(part.name, part.input);
      const displayOutput = formatToolOutput(part.name, part.output ?? null);
      elements.push(
        <details
          key={`tc-${i}`}
          className={cn(styles.toolCall, part.status === "started" ? styles.toolCallStarted : "")}
        >
          <summary className={styles.toolCallSummary}>{`${label} (${statusLabel})`}</summary>
          {displayInput !== null && (
            <pre className={styles.toolCallInput}>{displayInput}</pre>
          )}
          {displayOutput !== null && (
            <pre className={styles.toolCallOutput}>{displayOutput}</pre>
          )}
        </details>,
      );
    } else if (part.type === "reasoning_summary") {
      elements.push(
        <details
          key={`rs-${i}`}
          className={cn(styles.toolCall, styles.reasoningSummary)}
        >
          <summary className={styles.toolCallSummary}>{t("chat.thinkingSummary")}</summary>
          <pre className={cn(styles.toolCallOutput, styles.reasoningSummaryContent)}>{part.summary}</pre>
        </details>,
      );
    }
  }

  if (!fileHeaderAdded && filePrefix.length > 0) {
    elements.unshift(<span key="fp">{filePrefix}</span>);
  }

  const shouldShowStoppedNotice = msg.isStopped;

  return (
    <>
      {elements}
      {shouldShowStoppedNotice && (
        <span className={styles.stoppedNotice}>
          {t("chat.stopped")}
        </span>
      )}
    </>
  );
};

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

export const ChatPanel = (props: Props): ReactElement => {
  const { mode, workspaceId } = props;
  const { t } = useTranslation();
  const router = useRouter();
  const { setIsOpen, chatWidth, setChatWidth } = useChatLayout();
  const [localWidth, setLocalWidth] = useState<number>(chatWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
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

  const [inputText, setInputText] = useState<string>("");
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [isHistoryLoaded, setIsHistoryLoaded] = useState<boolean>(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "interrupted">("idle");
  const [isStopping, setIsStopping] = useState<boolean>(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isLiveStreamConnectedRef = useRef<boolean>(false);
  const lastSnapshotUpdatedAtRef = useRef<number | null>(null);
  const shouldAutoScrollRef = useRef<boolean>(true);
  const scrollFrameRef = useRef<number | null>(null);
  const initialScrollDoneRef = useRef<boolean>(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior): void => {
    const el = messagesRef.current;
    if (el === null) {
      return;
    }

    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior): void => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollToBottom(behavior);
    });
  }, [scrollToBottom]);

  const loadChatSnapshot = useCallback(async (
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    replaceHistory: boolean,
  ): Promise<ChatHistoryResponse> => {
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

    const payload = await response.json() as ChatHistoryResponse;
    setCurrentSessionId(payload.sessionId);
    setRunState(payload.runState);

    if (payload.runState === "running") {
      if (!isLiveStreamConnectedRef.current) {
        setIsStreaming(true);
      }
    } else {
      setIsStreaming(false);
    }

    const shouldReplaceHistory = replaceHistory && shouldReplaceHistoryFromSnapshot(
      lastSnapshotUpdatedAtRef.current,
      payload.updatedAt,
    );
    lastSnapshotUpdatedAtRef.current = payload.updatedAt;

    if (shouldReplaceHistory) {
      replaceMessages(payload.messages);
    }
    return payload;
  }, [replaceMessages, t]);

  useEffect(() => {
    const abortController = new AbortController();
    setIsHistoryLoaded(false);
    setCurrentSessionId(null);
    setRunState("idle");
    setIsStreaming(false);
    isLiveStreamConnectedRef.current = false;
    lastSnapshotUpdatedAtRef.current = null;
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
  }, [replaceMessages, t, workspaceId]);

  useEffect(() => {
    if (!isHistoryLoaded || currentSessionId === null || runState !== "running") {
      return;
    }

    const intervalId = setInterval(() => {
      void loadChatSnapshot(
        currentSessionId,
        undefined,
        true,
      ).catch((error) => {
        if (isLiveStreamConnectedRef.current) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        markAssistantError(t("chat.errorFailed", { message }));
        setRunState("interrupted");
        setIsStreaming(false);
      });
    }, ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [currentSessionId, isHistoryLoaded, loadChatSnapshot, markAssistantError, runState, t]);

  // Resize drag logic
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

  // Track whether user is near the bottom of the scroll area
  useEffect(() => {
    const el = messagesRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      const threshold = 80;
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldAutoScrollRef.current = distanceToBottom <= threshold;
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;

    const behavior: ScrollBehavior = isStreaming || !initialScrollDoneRef.current
      ? "instant"
      : "smooth";
    scheduleScrollToBottom(behavior);

    if (!initialScrollDoneRef.current && messages.length > 0) {
      initialScrollDoneRef.current = true;
    }
  }, [isStreaming, messages, scheduleScrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const handleAttach = useCallback((attachment: PendingAttachment): void => {
    setPendingAttachments((prev) => [...prev, attachment]);
  }, []);

  const removeAttachment = useCallback((index: number): void => {
    setPendingAttachments((prev) => [...prev.slice(0, index), ...prev.slice(index + 1)]);
  }, []);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sizeError = checkFileSize(file);
      if (sizeError !== null) {
        alert(sizeError);
        continue;
      }
      const attachment = await prepareAttachment(file);
      handleAttach(attachment);
    }
  }, [handleAttach]);

  const sendMessage = useCallback(async (): Promise<void> => {
    if (isStreaming || isStopping) return;
    if (!isHistoryLoaded) return;
    if (inputText.trim().length === 0 && pendingAttachments.length === 0) return;

    const contentParts = buildContentParts(inputText, pendingAttachments);
    if (contentParts.length === 0) return;

    appendUserMessage(contentParts);
    setInputText("");
    setPendingAttachments([]);
    setIsStreaming(true);
    setRunState("running");

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
      setIsStreaming(false);
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
        setIsStreaming(false);
        setRunState("idle");
        return;
      }

      const reader = response.body?.getReader();
      if (reader === undefined) {
        markAssistantError(t("chat.errorNoResponse"));
        setIsStreaming(false);
        setRunState("idle");
        return;
      }

      responseSessionId = response.headers.get("X-Chat-Session-Id");
      if (responseSessionId !== null && responseSessionId.length > 0) {
        setCurrentSessionId(responseSessionId);
      }
      isLiveStreamConnectedRef.current = true;

      const decoder = new TextDecoder();
      let buffer = "";
      let receivedContent = false;
      let reachedTerminalState = false;
      const STREAM_TIMEOUT_MS = 6 * 60 * 1000;

      while (true) {
        const timeout = new Promise<never>((_, reject) => {
          const id = setTimeout(() => {
            reject(new Error("No response from AI model — please try again"));
            abortController.abort();
          }, STREAM_TIMEOUT_MS);
          abortController.signal.addEventListener("abort", () => clearTimeout(id));
        });
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const event = parseSSELine(trimmed);
          if (event === null) continue;

          if (event.type === "delta") {
            receivedContent = true;
            appendAssistantChunk(event.text, {
              itemId: event.itemId,
              outputIndex: event.outputIndex,
              contentIndex: event.contentIndex,
              sequenceNumber: event.sequenceNumber,
            });
          } else if (event.type === "reasoning_summary") {
            receivedContent = true;
            upsertReasoningSummary({
              type: "reasoning_summary",
              summary: event.summary,
              streamPosition: {
                itemId: event.itemId,
                outputIndex: event.outputIndex,
                contentIndex: null,
                sequenceNumber: event.sequenceNumber,
              },
            });
          } else if (event.type === "tool_call") {
            receivedContent = true;
            upsertToolCall({
              type: "tool_call",
              id: event.id,
              name: event.name,
              status: event.status,
              providerStatus: event.providerStatus ?? null,
              input: event.input ?? null,
              output: event.output ?? null,
              streamPosition: {
                itemId: event.itemId,
                outputIndex: event.outputIndex,
                contentIndex: null,
                sequenceNumber: event.sequenceNumber,
              },
            });
            if (event.status === "completed" && mode === "sidebar" && event.refreshRoute === true) {
              startTransition(() => {
                router.refresh();
              });
            }
          } else if (event.type === "error") {
            markAssistantError(event.message);
            reachedTerminalState = true;
            break;
          } else if (event.type === "done") {
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
    } catch (err) {
      if (!abortController.signal.aborted) {
        streamFailure = err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      isLiveStreamConnectedRef.current = false;
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

      setIsStreaming(false);
      if (streamFailure !== null && !abortController.signal.aborted) {
        markAssistantError(t("chat.errorFailed", { message: streamFailure.message }));
        setRunState("interrupted");
      }
    }
  }, [
    isStreaming,
    isStopping,
    inputText,
    pendingAttachments,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    upsertReasoningSummary,
    upsertToolCall,
    finalizeAssistant,
    markAssistantError,
    mode,
    router,
    t,
    currentSessionId,
    isHistoryLoaded,
    loadChatSnapshot,
  ]);

  const stopMessage = useCallback(async (): Promise<void> => {
    if (currentSessionId === null || !isStreaming || isStopping) {
      return;
    }

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
      isLiveStreamConnectedRef.current = false;
      setIsStreaming(false);

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
  }, [currentSessionId, isStopping, isStreaming, loadChatSnapshot, markAssistantError, t]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  // Auto-resize textarea
  const handleInput = (value: string): void => {
    setInputText(value);
  };

  const rootClass = mode === "sidebar" ? styles.sidebar : styles.sidebarFullscreen;
  const sidebarStyle = mode === "sidebar" ? { width: localWidth } : undefined;

  return (
    <div
      className={rootClass}
      style={sidebarStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {isDragOver && <div className={styles.dropOverlay}>{t("chat.dropFiles")}</div>}
      {mode === "sidebar" && (
        <div
          className={cn(styles.resizeHandle, isDragging ? styles.resizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
      )}
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t("chat.title")}</span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.closeButton}
            onClick={async () => {
              if (abortRef.current !== null) {
                if (currentSessionId !== null) {
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
                abortRef.current.abort();
                abortRef.current = null;
              }
              isLiveStreamConnectedRef.current = false;
              setIsStreaming(false);
              setIsStopping(false);
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
                const payload = await response.json() as { ok: boolean; sessionId: string };
                setCurrentSessionId(payload.sessionId);
                setRunState("idle");
                clearHistory();
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                markAssistantError(t("chat.errorFailed", { message }));
              }
            }}
          >
            {t("chat.clear")}
          </button>
          {mode === "sidebar" && (
            <button
              type="button"
              className={styles.closeButton}
              onClick={() => setIsOpen(false)}
            >
              &laquo;
            </button>
          )}
        </div>
      </div>

      <div className={styles.messages} ref={messagesRef}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{t("chat.emptyTitle")}</p>
            <ul className={styles.emptyList}>
              <li>{t("chat.example1")}</li>
              <li>{t("chat.example2")}</li>
              <li>{t("chat.example3")}</li>
            </ul>
            <p className={styles.emptyTitle}>{t("chat.attachTitle")}</p>
            <ul className={styles.emptyList}>
              <li>{t("chat.attachPdf")}</li>
              <li>{t("chat.attachCsv")}</li>
              <li>{t("chat.attachScreenshots")}</li>
            </ul>
          </div>
        )}
        {messages.map((msg, i) => {
          const isLastAssistant =
            isStreaming && msg.role === "assistant" && i === messages.length - 1;
          const streamingIndicator = getAssistantStreamingIndicator(msg, isStreaming, isLastAssistant);
          return (
            <div
              key={`${msg.timestamp}-${i}`}
              className={cn(
                styles.message,
                msg.role === "user" ? styles.messageUser : styles.messageAssistant,
                msg.isError ? styles.messageError : "",
              )}
            >
              {renderMessageContent(msg, t)}
              {streamingIndicator === "thinking" && (
                <span className={styles.thinkingIndicator}>
                  <span>{t("chat.thinking")}</span>
                  <span aria-hidden="true" className={styles.dots} />
                </span>
              )}
              {streamingIndicator === "streaming" && (
                <span className={styles.streamingIndicator}>
                  <span aria-hidden="true" className={styles.dots} />
                </span>
              )}
            </div>
          );
        })}
        <div
          aria-hidden="true"
          className={cn(styles.bottomAnchor, isStreaming ? styles.bottomAnchorActive : "")}
        />
      </div>

      <div className={styles.inputArea}>
        {pendingAttachments.length > 0 && (
          <div className={styles.attachmentPreview}>
            {pendingAttachments.map((att, i) => (
              <span key={`${att.fileName}-${i}`} className={styles.attachmentChip}>
                {att.fileName}
                <button
                  type="button"
                  className={styles.attachmentRemove}
                  onClick={() => removeAttachment(i)}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={t("chat.placeholder")}
          value={inputText}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <div className={styles.controls}>
          <span className={styles.modelLabel}>{CHAT_MODEL_BADGE_LABEL}</span>
          <div className={styles.controlsRight}>
            <FileAttachment onAttach={handleAttach} />
            <button
              type="button"
              className={styles.sendButton}
              disabled={!isHistoryLoaded || isStopping}
              onClick={() => void (isStreaming ? stopMessage() : sendMessage())}
            >
              {isStreaming ? t("chat.stop") : t("chat.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
