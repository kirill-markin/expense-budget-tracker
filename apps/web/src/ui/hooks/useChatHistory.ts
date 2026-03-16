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
  completeToolCall: (name: string, input: string | null, output: string | null) => void;
  finalizeAssistant: () => void;
  markAssistantError: (errorText: string) => void;
  clearHistory: () => void;
}>;

type StoredChatEnvelope = Readonly<{
  workspaceId: string;
  messages: ReadonlyArray<StoredMessage>;
}>;

type StorageLike = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

const STORAGE_KEY = "expense-tracker-chat-messages";
const MAX_MESSAGES = 200;

const getBrowserStorage = (): StorageLike | null =>
  typeof localStorage === "undefined" ? null : localStorage;

const isStoredMessageArray = (value: unknown): value is ReadonlyArray<StoredMessage> =>
  Array.isArray(value);

export const loadStoredMessages = (
  storage: StorageLike | null,
  workspaceId: string,
): ReadonlyArray<StoredMessage> => {
  if (storage === null) {
    return [];
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (isStoredMessageArray(parsed)) {
      return parsed.slice(-MAX_MESSAGES);
    }
    if (
      typeof parsed === "object"
      && parsed !== null
      && "workspaceId" in parsed
      && "messages" in parsed
      && (parsed as { workspaceId?: unknown }).workspaceId === workspaceId
      && isStoredMessageArray((parsed as { messages?: unknown }).messages)
    ) {
      return (parsed as StoredChatEnvelope).messages.slice(-MAX_MESSAGES);
    }
    return [];
  } catch {
    return [];
  }
};

export const saveStoredMessages = (
  storage: StorageLike | null,
  workspaceId: string,
  messages: ReadonlyArray<StoredMessage>,
): void => {
  if (storage === null) {
    return;
  }

  try {
    const payload: StoredChatEnvelope = {
      workspaceId,
      messages: messages.slice(-MAX_MESSAGES),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage full — silently drop
  }
};

export const clearStoredMessages = (storage: StorageLike | null): void => {
  if (storage === null) {
    return;
  }
  storage.removeItem(STORAGE_KEY);
};

export const useChatHistory = (workspaceId: string): ChatHistoryState => {
  const [messages, setMessages] = useState<ReadonlyArray<StoredMessage>>([]);
  const loadedRef = useRef<boolean>(false);

  useEffect(() => {
    setMessages(loadStoredMessages(getBrowserStorage(), workspaceId));
    loadedRef.current = true;
  }, [workspaceId]);

  // Persist on every change after initial load
  useEffect(() => {
    if (!loadedRef.current) return;
    saveStoredMessages(getBrowserStorage(), workspaceId, messages);
  }, [messages, workspaceId]);

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
      const part: ContentPart = { type: "tool_call", name, status: "started", input: null, output: null };
      const updated: StoredMessage = { ...last, content: [...last.content, part] };
      return [...prev.slice(0, -1), updated];
    });
  }, []);

  const completeToolCall = useCallback((name: string, input: string | null, output: string | null): void => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      let found = false;
      const updatedContent: ReadonlyArray<ContentPart> = [...last.content].reverse().map((p) => {
        if (!found && p.type === "tool_call" && p.name === name && p.status === "started") {
          found = true;
          return { ...p, status: "completed" as const, input, output };
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
    clearStoredMessages(getBrowserStorage());
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
