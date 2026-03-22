import assert from "node:assert/strict";
import test from "node:test";

import type { ContentPart } from "@/server/chat/types";
import {
  applyAssistantError,
  clearStoredMessages,
  loadStoredChatState,
  loadStoredMessages,
  saveStoredChatState,
  saveStoredMessages,
  upsertToolCallContent,
  type StoredMessage,
} from "./useChatHistory";

type StorageLike = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

const createStorage = (): StorageLike => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
};

const createMessage = (text: string): StoredMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
  isError: false,
});

test("loadStoredMessages returns workspace-matched messages", () => {
  const storage = createStorage();
  saveStoredMessages(storage, "workspace-a", [createMessage("hello")]);

  assert.deepEqual(loadStoredMessages(storage, "workspace-a"), [createMessage("hello")]);
});

test("loadStoredMessages clears history when stored workspace differs", () => {
  const storage = createStorage();
  saveStoredMessages(storage, "workspace-a", [createMessage("hello")]);

  assert.deepEqual(loadStoredMessages(storage, "workspace-b"), []);
});

test("loadStoredMessages keeps legacy message arrays readable", () => {
  const storage = createStorage();
  storage.setItem(
    "expense-tracker-chat-messages",
    JSON.stringify([createMessage("legacy")]),
  );

  assert.deepEqual(loadStoredMessages(storage, "workspace-a"), [createMessage("legacy")]);
});

test("loadStoredChatState migrates legacy stored envelopes by keeping only messages", () => {
  const storage = createStorage();
  storage.setItem(
    "expense-tracker-chat-messages",
    JSON.stringify({
      workspaceId: "workspace-a",
      messages: [createMessage("legacy-envelope")],
    }),
  );

  const state = loadStoredChatState(storage, "workspace-a");

  assert.deepEqual(state.messages, [createMessage("legacy-envelope")]);
});

test("saveStoredChatState persists messages without client container identifiers", () => {
  const storage = createStorage();
  saveStoredChatState(storage, "workspace-a", {
    messages: [createMessage("hello")],
  });

  assert.deepEqual(loadStoredChatState(storage, "workspace-a"), {
    messages: [createMessage("hello")],
  });
});

test("loadStoredChatState ignores legacy chat session and container identifiers", () => {
  const storage = createStorage();
  storage.setItem(
    "expense-tracker-chat-messages",
    JSON.stringify({
      workspaceId: "workspace-a",
      chatSessionId: "legacy-chat",
      codeInterpreterContainerId: "legacy-container",
      messages: [createMessage("hello")],
    }),
  );

  assert.deepEqual(loadStoredChatState(storage, "workspace-a"), {
    messages: [createMessage("hello")],
  });
});

test("clearStoredMessages removes persisted chat history", () => {
  const storage = createStorage();
  saveStoredMessages(storage, "workspace-a", [createMessage("hello")]);

  clearStoredMessages(storage);

  assert.equal(loadStoredMessages(storage, "workspace-a").length, 0);
});

test("upsertToolCallContent updates an existing tool call by id", () => {
  const content: ReadonlyArray<ContentPart> = [
    { type: "text", text: "Checking..." },
    {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
      output: null,
    },
  ];

  assert.deepEqual(
    upsertToolCallContent(content, {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "completed",
      providerStatus: "completed",
      input: "print('hello')",
      output: JSON.stringify([{ type: "logs", logs: "hello" }]),
    }),
    [
      { type: "text", text: "Checking..." },
      {
        type: "tool_call",
        id: "tool-1",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('hello')",
        output: JSON.stringify([{ type: "logs", logs: "hello" }]),
      },
    ],
  );
});

test("upsertToolCallContent appends when the existing history has no matching id", () => {
  const content: ReadonlyArray<ContentPart> = [
    {
      type: "tool_call",
      name: "query_database",
      status: "completed",
      input: "select 1",
      output: "[{\"value\":1}]",
    },
  ];

  assert.deepEqual(
    upsertToolCallContent(content, {
      type: "tool_call",
      id: "tool-2",
      name: "web_search_call",
      status: "started",
      providerStatus: "searching",
      input: "{\"query\":\"btc price\"}",
      output: null,
    }),
    [
      {
        type: "tool_call",
        name: "query_database",
        status: "completed",
        input: "select 1",
        output: "[{\"value\":1}]",
      },
      {
        type: "tool_call",
        id: "tool-2",
        name: "web_search_call",
        status: "started",
        providerStatus: "searching",
        input: "{\"query\":\"btc price\"}",
        output: null,
      },
    ],
  );
});

test("applyAssistantError preserves partial assistant content and appends a separate error", () => {
  const existingMessages: ReadonlyArray<StoredMessage> = [
    createMessage("user question"),
    {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer" }],
      timestamp: 2,
      isError: false,
    },
  ];

  assert.deepEqual(
    applyAssistantError(existingMessages, "Request failed: network error", 3),
    [
      createMessage("user question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        timestamp: 2,
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Request failed: network error" }],
        timestamp: 3,
        isError: true,
      },
    ],
  );
});

test("applyAssistantError reuses an empty assistant placeholder", () => {
  const existingMessages: ReadonlyArray<StoredMessage> = [
    createMessage("user question"),
    {
      role: "assistant",
      content: [],
      timestamp: 2,
      isError: false,
    },
  ];

  assert.deepEqual(
    applyAssistantError(existingMessages, "Request failed: network error", 3),
    [
      createMessage("user question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Request failed: network error" }],
        timestamp: 2,
        isError: true,
      },
    ],
  );
});

test("applyAssistantError appends an error when the last message is not assistant", () => {
  const existingMessages: ReadonlyArray<StoredMessage> = [
    createMessage("user question"),
  ];

  assert.deepEqual(
    applyAssistantError(existingMessages, "Request failed: network error", 3),
    [
      createMessage("user question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Request failed: network error" }],
        timestamp: 3,
        isError: true,
      },
    ],
  );
});
