import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatTargetUrl,
  clearChatSelection,
  clearChatSelectionState,
  getChatActiveDraftStorageKey,
  getChatSelectionStorageKey,
  readChatActiveDraftId,
  readChatSelection,
  readChatSessionTargetFromSearchParams,
  writeChatActiveDraftId,
  writeChatSelection,
  type ChatSelectionScope,
} from "./chatSelectionStorage";
import type { ChatSessionSummary } from "./chatSessionSummaryTransport";
import {
  resolveAutomaticChatTarget,
  type ChatTarget,
} from "./chatWorkspaceState";

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

  clearChatSelection(firstTabStorage, scope);
  assert.equal(readChatSelection(firstTabStorage, scope), null);
});

test("automatic drafts do not mask running or recent sessions after reload", (): void => {
  const storage = createStorage();
  const scope: ChatSelectionScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const selectionKey = getChatSelectionStorageKey(scope);
  const currentTimeMs = Date.parse("2026-07-26T12:30:00.000Z");
  const createSummary = (
    status: ChatSessionSummary["status"],
  ): ChatSessionSummary => ({
    sessionId: `session-${status}`,
    title: `Session ${status}`,
    lastMessageAt: "2026-07-26T12:00:00.000Z",
    status,
    mainContentInvalidationVersion: 0,
  });

  storage.setItem(selectionKey, JSON.stringify({
    kind: "draft",
    draftId: "draft-automatic",
  }));
  assert.equal(readChatSelection(storage, scope), null);
  for (const summary of [
    createSummary("running"),
    createSummary("idle"),
  ]) {
    const restoredTarget: ChatTarget = readChatSelection(storage, scope)
      ?? resolveAutomaticChatTarget(
        [summary],
        currentTimeMs,
        "draft-automatic",
      );
    assert.deepEqual(restoredTarget, {
      kind: "session",
      sessionId: summary.sessionId,
    });
  }

  writeChatSelection(
    storage,
    scope,
    { kind: "draft", draftId: "draft-explicit" },
  );
  const explicitTarget = readChatSelection(storage, scope)
    ?? resolveAutomaticChatTarget(
      [createSummary("running")],
      currentTimeMs,
      "draft-automatic",
    );
  assert.deepEqual(explicitTarget, {
    kind: "draft",
    draftId: "draft-explicit",
  });
});

test("active draft pointers remain separate from selected sessions and other tabs", (): void => {
  const firstTabStorage = createStorage();
  const secondTabStorage = createStorage();
  const scope: ChatSelectionScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };

  writeChatActiveDraftId(firstTabStorage, scope, "draft-1");
  writeChatSelection(
    firstTabStorage,
    scope,
    { kind: "session", sessionId: "session-1" },
  );

  assert.equal(readChatActiveDraftId(firstTabStorage, scope), "draft-1");
  assert.equal(readChatActiveDraftId(secondTabStorage, scope), null);
  assert.deepEqual(readChatSelection(firstTabStorage, scope), {
    kind: "session",
    sessionId: "session-1",
  });

  writeChatActiveDraftId(firstTabStorage, scope, null);
  assert.equal(readChatActiveDraftId(firstTabStorage, scope), null);
});

test("active draft pointers are isolated between workspace and demo scopes", (): void => {
  const storage = createStorage();
  const workspaceScope: ChatSelectionScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const demoScope: ChatSelectionScope = {
    mode: "demo",
    userId: "user-1",
  };

  writeChatActiveDraftId(storage, workspaceScope, "draft-workspace");
  writeChatActiveDraftId(storage, demoScope, "draft-demo");

  assert.notEqual(
    getChatActiveDraftStorageKey(workspaceScope),
    getChatActiveDraftStorageKey(demoScope),
  );
  assert.equal(
    readChatActiveDraftId(storage, workspaceScope),
    "draft-workspace",
  );
  assert.equal(readChatActiveDraftId(storage, demoScope), "draft-demo");
});

test("selection cleanup clears selection and active draft pointers only", (): void => {
  const storage = createStorage();
  const scope: ChatSelectionScope = {
    mode: "workspace",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  writeChatSelection(
    storage,
    scope,
    { kind: "session", sessionId: "session-1" },
  );
  writeChatActiveDraftId(storage, scope, "draft-1");
  storage.setItem("unrelated", "keep");

  clearChatSelectionState(storage);

  assert.equal(readChatSelection(storage, scope), null);
  assert.equal(readChatActiveDraftId(storage, scope), null);
  assert.equal(storage.getItem("unrelated"), "keep");
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

  storage.setItem(getChatActiveDraftStorageKey(scope), "");
  assert.throws(
    () => readChatActiveDraftId(storage, scope),
    /Stored active chat draftId must contain 1-200 characters/u,
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
