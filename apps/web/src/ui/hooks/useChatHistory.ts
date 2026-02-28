"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentPart } from "@/server/chat/types";

export type StoredMessage = Readonly<{
  role: "user" | "assistant";
  content: ReadonlyArray<ContentPart>;
  timestamp: number;
  isError: boolean;
}>;

type ChatHistoryState = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  appendUserMessage: (content: ReadonlyArray<ContentPart>) => void;
  startAssistantMessage: () => void;
  appendAssistantChunk: (text: string) => void;
  appendToolCall: (name: string) => void;
  completeToolCall: (name: string, input: string | null) => void;
  finalizeAssistant: () => void;
  markAssistantError: (errorText: string) => void;
  clearHistory: () => void;
}>;

const STORAGE_KEY = "expense-tracker-chat-messages";
const MAX_MESSAGES = 200;

const loadFromStorage = (): ReadonlyArray<StoredMessage> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as ReadonlyArray<StoredMessage>;
    return parsed.slice(-MAX_MESSAGES);
  } catch {
    return [];
  }
};

const saveToStorage = (messages: ReadonlyArray<StoredMessage>): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
  } catch {
    // localStorage full — silently drop
  }
};

export const useChatHistory = (): ChatHistoryState => {
  const [messages, setMessages] = useState<ReadonlyArray<StoredMessage>>([]);
  const loadedRef = useRef<boolean>(false);

  useEffect(() => {
    setMessages(loadFromStorage());
    loadedRef.current = true;
  }, []);

  // Persist on every change after initial load
  useEffect(() => {
    if (!loadedRef.current) return;
    saveToStorage(messages);
  }, [messages]);

  const appendUserMessage = useCallback((content: ReadonlyArray<ContentPart>): void => {
    const msg: StoredMessage = { role: "user", content, timestamp: Date.now(), isError: false };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const startAssistantMessage = useCallback((): void => {
    const msg: StoredMessage = {
      role: "assistant",
      content: [],
      timestamp: Date.now(),
      isError: false,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const appendAssistantChunk = useCallback((text: string): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const lastPart = last.content.length > 0 ? last.content[last.content.length - 1] : undefined;
      let updatedContent: ReadonlyArray<ContentPart>;
      if (lastPart !== undefined && lastPart.type === "text") {
        updatedContent = [...last.content.slice(0, -1), { ...lastPart, text: lastPart.text + text }];
      } else {
        updatedContent = [...last.content, { type: "text" as const, text }];
      }
      const updated: StoredMessage = { ...last, content: updatedContent };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const appendToolCall = useCallback((name: string): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const part: ContentPart = { type: "tool_call", name, status: "started", input: null };
      const updated: StoredMessage = { ...last, content: [...last.content, part] };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const completeToolCall = useCallback((name: string, input: string | null): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      let found = false;
      const updatedContent: ReadonlyArray<ContentPart> = [...last.content].reverse().map((p) => {
        if (!found && p.type === "tool_call" && p.name === name && p.status === "started") {
          found = true;
          return { ...p, status: "completed" as const, input };
        }
        return p;
      }).reverse();
      if (!found) return prev;
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
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") {
        const errorMsg: StoredMessage = {
          role: "assistant",
          content: [{ type: "text", text: errorText }],
          timestamp: Date.now(),
          isError: true,
        };
        return [...prev, errorMsg];
      }
      const updated: StoredMessage = {
        ...last,
        content: [{ type: "text", text: errorText }],
        isError: true,
      };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const clearHistory = useCallback((): void => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return {
    messages,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    appendToolCall,
    completeToolCall,
    finalizeAssistant,
    markAssistantError,
    clearHistory,
  };
};
