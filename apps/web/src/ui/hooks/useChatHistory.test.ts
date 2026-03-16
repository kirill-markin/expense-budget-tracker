import assert from "node:assert/strict";
import test from "node:test";

import { clearStoredMessages, loadStoredMessages, saveStoredMessages, type StoredMessage } from "./useChatHistory";

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

test("clearStoredMessages removes persisted chat history", () => {
  const storage = createStorage();
  saveStoredMessages(storage, "workspace-a", [createMessage("hello")]);

  clearStoredMessages(storage);

  assert.equal(loadStoredMessages(storage, "workspace-a").length, 0);
});
