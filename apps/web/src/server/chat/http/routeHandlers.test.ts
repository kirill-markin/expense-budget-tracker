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
import type { ChatRunStartReservation } from "@/server/chat/runtime/runtime";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";

const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const HEIC_BASE64_PREFIX = "AAAAGGZ0eXBoZWljAAAAAA==";
const HEIC_COMPATIBLE_BRAND_BASE64 = "AAAAFGZ0eXBpc29tAAAAAGhlaWM=";
const HEIC_UNPADDED_BASE64_PREFIX = HEIC_BASE64_PREFIX.slice(0, -2);
const HEIC_WHITESPACE_BASE64_PREFIX = "AAAA GGZ0eXBo\nZWljAAAAAA==";

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
  activeRunId: null,
  activeRunHeartbeatAt: null,
  mainContentInvalidationVersion: 0,
  messages: [],
  ...overrides,
});

const createPreparedRun = (
  sessionId: string,
): PreparedChatRun => ({
  sessionId,
  activeRunId: `run-${sessionId}`,
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

const createReservation = (
  sessionId: string,
): ChatRunStartReservation => ({
  sessionId,
  reservationId: Symbol(sessionId),
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
  reserveChatRunStart: overrides.reserveChatRunStart ?? ((sessionId) => createReservation(sessionId)),
  releaseChatRunStartReservation: overrides.releaseChatRunStartReservation ?? (() => undefined),
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

test("postChatRouteWithDeps rejects unsupported images before reserving or persisting a run", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    let snapshotCallCount = 0;
    let reservationCallCount = 0;
    let prepareCallCount = 0;
    let modelStartCallCount = 0;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{
          type: "image",
          mediaType: "image/jpeg",
          base64Data: HEIC_BASE64_PREFIX,
        }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        resolveSnapshotWithRunRecovery: async () => {
          snapshotCallCount += 1;
          return createSnapshot();
        },
        reserveChatRunStart: (sessionId) => {
          reservationCallCount += 1;
          return createReservation(sessionId);
        },
        prepareChatRun: async () => {
          prepareCallCount += 1;
          return createPreparedRun("session-1");
        },
        startPersistedChatRun: () => {
          modelStartCallCount += 1;
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    assert.equal(response.status, 400);
    assert.match(await response.text(), /image\/heic signature/);
    assert.equal(response.headers.get("content-type"), "text/plain;charset=UTF-8");
    assert.equal(snapshotCallCount, 0);
    assert.equal(reservationCallCount, 0);
    assert.equal(prepareCallCount, 0);
    assert.equal(modelStartCallCount, 0);
  });
});

test("postChatRouteWithDeps rejects generic HEIC signatures before persistence", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    let snapshotCallCount = 0;
    let reservationCallCount = 0;
    let prepareCallCount = 0;
    let modelStartCallCount = 0;
    const disguisedHeicData: ReadonlyArray<string> = [
      HEIC_UNPADDED_BASE64_PREFIX,
      HEIC_WHITESPACE_BASE64_PREFIX,
      HEIC_COMPATIBLE_BRAND_BASE64,
    ];

    for (const base64Data of disguisedHeicData) {
      const response = await postChatRouteWithDeps(
        createChatRequest({
          sessionId: "session-1",
          content: [{
            type: "file",
            fileName: "camera.bin",
            mediaType: "application/octet-stream",
            base64Data,
          }],
          model: CHAT_MODEL_ID,
          timezone: "Europe/Madrid",
        }),
        createPostDependencies({
          resolveSnapshotWithRunRecovery: async () => {
            snapshotCallCount += 1;
            return createSnapshot();
          },
          reserveChatRunStart: (sessionId) => {
            reservationCallCount += 1;
            return createReservation(sessionId);
          },
          prepareChatRun: async () => {
            prepareCallCount += 1;
            return createPreparedRun("session-1");
          },
          startPersistedChatRun: () => {
            modelStartCallCount += 1;
            return (async function* (): AsyncGenerator<ChatStreamEvent> {
              yield { type: "done" };
            })();
          },
        }),
      );

      assert.equal(response.status, 400);
      assert.match(await response.text(), /file signature/);
      assert.equal(response.headers.get("content-type"), "text/plain;charset=UTF-8");
    }

    assert.equal(snapshotCallCount, 0);
    assert.equal(reservationCallCount, 0);
    assert.equal(prepareCallCount, 0);
    assert.equal(modelStartCallCount, 0);
  });
});

test("postChatRouteWithDeps returns 400 for unsupported models", async (): Promise<void> => {
  const response = await postChatRouteWithDeps(
    createChatRequest({
      sessionId: "session-1",
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
        sessionId: "session-1",
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
          sessionId: "session-1",
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
        sessionId: "session-1",
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

test("postChatRouteWithDeps returns 409 without preparing DB run when local reservation is denied", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    let prepareCalled = false;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => null,
        prepareChatRun: async (): Promise<PreparedChatRun> => {
          prepareCalled = true;
          return createPreparedRun("session-1");
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(await response.text(), "Chat session already has an active response");
    assert.equal(prepareCalled, false);
  });
});

test("postChatRouteWithDeps releases the local reservation when DB prepare fails", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const reservation = createReservation("session-1");
    let releasedReservation: ChatRunStartReservation | null = null;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => reservation,
        releaseChatRunStartReservation: (released) => {
          releasedReservation = released;
        },
        prepareChatRun: async (): Promise<PreparedChatRun> => {
          throw new ChatSessionConflictError("session-1");
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(await response.text(), "Chat session already has an active response");
    assert.equal(releasedReservation, reservation);
  });
});

test("postChatRouteWithDeps consumes the reservation when runtime starts successfully", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const reservation = createReservation("session-1");
    let released = false;
    let startedWith: Readonly<{
      activeRunId: string;
      reservation: ChatRunStartReservation;
    }> | null = null;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => reservation,
        releaseChatRunStartReservation: () => {
          released = true;
        },
        prepareChatRun: async () => createPreparedRun("session-1"),
        startPersistedChatRun: (params, startReservation) => {
          startedWith = {
            activeRunId: params.activeRunId,
            reservation: startReservation,
          };
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(startedWith, {
      activeRunId: "run-session-1",
      reservation,
    });
    assert.equal(released, false);
  });
});

test("postChatRouteWithDeps rejects missing session ids", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies(),
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "sessionId must be a non-empty string");
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

test("getChatRouteWithDeps does not serialize internal active run fields", async (): Promise<void> => {
  const publicContent: ReadonlyArray<ContentPart> = [{ type: "text", text: "Hello" }];
  const response = await getChatRouteWithDeps(
    new Request("http://localhost/api/chat?sessionId=session-1", {
      method: "GET",
      headers: createHeaders(),
    }),
    {
      resolveSnapshotWithRunRecovery: async () => createSnapshot({
        runState: "running",
        activeRunId: "run-1",
        activeRunHeartbeatAt: 1_000,
        messages: [{
          itemId: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: publicContent,
          openaiItems: [{
            type: "function_call",
            call_id: "call-1",
            name: "lookup_transactions",
            arguments: "{}",
          }],
          state: "completed",
          timestamp: 123,
          updatedAt: 456,
          isError: false,
          isStopped: false,
        }],
      }),
    },
  );

  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    sessionId: "session-1",
    runState: "running",
    updatedAt: 100,
    mainContentInvalidationVersion: 0,
    messages: [{
      role: "assistant",
      content: publicContent,
      timestamp: 123,
      isError: false,
      isStopped: false,
    }],
  });
});

test("postChatRouteWithDeps returns SSE headers for successful runs", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
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
          itemId: "item-1",
          sessionId: "session-1",
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          state: "completed",
          timestamp: 0,
          updatedAt: 0,
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
