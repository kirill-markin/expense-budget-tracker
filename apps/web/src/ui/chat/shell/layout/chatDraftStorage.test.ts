import assert from "node:assert/strict";
import test from "node:test";

import {
  clearChatDrafts,
  getChatDraftStorageKey,
  readChatDraft,
  writeChatDraft,
  type ChatDraftScope,
} from "./chatDraftStorage";

const createStorage = (): Storage => {
  const values = new Map<string, string>();

  return {
    get length(): number {
      return values.size;
    },
    clear: (): void => values.clear(),
    getItem: (key: string): string | null => values.get(key) ?? null,
    key: (index: number): string | null => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string): void => {
      values.delete(key);
    },
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
};

test("draft keys isolate authenticated users, workspaces, and demo mode", (): void => {
  const userOneWorkspaceOne: ChatDraftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const keys = [
    getChatDraftStorageKey(userOneWorkspaceOne),
    getChatDraftStorageKey({
      mode: "workspace",
      userId: "user-2",
      workspaceId: "workspace-1",
    }),
    getChatDraftStorageKey({
      mode: "workspace",
      userId: "user-1",
      workspaceId: "workspace-2",
    }),
    getChatDraftStorageKey({
      mode: "demo",
      userId: "user-1",
    }),
  ];

  assert.equal(new Set(keys).size, keys.length);
});

test("draft text is restored and empty text removes the stored draft", (): void => {
  const storage = createStorage();
  const scope: ChatDraftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };

  writeChatDraft(storage, scope, "unsent text");
  assert.equal(readChatDraft(storage, scope), "unsent text");

  writeChatDraft(storage, scope, "");
  assert.equal(readChatDraft(storage, scope), "");
  assert.equal(storage.length, 0);
});

test("separate tab storage does not share a draft", (): void => {
  const firstTabStorage = createStorage();
  const secondTabStorage = createStorage();
  const scope: ChatDraftScope = {
    mode: "demo",
    userId: "user-1",
  };

  writeChatDraft(firstTabStorage, scope, "first tab draft");

  assert.equal(readChatDraft(firstTabStorage, scope), "first tab draft");
  assert.equal(readChatDraft(secondTabStorage, scope), "");
});

test("logout clearing removes chat drafts and preserves unrelated session data", (): void => {
  const storage = createStorage();
  writeChatDraft(storage, { mode: "demo", userId: "user-1" }, "demo draft");
  writeChatDraft(storage, {
    mode: "workspace",
    userId: "user-2",
    workspaceId: "workspace-1",
  }, "workspace draft");
  storage.setItem("unrelated-session-state", "keep me");

  clearChatDrafts(storage);

  assert.equal(storage.length, 1);
  assert.equal(storage.getItem("unrelated-session-state"), "keep me");
});

test("invalid draft scopes fail with an actionable error", (): void => {
  assert.throws(
    () => getChatDraftStorageKey({
      mode: "workspace",
      userId: "user-1",
      workspaceId: "",
    }),
    /empty workspaceId/u,
  );
});
