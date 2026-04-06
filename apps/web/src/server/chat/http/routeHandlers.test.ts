import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { SupportedLocale } from "@/lib/locale";
import {
  deleteChatRouteWithDeps,
  getChatRouteWithDeps,
  postChatRouteWithDeps,
} from "@/server/chat/http/routeHandlers";
import type { ChatSessionSnapshot, PreparedChatRun } from "@/server/chat/store";
import {
  ChatSessionConflictError,
  ChatSessionNotFoundError,
} from "@/server/chat/store";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";

const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

const createHeaders = (): Headers =>
  new Headers({
    "content-type": "application/json",
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

const createSnapshot = (
  overrides: Partial<ChatSessionSnapshot> = {},
): ChatSessionSnapshot => ({
  sessionId: "session-1",
  runState: "idle",
  updatedAt: 100,
  activeRunHeartbeatAt: null,
  mainContentInvalidationVersion: 0,
  messages: [],
  ...overrides,
});

const createPreparedRun = (
  sessionId: string,
): PreparedChatRun => ({
  sessionId,
  assistantItem: {
    itemId: "assistant-1",
    sessionId,
    role: "assistant",
    content: [],
    state: "in_progress",
    isError: false,
    isStopped: false,
    timestamp: 0,
    updatedAt: 0,
  },
  localMessages: [],
  turnInput: [{ type: "text", text: "Hello" }],
});

const createChatRequest = (
  body: unknown,
  init?: Readonly<{ headers?: Headers; url?: string; method?: string }>,
): Request =>
  new Request(init?.url ?? "http://localhost/api/chat", {
    method: init?.method ?? "POST",
    headers: init?.headers ?? createHeaders(),
    body: JSON.stringify(body),
  });

const createPostDependencies = (
  overrides: Partial<Parameters<typeof postChatRouteWithDeps>[1]> = {},
): Parameters<typeof postChatRouteWithDeps>[1] => ({
  getLocaleFromRequest: overrides.getLocaleFromRequest ?? (() => "en" as SupportedLocale),
  resolveSnapshotWithRunRecovery: overrides.resolveSnapshotWithRunRecovery ?? (async () => createSnapshot()),
  prepareChatRun: overrides.prepareChatRun ?? (async (
    _userId: string,
    _workspaceId: string,
    sessionId: string | undefined,
    _content: ReadonlyArray<ContentPart>,
  ) => createPreparedRun(sessionId ?? "session-1")),
  startPersistedChatRun: overrides.startPersistedChatRun ?? (() => (async function* (): AsyncGenerator<ChatStreamEvent> {
    yield { type: "done" };
  })()),
  isServerDraining: overrides.isServerDraining ?? (() => false),
  log: overrides.log ?? (() => undefined),
});

const withOpenAiApiKey = async (
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const previousValue = process.env[OPENAI_API_KEY_ENV];
  if (value === undefined) {
    delete process.env[OPENAI_API_KEY_ENV];
  } else {
    process.env[OPENAI_API_KEY_ENV] = value;
  }

  try {
    await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[OPENAI_API_KEY_ENV];
    } else {
      process.env[OPENAI_API_KEY_ENV] = previousValue;
    }
  }
};

test("postChatRouteWithDeps returns 400 for invalid request bodies", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({ model: CHAT_MODEL_ID, timezone: "Europe/Madrid" }),
      createPostDependencies(),
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "content array is empty");
  });
});

test("postChatRouteWithDeps returns 400 for unsupported models", async (): Promise<void> => {
  const response = await postChatRouteWithDeps(
    createChatRequest({
      content: [{ type: "text", text: "Hello" }],
      model: "wrong-model",
      timezone: "Europe/Madrid",
    }),
    createPostDependencies(),
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), `Unsupported model: wrong-model. Expected ${CHAT_MODEL_ID}`);
});

test("postChatRouteWithDeps returns 500 when OPENAI_API_KEY is missing", async (): Promise<void> => {
  await withOpenAiApiKey(undefined, async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies(),
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "OPENAI_API_KEY environment variable is not set");
  });
});

test("postChatRouteWithDeps returns 401 when auth headers are missing", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest(
        {
          content: [{ type: "text", text: "Hello" }],
          model: CHAT_MODEL_ID,
          timezone: "Europe/Madrid",
        },
        {
          headers: new Headers({ "content-type": "application/json" }),
        },
      ),
      createPostDependencies(),
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "Missing x-user-id header — proxy misconfiguration");
  });
});

test("postChatRouteWithDeps maps chat session conflicts to 409", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        resolveSnapshotWithRunRecovery: async () => {
          throw new ChatSessionConflictError("session-1");
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(await response.text(), "Chat session already has an active response");
  });
});

test("getChatRouteWithDeps maps missing sessions to 404", async (): Promise<void> => {
  const response = await getChatRouteWithDeps(
    new Request("http://localhost/api/chat?sessionId=missing", {
      method: "GET",
      headers: createHeaders(),
    }),
    {
      resolveSnapshotWithRunRecovery: async () => {
        throw new ChatSessionNotFoundError("missing");
      },
    },
  );

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Chat session not found: missing");
});

test("postChatRouteWithDeps returns SSE headers for successful runs", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        startPersistedChatRun: () => (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: "delta", text: "Hi", itemId: "assistant-1", outputIndex: 0, contentIndex: 0, sequenceNumber: 0 };
          yield { type: "done" };
        })(),
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
    assert.equal(response.headers.get("Connection"), "keep-alive");
    assert.equal(response.headers.get("X-Chat-Session-Id"), "session-1");
  });
});

test("deleteChatRouteWithDeps returns the same session when it is already empty", async (): Promise<void> => {
  let createFreshChatSessionCalled = false;
  const response = await deleteChatRouteWithDeps(
    new Request("http://localhost/api/chat?sessionId=session-1", {
      method: "DELETE",
      headers: createHeaders(),
    }),
    {
      getChatSessionSnapshot: async () => createSnapshot({ sessionId: "session-1", messages: [] }),
      getLatestChatSessionId: async () => null,
      createFreshChatSession: async () => {
        createFreshChatSessionCalled = true;
        return "session-2";
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sessionId: "session-1" });
  assert.equal(createFreshChatSessionCalled, false);
});

test("deleteChatRouteWithDeps creates a fresh session when the latest session has messages", async (): Promise<void> => {
  const response = await deleteChatRouteWithDeps(
    new Request("http://localhost/api/chat", {
      method: "DELETE",
      headers: createHeaders(),
    }),
    {
      getChatSessionSnapshot: async () => createSnapshot({
        sessionId: "session-1",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 0,
          isError: false,
          isStopped: false,
        }],
      }),
      getLatestChatSessionId: async () => "session-1",
      createFreshChatSession: async () => "session-2",
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sessionId: "session-2" });
});
