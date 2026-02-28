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
      content: [{ type: "text", text: "" }],
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
      const textPart = last.content.find((p) => p.type === "text");
      if (textPart === undefined || textPart.type !== "text") return prev;
      const updatedContent: ReadonlyArray<ContentPart> = last.content.map((p) =>
        p.type === "text" ? { ...p, text: p.text + text } : p,
      );
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
    finalizeAssistant,
    markAssistantError,
    clearHistory,
  };
};
