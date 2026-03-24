"use client";

import { useCallback, useState } from "react";
import {
  applyAssistantError,
  appendAssistantTextContent,
  upsertReasoningSummaryContent,
  upsertToolCallContent,
  type StoredMessage,
} from "@/lib/chatHistory";
import type {
  ContentPart,
  ReasoningSummaryContentPart,
  StreamPosition,
  ToolCallContentPart,
} from "@/server/chat/types";

type ChatHistoryState = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  replaceMessages: (messages: ReadonlyArray<StoredMessage>) => void;
  appendUserMessage: (content: ReadonlyArray<ContentPart>) => void;
  startAssistantMessage: () => void;
  appendAssistantChunk: (text: string, streamPosition: StreamPosition) => void;
  upsertReasoningSummary: (reasoningSummary: ReasoningSummaryContentPart) => void;
  upsertToolCall: (toolCall: ToolCallContentPart) => void;
  finalizeAssistant: () => void;
  markAssistantError: (errorText: string) => void;
  clearHistory: () => void;
}>;
export { applyAssistantError, upsertToolCallContent, type StoredMessage };

export const useChatHistory = (): ChatHistoryState => {
  const [messages, setMessages] = useState<ReadonlyArray<StoredMessage>>([]);

  const replaceMessages = useCallback((nextMessages: ReadonlyArray<StoredMessage>): void => {
    setMessages(nextMessages);
  }, []);

  const appendUserMessage = useCallback((content: ReadonlyArray<ContentPart>): void => {
    const msg: StoredMessage = {
      role: "user",
      content,
      timestamp: Date.now(),
      isError: false,
      isStopped: false,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const startAssistantMessage = useCallback((): void => {
    const msg: StoredMessage = {
      role: "assistant",
      content: [],
      timestamp: Date.now(),
      isError: false,
      isStopped: false,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const appendAssistantChunk = useCallback((text: string, streamPosition: StreamPosition): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const updatedContent = appendAssistantTextContent(last.content, {
        text,
        streamPosition,
      });
      const updated: StoredMessage = { ...last, content: updatedContent };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const upsertReasoningSummary = useCallback((reasoningSummary: ReasoningSummaryContentPart): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const updatedContent = upsertReasoningSummaryContent(last.content, reasoningSummary);
      const updated: StoredMessage = { ...last, content: updatedContent };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const upsertToolCall = useCallback((toolCall: ToolCallContentPart): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const updatedContent = upsertToolCallContent(last.content, toolCall);
      const updated: StoredMessage = { ...last, content: updatedContent };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const finalizeAssistant = useCallback((): void => {
    // Trigger a save by touching state (the useEffect will persist)
    setMessages((prev) => [...prev]);
  }, []);

  const markAssistantError = useCallback((errorText: string): void => {
    setMessages((prev) => {
      return applyAssistantError(prev, errorText, Date.now());
    });
  }, []);

  const clearHistory = useCallback((): void => {
    setMessages([]);
  }, []);

  return {
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
  };
};
