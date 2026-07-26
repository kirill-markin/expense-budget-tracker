import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatTargetUrl,
  getChatSelectionStorageKey,
  readChatSelection,
  readChatSessionTargetFromSearchParams,
  writeChatSelection,
  type ChatSelectionScope,
} from "./chatSelectionStorage";

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

test("selection keys isolate authenticated users, workspaces, and demo mode", (): void => {
  const scopes: ReadonlyArray<ChatSelectionScope> = [
    { mode: "workspace", userId: "user-1", workspaceId: "workspace-1" },
    { mode: "workspace", userId: "user-2", workspaceId: "workspace-1" },
    { mode: "workspace", userId: "user-1", workspaceId: "workspace-2" },
    { mode: "demo", userId: "user-1" },
  ];
  const keys = scopes.map(getChatSelectionStorageKey);

  assert.equal(new Set(keys).size, keys.length);
});

test("session storage round-trips only the selected target per tab", (): void => {
  const firstTabStorage = createStorage();
  const secondTabStorage = createStorage();
  const scope: ChatSelectionScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };

  writeChatSelection(
    firstTabStorage,
    scope,
    { kind: "draft", draftId: "draft-1" },
  );
  assert.deepEqual(readChatSelection(firstTabStorage, scope), {
    kind: "draft",
    draftId: "draft-1",
  });
  assert.equal(readChatSelection(secondTabStorage, scope), null);

  writeChatSelection(
    firstTabStorage,
    scope,
    { kind: "session", sessionId: "session-1" },
  );
  assert.deepEqual(readChatSelection(firstTabStorage, scope), {
    kind: "session",
    sessionId: "session-1",
  });
});

test("invalid stored selections fail explicitly without inventing a session id", (): void => {
  const storage = createStorage();
  const scope: ChatSelectionScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const storageKey = getChatSelectionStorageKey(scope);

  storage.setItem(storageKey, "not-json");
  assert.throws(
    () => readChatSelection(storage, scope),
    /Stored chat selection is not valid JSON/u,
  );

  storage.setItem(storageKey, JSON.stringify({
    kind: "session",
    sessionId: "",
  }));
  assert.throws(
    () => readChatSelection(storage, scope),
    /Stored chat selection sessionId must contain 1-200 characters/u,
  );
});

test("fullscreen URL parsing validates one explicit historical session", (): void => {
  assert.equal(
    readChatSessionTargetFromSearchParams(new URLSearchParams()),
    null,
  );
  assert.deepEqual(
    readChatSessionTargetFromSearchParams(
      new URLSearchParams("session=session%2Fone"),
    ),
    { kind: "session", sessionId: "session/one" },
  );
  assert.throws(
    () => readChatSessionTargetFromSearchParams(
      new URLSearchParams("session=one&session=two"),
    ),
    /at most one session query parameter/u,
  );
  assert.throws(
    () => readChatSessionTargetFromSearchParams(
      new URLSearchParams("session="),
    ),
    /session query parameter must contain 1-200 characters/u,
  );
});

test("fullscreen target URLs are canonical for sessions and local drafts", (): void => {
  assert.equal(
    buildChatTargetUrl({ kind: "session", sessionId: "session/one" }),
    "/chat?session=session%2Fone",
  );
  assert.equal(
    buildChatTargetUrl({ kind: "draft", draftId: "draft-1" }),
    "/chat",
  );
});
