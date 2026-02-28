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
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { DEFAULT_MODEL_ID } from "@/lib/chatModels";
import { useChatHistory, type StoredMessage } from "@/ui/hooks/useChatHistory";
import { useChatLayout } from "./ChatLayoutProvider";
import { ModelSelector } from "./ModelSelector";
import { FileAttachment, readFileAsBase64, checkFileSize, type PendingAttachment } from "./FileAttachment";

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

const sanitizeErrorText = (status: number, raw: string): string => {
  if (raw.trim().length === 0 && status === 500) {
    return "Request too large — try sending fewer attachments or smaller images";
  }
  if (raw.includes("<html") || raw.includes("<!DOCTYPE")) {
    const titleMatch = raw.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch !== null) return titleMatch[1];
    return "Request blocked by firewall";
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

const renderMessageContent = (msg: StoredMessage): string => {
  const textParts = msg.content.filter((p) => p.type === "text");
  const fileParts = msg.content.filter((p) => p.type === "file" || p.type === "image");
  let result = textParts.map((p) => (p.type === "text" ? p.text : "")).join("");
  if (fileParts.length > 0) {
    const fileNames = fileParts.map((p) => (p.type === "file" ? p.fileName : "[image]"));
    result = `[${fileNames.join(", ")}]\n${result}`;
  }
  return result;
};

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

export const ChatPanel = (props: Props): ReactElement => {
  const { mode } = props;
  const { setIsOpen, chatWidth, setChatWidth } = useChatLayout();
  const [localWidth, setLocalWidth] = useState<number>(chatWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const {
    messages,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    finalizeAssistant,
    markAssistantError,
    clearHistory,
  } = useChatHistory();

  const [inputText, setInputText] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_ID);
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollRef = useRef<boolean>(false);

  // Resize drag logic
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const newWidth = Math.max(MIN_WIDTH, Math.min(e.clientX, MAX_WIDTH));
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
      // Not streaming — scroll immediately (new user message, history load)
      const el = messagesRef.current;
      if (el !== null) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
      const base64Data = await readFileAsBase64(file);
      handleAttach({
        fileName: file.name,
        mediaType: file.type || "application/octet-stream",
        base64Data,
      });
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
      markAssistantError(`Request too large (${sizeMb} MB, limit ${limitMb} MB). Try sending fewer attachments or smaller images.`);
      setIsStreaming(false);
      abortRef.current = null;
      return;
    }

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: abortController.signal,
      });

      if (!response.ok) {
        const rawError = await response.text();
        markAssistantError(`Error ${response.status}: ${sanitizeErrorText(response.status, rawError)}`);
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (reader === undefined) {
        markAssistantError("No response stream available");
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
            if (event.status === "started") {
              const label = event.name === "query_database"
                ? "Querying database..."
                : event.name === "code_execution" || event.name === "code_interpreter"
                  ? "Running code..."
                  : `Running ${event.name}...`;
              setToolStatus(label);
            } else {
              setToolStatus(null);
            }
          } else if (event.type === "error") {
            markAssistantError(event.message);
            setIsStreaming(false);
            setToolStatus(null);
            return;
          } else if (event.type === "done") {
            break;
          }
        }
      }

      if (receivedContent) {
        finalizeAssistant();
      } else {
        markAssistantError("Empty response from AI model — please try again");
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        finalizeAssistant();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        markAssistantError(`Request failed: ${message}`);
      }
    }

    setIsStreaming(false);
    setToolStatus(null);
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
    finalizeAssistant,
    markAssistantError,
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

  const rootClass = mode === "sidebar" ? "chat-sidebar" : "chat-sidebar-fullscreen";
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
      {isDragOver && <div className="chat-drop-overlay">Drop files here</div>}
      {mode === "sidebar" && (
        <div
          className={`chat-resize-handle${isDragging ? " dragging" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
      )}
      <div className="chat-header">
        <span className="chat-header-title">AI Chat</span>
        <div className="chat-header-actions">
          <button
            type="button"
            className="chat-close-btn"
            onClick={() => {
              if (abortRef.current !== null) {
                abortRef.current.abort();
                abortRef.current = null;
              }
              setIsStreaming(false);
              setToolStatus(null);
              clearHistory();
            }}
          >
            Clear
          </button>
          {mode === "sidebar" && (
            <button
              type="button"
              className="chat-close-btn"
              onClick={() => setIsOpen(false)}
            >
              &laquo;
            </button>
          )}
        </div>
      </div>

      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="chat-empty-title">What can AI do?</p>
            <ul className="chat-empty-list">
              <li>Categorize transactions from a bank statement and save them to the database</li>
              <li>Extract missing transactions from app screenshots and add them to the database</li>
              <li>Fill in the budget plan for the remaining months based on past spending</li>
            </ul>
            <p className="chat-empty-title">You can attach:</p>
            <ul className="chat-empty-list">
              <li>PDF bank statement</li>
              <li>CSV export from your bank</li>
              <li>Screenshots from a banking app</li>
            </ul>
          </div>
        )}
        {messages.map((msg, i) => {
          const isLastAssistant =
            isStreaming && msg.role === "assistant" && i === messages.length - 1;
          return (
            <div
              key={`${msg.timestamp}-${i}`}
              className={`chat-msg chat-msg-${msg.role}${msg.isError ? " chat-msg-error" : ""}`}
            >
              {renderMessageContent(msg)}
              {isLastAssistant && (
                <span className="chat-streaming-indicator">
                  {toolStatus !== null ? toolStatus : (
                    <span className="chat-dots" />
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="chat-input-area">
        {pendingAttachments.length > 0 && (
          <div className="chat-attachment-preview">
            {pendingAttachments.map((att, i) => (
              <span key={`${att.fileName}-${i}`} className="chat-attachment-chip">
                {att.fileName}
                <button
                  type="button"
                  className="chat-attachment-remove"
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
          className="chat-textarea"
          placeholder="Type a message..."
          value={inputText}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <div className="chat-controls">
          <ModelSelector value={selectedModel} onChange={handleModelChange} locked={messages.length > 0 || isStreaming} />
          <div className="chat-controls-right">
            <FileAttachment onAttach={handleAttach} />
            <button
              type="button"
              className="chat-send-btn"
              disabled={isStreaming}
              onClick={() => void sendMessage()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
