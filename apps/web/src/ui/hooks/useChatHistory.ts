"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentPart, ToolCallContentPart } from "@/server/chat/types";

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
  upsertToolCall: (toolCall: ToolCallContentPart) => void;
  finalizeAssistant: () => void;
  markAssistantError: (errorText: string) => void;
  clearHistory: () => void;
}>;

export type StoredChatState = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
}>;

type StoredChatEnvelope = Readonly<{
  workspaceId: string;
  chatSessionId?: string;
  codeInterpreterContainerId?: string | null;
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

const createEmptyStoredChatState = (): StoredChatState => ({
  messages: [],
});

const isStoredMessageArray = (value: unknown): value is ReadonlyArray<StoredMessage> =>
  Array.isArray(value);

export const loadStoredChatState = (
  storage: StorageLike | null,
  workspaceId: string,
): StoredChatState => {
  if (storage === null) {
    return createEmptyStoredChatState();
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) {
      return createEmptyStoredChatState();
    }

    const parsed = JSON.parse(raw) as unknown;
    if (isStoredMessageArray(parsed)) {
      return {
        messages: parsed.slice(-MAX_MESSAGES),
      };
    }
    if (
      typeof parsed === "object"
      && parsed !== null
      && "workspaceId" in parsed
      && "messages" in parsed
      && (parsed as { workspaceId?: unknown }).workspaceId === workspaceId
      && isStoredMessageArray((parsed as { messages?: unknown }).messages)
    ) {
      const envelope = parsed as StoredChatEnvelope;
      return {
        messages: envelope.messages.slice(-MAX_MESSAGES),
      };
    }
    return createEmptyStoredChatState();
  } catch {
    return createEmptyStoredChatState();
  }
};

export const loadStoredMessages = (
  storage: StorageLike | null,
  workspaceId: string,
): ReadonlyArray<StoredMessage> => {
  return loadStoredChatState(storage, workspaceId).messages;
};

export const saveStoredChatState = (
  storage: StorageLike | null,
  workspaceId: string,
  state: StoredChatState,
): void => {
  if (storage === null) {
    return;
  }

  try {
    const payload: StoredChatEnvelope = {
      workspaceId,
      messages: state.messages.slice(-MAX_MESSAGES),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage full — silently drop
  }
};

export const saveStoredMessages = (
  storage: StorageLike | null,
  workspaceId: string,
  messages: ReadonlyArray<StoredMessage>,
): void => {
  saveStoredChatState(storage, workspaceId, { messages });
};

export const clearStoredMessages = (storage: StorageLike | null): void => {
  if (storage === null) {
    return;
  }
  storage.removeItem(STORAGE_KEY);
};

export const upsertToolCallContent = (
  content: ReadonlyArray<ContentPart>,
  toolCall: ToolCallContentPart,
): ReadonlyArray<ContentPart> => {
  let found = false;
  const updatedContent = content.map((part) => {
    if (
      !found
      && part.type === "tool_call"
      && part.id !== undefined
      && toolCall.id !== undefined
      && part.id === toolCall.id
    ) {
      found = true;
      return {
        ...part,
        name: toolCall.name,
        status: toolCall.status,
        providerStatus: toolCall.providerStatus,
        input: toolCall.input,
        output: toolCall.output,
      };
    }
    return part;
  });

  if (found) {
    return updatedContent;
  }

  return [...content, toolCall];
};

export const useChatHistory = (workspaceId: string): ChatHistoryState => {
  const [messages, setMessages] = useState<ReadonlyArray<StoredMessage>>([]);
  const loadedRef = useRef<boolean>(false);

  useEffect(() => {
    const state = loadStoredChatState(getBrowserStorage(), workspaceId);
    setMessages(state.messages);
    loadedRef.current = true;
  }, [workspaceId]);

  // Persist on every change after initial load
  useEffect(() => {
    if (!loadedRef.current) return;
    saveStoredChatState(getBrowserStorage(), workspaceId, {
      messages,
    });
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
    upsertToolCall,
    finalizeAssistant,
    markAssistantError,
    clearHistory,
  };
};
