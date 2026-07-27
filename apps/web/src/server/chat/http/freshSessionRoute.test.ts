import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { SupportedLocale } from "@/lib/locale";
import {
  postFreshChatSessionRouteWithDeps,
  prependSessionEvent,
} from "@/server/chat/http/freshSessionRoute";
import { CHAT_STREAM_INTERRUPTED_ERROR } from "@/server/chat/http/sessionRecovery";
import type {
  ChatRunStartReservation,
} from "@/server/chat/runtime/runtime";
import type {
  PersistedChatMessageItem,
  PreparedChatRun,
} from "@/server/chat/store";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";

const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

const createHeaders = (): Headers =>
  new Headers({
    "content-type": "application/json",
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

const createRequest = (body: unknown): Request =>
  new Request("http://localhost/api/chat/new", {
    method: "POST",
    headers: createHeaders(),
    body: JSON.stringify(body),
  });

const createAssistantItem = (): PersistedChatMessageItem => ({
  itemId: "assistant-1",
  sessionId: "session-1",
  role: "assistant",
  content: [],
  state: "in_progress",
  isError: false,
  isStopped: false,
  timestamp: 0,
  updatedAt: 0,
});

const createPreparedRun = (
  content: ReadonlyArray<ContentPart>,
): PreparedChatRun => ({
  sessionId: "session-1",
  activeRunId: "run-1",
  assistantItem: createAssistantItem(),
  localMessages: [],
  turnInput: content,
});

const createReservation = (): ChatRunStartReservation => ({
  sessionId: "session-1",
  activeRunId: "run-1",
  reservationId: Symbol("session-1"),
});

const createDependencies = (
  overrides: Partial<Parameters<typeof postFreshChatSessionRouteWithDeps>[1]>,
): Parameters<typeof postFreshChatSessionRouteWithDeps>[1] => ({
  getLocaleFromRequest: overrides.getLocaleFromRequest
    ?? (() => "en" as SupportedLocale),
  reserveChatRunStart: overrides.reserveChatRunStart
    ?? (() => ({
      kind: "reserved",
      reservation: createReservation(),
    })),
  releaseChatRunStartReservation: overrides.releaseChatRunStartReservation
    ?? (() => undefined),
  prepareFreshChatRun: overrides.prepareFreshChatRun
    ?? (async (_userId, _workspaceId, content) => createPreparedRun(content)),
  persistAssistantTerminalError: overrides.persistAssistantTerminalError
    ?? (async () => undefined),
  startPersistedChatRun: overrides.startPersistedChatRun
    ?? (() => (async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "done" };
    })()),
  isServerDraining: overrides.isServerDraining ?? (() => false),
  log: overrides.log ?? (() => undefined),
});

const withOpenAiApiKey = async (
  run: () => Promise<void>,
): Promise<void> => {
  const previousValue = process.env[OPENAI_API_KEY_ENV];
  process.env[OPENAI_API_KEY_ENV] = "test-key";
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

const withSuppressedConsoleLog = async (
  run: () => Promise<void>,
): Promise<void> => {
  const originalLog = console.log;
  console.log = (): void => undefined;
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
};

test("POST /api/chat/new starts one prepared session and identifies it in the first stream event", async (): Promise<void> => {
  await withOpenAiApiKey(async (): Promise<void> => {
    const content: ReadonlyArray<ContentPart> = [{ type: "text", text: "Hello" }];
    let prepareCallCount = 0;
    let startedSessionId: string | null = null;

    const response = await postFreshChatSessionRouteWithDeps(
      createRequest({
        content,
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createDependencies({
        prepareFreshChatRun: async (userId, workspaceId, preparedContent) => {
          prepareCallCount += 1;
          assert.equal(userId, "user-1");
          assert.equal(workspaceId, "workspace-1");
          assert.deepEqual(preparedContent, content);
          return createPreparedRun(preparedContent);
        },
        startPersistedChatRun: (params) => {
          startedSessionId = params.sessionId;
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("X-Chat-Session-Id"), "session-1");
    assert.equal(prepareCallCount, 1);
    assert.equal(startedSessionId, "session-1");
    assert.equal(
      await response.text(),
      [
        "data: {\"type\":\"session\",\"sessionId\":\"session-1\"}",
        "",
        "data: {\"type\":\"done\"}",
        "",
        "",
      ].join("\n"),
    );
  });
});

test("prependSessionEvent closes an unconsumed runtime iterator after the session event", async (): Promise<void> => {
  let runtimeIteratorClosed = false;
  const runtimeEvents = (async function* (): AsyncGenerator<ChatStreamEvent> {
    yield { type: "done" };
  })();
  const returnRuntimeEvents = runtimeEvents.return.bind(runtimeEvents);
  runtimeEvents.return = async (value): Promise<IteratorResult<ChatStreamEvent>> => {
    runtimeIteratorClosed = true;
    return returnRuntimeEvents(value);
  };
  const events = prependSessionEvent("session-1", runtimeEvents);

  assert.deepEqual(await events.next(), {
    done: false,
    value: { type: "session", sessionId: "session-1" },
  });

  await events.return(undefined);

  assert.equal(runtimeIteratorClosed, true);
});

test("POST /api/chat/new validation failures do not prepare or start a session", async (): Promise<void> => {
  await withOpenAiApiKey(async (): Promise<void> => {
    let prepareCallCount = 0;
    let runtimeStartCallCount = 0;
    const response = await postFreshChatSessionRouteWithDeps(
      createRequest({
        content: [],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createDependencies({
        prepareFreshChatRun: async (_userId, _workspaceId, content) => {
          prepareCallCount += 1;
          return createPreparedRun(content);
        },
        startPersistedChatRun: () => {
          runtimeStartCallCount += 1;
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "content array is empty");
    assert.equal(prepareCallCount, 0);
    assert.equal(runtimeStartCallCount, 0);
  });
});

test("POST /api/chat/new rejects existing-session identifiers before persistence", async (): Promise<void> => {
  await withOpenAiApiKey(async (): Promise<void> => {
    let prepareCallCount = 0;
    const response = await postFreshChatSessionRouteWithDeps(
      createRequest({
        sessionId: "session-existing",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createDependencies({
        prepareFreshChatRun: async (_userId, _workspaceId, content) => {
          prepareCallCount += 1;
          return createPreparedRun(content);
        },
      }),
    );

    assert.equal(response.status, 400);
    assert.equal(
      await response.text(),
      "sessionId is not supported for fresh chat requests",
    );
    assert.equal(prepareCallCount, 0);
  });
});

test("POST /api/chat/new transaction failures do not start a runtime or persist a terminal update", async (): Promise<void> => {
  await withOpenAiApiKey(async (): Promise<void> => {
    await withSuppressedConsoleLog(async (): Promise<void> => {
      let runtimeStartCallCount = 0;
      let terminalPersistCallCount = 0;
      const response = await postFreshChatSessionRouteWithDeps(
        createRequest({
          content: [{ type: "text", text: "Hello" }],
          model: CHAT_MODEL_ID,
          timezone: "Europe/Madrid",
        }),
        createDependencies({
          prepareFreshChatRun: async (): Promise<PreparedChatRun> => {
            throw new Error("transaction rolled back");
          },
          startPersistedChatRun: () => {
            runtimeStartCallCount += 1;
            return (async function* (): AsyncGenerator<ChatStreamEvent> {
              yield { type: "done" };
            })();
          },
          persistAssistantTerminalError: async () => {
            terminalPersistCallCount += 1;
          },
        }),
      );

      assert.equal(response.status, 500);
      assert.equal(await response.text(), "Fresh chat start failed");
      assert.equal(runtimeStartCallCount, 0);
      assert.equal(terminalPersistCallCount, 0);
    });
  });
});

test("POST /api/chat/new returns session then safe error after persisting a runtime-start failure", async (): Promise<void> => {
  await withOpenAiApiKey(async (): Promise<void> => {
    await withSuppressedConsoleLog(async (): Promise<void> => {
      const reservation = createReservation();
      let releasedReservation: ChatRunStartReservation | null = null;
      const terminalParams: Array<Readonly<{
        sessionId: string;
        activeRunId: string;
        assistantItemId: string;
        errorMessage: string;
        sessionState: string;
      }>> = [];
      const response = await postFreshChatSessionRouteWithDeps(
        createRequest({
          content: [{ type: "text", text: "Hello" }],
          model: CHAT_MODEL_ID,
          timezone: "Europe/Madrid",
        }),
        createDependencies({
          reserveChatRunStart: () => ({
            kind: "reserved",
            reservation,
          }),
          releaseChatRunStartReservation: (released) => {
            releasedReservation = released;
          },
          startPersistedChatRun: () => {
            throw new Error("runtime registry failed");
          },
          persistAssistantTerminalError: async (_userId, _workspaceId, params) => {
            terminalParams.push(params);
          },
        }),
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), "text/event-stream");
      assert.equal(response.headers.get("X-Chat-Session-Id"), "session-1");
      assert.equal(
        await response.text(),
        [
          "data: {\"type\":\"session\",\"sessionId\":\"session-1\"}",
          "",
          `data: ${JSON.stringify({ type: "error", message: CHAT_STREAM_INTERRUPTED_ERROR })}`,
          "",
          "",
        ].join("\n"),
      );
      assert.equal(releasedReservation, reservation);
      assert.equal(terminalParams[0]?.sessionId, "session-1");
      assert.equal(terminalParams[0]?.activeRunId, "run-1");
      assert.equal(terminalParams[0]?.assistantItemId, "assistant-1");
      assert.equal(terminalParams[0]?.sessionState, "interrupted");
      assert.equal(terminalParams[0]?.errorMessage, CHAT_STREAM_INTERRUPTED_ERROR);
    });
  });
});

test("POST /api/chat/new preserves safe session identity when runtime start and failure persistence both fail", async (): Promise<void> => {
  await withOpenAiApiKey(async (): Promise<void> => {
    const loggedEvents: Array<unknown> = [];
    const response = await postFreshChatSessionRouteWithDeps(
      createRequest({
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createDependencies({
        startPersistedChatRun: () => {
          throw new Error("internal runtime registry details");
        },
        persistAssistantTerminalError: async () => {
          throw new Error("internal database persistence details");
        },
        log: (event) => {
          loggedEvents.push(event);
        },
      }),
    );

    const responseBody = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("X-Chat-Session-Id"), "session-1");
    assert.equal(
      responseBody,
      [
        "data: {\"type\":\"session\",\"sessionId\":\"session-1\"}",
        "",
        `data: ${JSON.stringify({ type: "error", message: CHAT_STREAM_INTERRUPTED_ERROR })}`,
        "",
        "",
      ].join("\n"),
    );
    assert.equal(responseBody.includes("internal runtime registry details"), false);
    assert.equal(responseBody.includes("internal database persistence details"), false);
    assert.equal(loggedEvents.length, 2);
    assert.match(JSON.stringify(loggedEvents[0]), /internal runtime registry details/);
    assert.match(JSON.stringify(loggedEvents[1]), /internal database persistence details/);
  });
});
