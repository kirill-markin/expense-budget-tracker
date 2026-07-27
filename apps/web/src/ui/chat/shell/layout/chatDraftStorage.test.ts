import assert from "node:assert/strict";
import test from "node:test";

import {
  clearChatDrafts,
  getChatDraftStorageKey,
  readAndMigrateChatDraft,
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

const createStorageWithSetItemFailure = (
  failedStorageKey: string,
): Storage => {
  const storage = createStorage();

  return {
    get length(): number {
      return storage.length;
    },
    clear: storage.clear,
    getItem: storage.getItem,
    key: storage.key,
    removeItem: storage.removeItem,
    setItem: (key: string, value: string): void => {
      if (key === failedStorageKey) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      storage.setItem(key, value);
    },
  };
};

test("draft keys isolate authenticated users, workspaces, and demo mode", (): void => {
  const userOneWorkspaceOne: ChatDraftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const target = { kind: "draft", draftId: "draft-1" } as const;
  const keys = [
    getChatDraftStorageKey(userOneWorkspaceOne, target),
    getChatDraftStorageKey({
      mode: "workspace",
      userId: "user-2",
      workspaceId: "workspace-1",
    }, target),
    getChatDraftStorageKey({
      mode: "workspace",
      userId: "user-1",
      workspaceId: "workspace-2",
    }, target),
    getChatDraftStorageKey({
      mode: "demo",
      userId: "user-1",
    }, target),
    getChatDraftStorageKey(userOneWorkspaceOne, {
      kind: "session",
      sessionId: "session-1",
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
  const target = { kind: "session", sessionId: "session-1" } as const;

  writeChatDraft(storage, scope, target, "unsent text");
  assert.equal(readAndMigrateChatDraft(storage, scope, target), "unsent text");

  writeChatDraft(storage, scope, target, "");
  assert.equal(readAndMigrateChatDraft(storage, scope, target), "");
  assert.equal(storage.length, 0);
});

test("separate tab storage does not share a draft", (): void => {
  const firstTabStorage = createStorage();
  const secondTabStorage = createStorage();
  const scope: ChatDraftScope = {
    mode: "demo",
    userId: "user-1",
  };
  const target = { kind: "draft", draftId: "draft-1" } as const;

  writeChatDraft(firstTabStorage, scope, target, "first tab draft");

  assert.equal(readAndMigrateChatDraft(firstTabStorage, scope, target), "first tab draft");
  assert.equal(readAndMigrateChatDraft(secondTabStorage, scope, target), "");
});

test("logout clearing removes chat drafts and preserves unrelated session data", (): void => {
  const storage = createStorage();
  writeChatDraft(
    storage,
    { mode: "demo", userId: "user-1" },
    { kind: "draft", draftId: "draft-1" },
    "demo draft",
  );
  writeChatDraft(storage, {
    mode: "workspace",
    userId: "user-2",
    workspaceId: "workspace-1",
  }, {
    kind: "session",
    sessionId: "session-1",
  }, "workspace draft");
  storage.setItem(
    "expense-tracker-chat-draft:v1:workspace:user-1:workspace-legacy",
    "legacy draft",
  );
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
    }, {
      kind: "draft",
      draftId: "draft-1",
    }),
    /empty workspaceId/u,
  );
});

test("draft text is isolated by target within one user and workspace", (): void => {
  const storage = createStorage();
  const scope: ChatDraftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const firstTarget = { kind: "session", sessionId: "session-1" } as const;
  const secondTarget = { kind: "session", sessionId: "session-2" } as const;

  writeChatDraft(storage, scope, firstTarget, "first chat");
  writeChatDraft(storage, scope, secondTarget, "second chat");

  assert.equal(readAndMigrateChatDraft(storage, scope, firstTarget), "first chat");
  assert.equal(readAndMigrateChatDraft(storage, scope, secondTarget), "second chat");
});

test("legacy scope draft migrates once to the first selected target", (): void => {
  const storage = createStorage();
  const scope: ChatDraftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const firstTarget = { kind: "draft", draftId: "draft-1" } as const;
  const secondTarget = { kind: "session", sessionId: "session-1" } as const;
  const legacyStorageKey =
    "expense-tracker-chat-draft:v1:workspace:user-1:workspace-1";
  storage.setItem(legacyStorageKey, "legacy unsent text");

  assert.equal(
    readAndMigrateChatDraft(storage, scope, firstTarget),
    "legacy unsent text",
  );
  assert.equal(storage.getItem(legacyStorageKey), null);
  assert.equal(
    storage.getItem(getChatDraftStorageKey(scope, firstTarget)),
    "legacy unsent text",
  );
  assert.equal(readAndMigrateChatDraft(storage, scope, secondTarget), "");
});

test("failed v2 migration preserves the legacy draft", (): void => {
  const scope: ChatDraftScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const target = { kind: "draft", draftId: "draft-1" } as const;
  const storageKey = getChatDraftStorageKey(scope, target);
  const storage = createStorageWithSetItemFailure(storageKey);
  const legacyStorageKey =
    "expense-tracker-chat-draft:v1:workspace:user-1:workspace-1";
  storage.setItem(legacyStorageKey, "legacy unsent text");

  assert.throws(
    () => readAndMigrateChatDraft(storage, scope, target),
    { name: "QuotaExceededError" },
  );
  assert.equal(storage.getItem(legacyStorageKey), "legacy unsent text");
  assert.equal(storage.getItem(storageKey), null);
});

test("current target draft wins over a stale legacy draft", (): void => {
  const storage = createStorage();
  const scope: ChatDraftScope = {
    mode: "demo",
    userId: "user-1",
  };
  const target = { kind: "draft", draftId: "draft-1" } as const;
  const legacyStorageKey = "expense-tracker-chat-draft:v1:demo:user-1";
  storage.setItem(legacyStorageKey, "stale legacy text");
  writeChatDraft(storage, scope, target, "current text");

  assert.equal(readAndMigrateChatDraft(storage, scope, target), "current text");
  assert.equal(storage.getItem(legacyStorageKey), null);
});
