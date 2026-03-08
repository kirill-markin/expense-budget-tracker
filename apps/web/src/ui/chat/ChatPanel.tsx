"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { fetchWithCsrf } from "@/lib/csrf";
import { cn } from "@/lib/cn";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { DEFAULT_MODEL_ID } from "@/lib/chatModels";
import { useChatHistory, type StoredMessage } from "@/ui/hooks/useChatHistory";
import { useChatLayout } from "./ChatLayoutProvider";
import { ModelSelector } from "./ModelSelector";
import { FileAttachment, prepareAttachment, checkFileSize, type PendingAttachment } from "./FileAttachment";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  mode: "sidebar" | "fullscreen";
}>;

const STORAGE_MODEL_KEY = "expense-tracker-chat-model";

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
  if (name === "code_execution" || name === "code_interpreter") return t("chat.toolCodeExec");
  if (name === "web_search") return t("chat.toolWebSearch");
  return name;
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
  return input;
};

const MAX_OUTPUT_DISPLAY_LENGTH = 10_000;

const formatToolOutput = (name: string, output: string | null): string | null => {
  if (output === null) return null;
  if (name === "query_database") {
    try {
      const parsed = JSON.parse(output) as unknown;
      const pretty = JSON.stringify(parsed, null, 2);
      if (pretty.length > MAX_OUTPUT_DISPLAY_LENGTH) {
        return pretty.slice(0, MAX_OUTPUT_DISPLAY_LENGTH) + "\n[truncated]";
      }
      return pretty;
    } catch {
      // fall through
    }
  }
  if (output.length > MAX_OUTPUT_DISPLAY_LENGTH) {
    return output.slice(0, MAX_OUTPUT_DISPLAY_LENGTH) + "\n[truncated]";
  }
  return output;
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
      const displayInput = formatToolInput(part.name, part.input);
      const displayOutput = formatToolOutput(part.name, part.output ?? null);
      elements.push(
        <details
          key={`tc-${i}`}
          className={cn(styles.toolCall, part.status === "started" ? styles.toolCallStarted : "")}
        >
          <summary className={styles.toolCallSummary}>{label}</summary>
          {displayInput !== null && (
            <pre className={styles.toolCallInput}>{displayInput}</pre>
          )}
          {displayOutput !== null && (
            <pre className={styles.toolCallOutput}>{displayOutput}</pre>
          )}
        </details>,
      );
    }
  }

  if (!fileHeaderAdded && filePrefix.length > 0) {
    elements.unshift(<span key="fp">{filePrefix}</span>);
  }

  return <>{elements}</>;
};

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

export const ChatPanel = (props: Props): ReactElement => {
  const { mode } = props;
  const { t } = useTranslation();
  const { setIsOpen, chatWidth, setChatWidth } = useChatLayout();
  const [localWidth, setLocalWidth] = useState<number>(chatWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const {
    messages,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    appendToolCall,
    completeToolCall,
    finalizeAssistant,
    markAssistantError,
    clearHistory,
  } = useChatHistory();

  const [inputText, setInputText] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_ID);
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollRef = useRef<boolean>(false);
  const initialScrollDoneRef = useRef<boolean>(false);

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

  // Restore model from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_MODEL_KEY);
    if (saved !== null) {
      setSelectedModel(saved);
    }
  }, []);

  const handleModelChange = (modelId: string): void => {
    setSelectedModel(modelId);
    localStorage.setItem(STORAGE_MODEL_KEY, modelId);
  };

  // Track whether user is near the bottom of the scroll area
  useEffect(() => {
    const el = messagesRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      const threshold = 40;
      isNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Throttled auto-scroll: batches scroll updates during streaming
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    if (isStreaming) {
      // During streaming, throttle to once per 300ms
      if (pendingScrollRef.current) return;
      pendingScrollRef.current = true;
      scrollTimerRef.current = setTimeout(() => {
        pendingScrollRef.current = false;
        const el = messagesRef.current;
        if (el !== null && isNearBottomRef.current) {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }
      }, 300);
    } else {
      const el = messagesRef.current;
      if (el !== null) {
        // First scroll with actual messages (after localStorage load) — jump instantly;
        // subsequent scrolls (new user message, streaming done) — animate smoothly
        const behavior: ScrollBehavior = initialScrollDoneRef.current ? "smooth" : "instant";
        el.scrollTo({ top: el.scrollHeight, behavior });
        if (!initialScrollDoneRef.current && messages.length > 0) {
          initialScrollDoneRef.current = true;
        }
      }
    }
  }, [messages, isStreaming]);

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
    if (isStreaming) return;
    if (inputText.trim().length === 0 && pendingAttachments.length === 0) return;

    const contentParts = buildContentParts(inputText, pendingAttachments);
    if (contentParts.length === 0) return;

    appendUserMessage(contentParts);
    setInputText("");
    setPendingAttachments([]);
    setIsStreaming(true);

    startAssistantMessage();

    const abortController = new AbortController();
    abortRef.current = abortController;

    // Build messages for the API from full history + new message
    const allMessages = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: contentParts },
    ];

    const requestBody = JSON.stringify({
      model: selectedModel,
      messages: allMessages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    if (requestBody.length > MAX_BODY_BYTES) {
      const sizeMb = (requestBody.length / (1024 * 1024)).toFixed(1);
      const limitMb = (MAX_BODY_BYTES / (1024 * 1024)).toFixed(0);
      markAssistantError(t("chat.errorTooLarge", { sizeMb, limitMb }));
      setIsStreaming(false);
      abortRef.current = null;
      return;
    }

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
        return;
      }

      const reader = response.body?.getReader();
      if (reader === undefined) {
        markAssistantError(t("chat.errorNoResponse"));
        setIsStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let receivedContent = false;
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
            appendAssistantChunk(event.text);
          } else if (event.type === "tool_call") {
            receivedContent = true;
            if (event.status === "started") {
              appendToolCall(event.name);
            } else {
              completeToolCall(event.name, event.input ?? null, event.output ?? null);
            }
          } else if (event.type === "error") {
            markAssistantError(event.message);
            setIsStreaming(false);
            return;
          } else if (event.type === "done") {
            break;
          }
        }
      }

      if (receivedContent) {
        finalizeAssistant();
      } else {
        markAssistantError(t("chat.errorEmptyResponse"));
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        finalizeAssistant();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        markAssistantError(t("chat.errorFailed", { message }));
      }
    }

    setIsStreaming(false);
    abortRef.current = null;
  }, [
    isStreaming,
    inputText,
    pendingAttachments,
    selectedModel,
    messages,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    appendToolCall,
    completeToolCall,
    finalizeAssistant,
    markAssistantError,
    t,
  ]);

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
            onClick={() => {
              if (abortRef.current !== null) {
                abortRef.current.abort();
                abortRef.current = null;
              }
              setIsStreaming(false);
              clearHistory();
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
              {isLastAssistant && (() => {
                const lastPart = msg.content.length > 0 ? msg.content[msg.content.length - 1] : undefined;
                const isToolRunning = lastPart !== undefined && lastPart.type === "tool_call" && lastPart.status === "started";
                if (isToolRunning) return null;
                return (
                  <span className={styles.streamingIndicator}>
                    <span className={styles.dots} />
                  </span>
                );
              })()}
            </div>
          );
        })}
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
          <ModelSelector value={selectedModel} onChange={handleModelChange} locked={messages.length > 0 || isStreaming} />
          <div className={styles.controlsRight}>
            <FileAttachment onAttach={handleAttach} />
            <button
              type="button"
              className={styles.sendButton}
              disabled={isStreaming}
              onClick={() => void sendMessage()}
            >
              {t("chat.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
