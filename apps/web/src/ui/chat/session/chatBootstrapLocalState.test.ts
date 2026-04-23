import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_LOCAL_STATE_STALE_MS,
  createChatBootstrapLocalState,
  deriveLastUserMessageAt,
  parseChatBootstrapLocalState,
  readChatBootstrapLocalStateFromStorageEvent,
  resolveChatBootstrapMode,
} from "./chatBootstrapLocalState";

test("deriveLastUserMessageAt returns the last user-authored timestamp", (): void => {
  const lastUserMessageAt = deriveLastUserMessageAt([
    {
      role: "assistant",
      content: [{ type: "text", text: "First" }],
      timestamp: 10,
      isError: false,
      isStopped: false,
    },
    {
      role: "user",
      content: [{ type: "text", text: "Second" }],
      timestamp: 20,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Third" }],
      timestamp: 30,
      isError: false,
      isStopped: false,
    },
  ]);

  assert.equal(lastUserMessageAt, 20);
});

test("resolveChatBootstrapMode keeps server bootstrap for recent user activity", (): void => {
  const state = createChatBootstrapLocalState("session-1", 1_000, "idle", 1_000);

  assert.deepEqual(
    resolveChatBootstrapMode(state, 1_000 + CHAT_LOCAL_STATE_STALE_MS),
    { kind: "server" },
  );
});

test("resolveChatBootstrapMode opens a fresh local chat after six hours of user inactivity", (): void => {
  const state = createChatBootstrapLocalState("session-1", 1_000, "idle", 1_000);

  assert.deepEqual(
    resolveChatBootstrapMode(state, 1_001 + CHAT_LOCAL_STATE_STALE_MS),
    { kind: "local_empty", sessionId: null },
  );
});

test("resolveChatBootstrapMode revalidates an empty cached session through the server", (): void => {
  const state = createChatBootstrapLocalState("session-2", null, "idle", 1_000);

  assert.deepEqual(
    resolveChatBootstrapMode(state, 1_500),
    { kind: "server" },
  );
});

test("resolveChatBootstrapMode keeps a fully local empty chat when no session exists yet", (): void => {
  const state = createChatBootstrapLocalState(null, null, "idle", 1_000);

  assert.deepEqual(
    resolveChatBootstrapMode(state, 1_500),
    { kind: "local_empty", sessionId: null },
  );
});

test("resolveChatBootstrapMode ignores assistant-only freshness for interrupted or running sessions", (): void => {
  const interruptedState = createChatBootstrapLocalState("session-3", null, "interrupted", 1_000);
  const runningState = createChatBootstrapLocalState("session-4", null, "running", 1_000);

  assert.deepEqual(resolveChatBootstrapMode(interruptedState, 2_000), { kind: "server" });
  assert.deepEqual(resolveChatBootstrapMode(runningState, 2_000), { kind: "server" });
});

test("parseChatBootstrapLocalState rejects invalid payloads", (): void => {
  assert.equal(parseChatBootstrapLocalState("not-json"), null);
  assert.deepEqual(
    parseChatBootstrapLocalState(JSON.stringify({
      version: 1,
      sessionId: null,
      lastUserMessageAt: 1,
      lastKnownRunState: "idle",
      lastSnapshotUpdatedAt: 2,
    })),
    createChatBootstrapLocalState(null, 1, "idle", 2),
  );
  assert.equal(
    parseChatBootstrapLocalState(JSON.stringify({
      version: 1,
      sessionId: null,
      lastUserMessageAt: 1,
      lastKnownRunState: "running",
      lastSnapshotUpdatedAt: 2,
    })),
    null,
  );
});

test("readChatBootstrapLocalStateFromStorageEvent parses relevant storage updates", (): void => {
  const state = createChatBootstrapLocalState("session-5", 100, "idle", 100);
  const serializedState = JSON.stringify(state);

  assert.equal(
    readChatBootstrapLocalStateFromStorageEvent("workspace-1", "other-key", serializedState),
    undefined,
  );
  assert.deepEqual(
    readChatBootstrapLocalStateFromStorageEvent(
      "workspace-1",
      "expense-tracker-chat-local-state:workspace-1",
      serializedState,
    ),
    state,
  );
  assert.equal(
    readChatBootstrapLocalStateFromStorageEvent(
      "workspace-1",
      "expense-tracker-chat-local-state:workspace-1",
      null,
    ),
    null,
  );
});
