import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_FALLBACK_MODEL_ID, CHAT_MODEL_ID } from "@/lib/chatModels";
import type { SupportedLocale } from "@/lib/locale";
import {
  deleteChatRouteWithDeps,
  getChatRouteWithDeps,
  postChatRouteWithDeps,
} from "@/server/chat/http/routeHandlers";
import { stopChatRouteWithDeps } from "@/app/api/chat/stop/route";
import type { ChatSessionSnapshot, PreparedChatRun } from "@/server/chat/store";
import {
  ChatSessionConflictError,
  ChatSessionNotFoundError,
  ChatTurnCancelledError,
} from "@/server/chat/store";
import { selectChatModelRouting } from "@/server/chat/modelRouting";
import {
  clearActiveChatRunForTests,
  createActiveChatRunForTests,
  markActiveChatRunCancellationPersisted,
  reserveChatRunStart,
  stopActiveChatRun,
  type ChatRunStartReservation,
} from "@/server/chat/runtime/runtime";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";

const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const TURN_ID = "00000000-0000-4000-8000-000000000001";
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
  activeRunId: TURN_ID,
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
  modelRouting: selectChatModelRouting(1, []),
});

const createReservation = (
  sessionId: string,
): ChatRunStartReservation => ({
  sessionId,
  activeRunId: TURN_ID,
  reservationId: Symbol(sessionId),
});

const createChatRequest = (
  body: unknown,
  init?: Readonly<{ headers?: Headers; url?: string; method?: string }>,
): Request =>
  new Request(init?.url ?? "http://localhost/api/chat", {
    method: init?.method ?? "POST",
    headers: init?.headers ?? createHeaders(),
    body: JSON.stringify(
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? { turnId: TURN_ID, ...body }
        : body,
    ),
  });

const createPostDependencies = (
  overrides: Partial<Parameters<typeof postChatRouteWithDeps>[1]> = {},
): Parameters<typeof postChatRouteWithDeps>[1] => ({
  getLocaleFromRequest: overrides.getLocaleFromRequest ?? (() => "en" as SupportedLocale),
  resolveSnapshotWithRunRecovery: overrides.resolveSnapshotWithRunRecovery ?? (async () => createSnapshot()),
  reserveChatRunStart: overrides.reserveChatRunStart ?? ((sessionId) => ({
    kind: "reserved",
    reservation: createReservation(sessionId),
  })),
  releaseChatRunStartReservation: overrides.releaseChatRunStartReservation ?? (() => undefined),
  prepareChatRun: overrides.prepareChatRun ?? (async (
    _userId: string,
    _workspaceId: string,
    sessionId: string | undefined,
    _content: ReadonlyArray<ContentPart>,
    _turnId: string,
  ) => ({
    kind: "started",
    preparedRun: createPreparedRun(sessionId ?? "session-1"),
  })),
  admitChatRunStart: overrides.admitChatRunStart ?? (async () => undefined),
  requireAcceptedChatTurn:
    overrides.requireAcceptedChatTurn ?? (async () => undefined),
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

test("postChatRouteWithDeps logs the rejected timezone value", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const rejectedTimezones: Array<string> = [];
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Etc/Unknown",
      }),
      createPostDependencies({
        log: (event) => {
          if (event.domain === "chat" && event.action === "timezone_rejected") {
            rejectedTimezones.push(event.timezone);
          }
        },
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(rejectedTimezones, ["Etc/Unknown"]);
  });
});

test("postChatRouteWithDeps rejects non-UUID turn identities before persistence", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        turnId: "not-a-uuid",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies(),
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "turnId must be a UUID");
  });
});

test("postChatRouteWithDeps preserves legacy requests without turn identities", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    let reservedTurnId: string | null = null;
    let preparedTurnId: string | null = null;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        turnId: undefined,
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: (sessionId, turnId) => {
          reservedTurnId = turnId;
          return {
            kind: "reserved",
            reservation: {
              sessionId,
              activeRunId: turnId,
              reservationId: Symbol(sessionId),
            },
          };
        },
        prepareChatRun: async (
          _userId,
          _workspaceId,
          sessionId,
          _content,
          turnId,
        ) => {
          preparedTurnId = turnId;
          return {
            kind: "started",
            preparedRun: {
              ...createPreparedRun(sessionId ?? "session-1"),
              activeRunId: turnId,
            },
          };
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.notEqual(reservedTurnId, null);
    assert.equal(preparedTurnId, reservedTurnId);
    assert.match(reservedTurnId ?? "", /^[0-9a-f-]{36}$/u);
  });
});

test("postChatRouteWithDeps canonicalizes mixed-case turn identities across retries", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const uppercaseTurnId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const canonicalTurnId = uppercaseTurnId.toLowerCase();
    let acceptedTurnId: string | null = null;
    let runtimeStartCount = 0;
    const observedTurnIds: Array<string> = [];
    const dependencies = createPostDependencies({
      reserveChatRunStart: (sessionId, turnId) => {
        observedTurnIds.push(turnId);
        if (acceptedTurnId !== null) {
          assert.equal(turnId, acceptedTurnId);
          return { kind: "same_turn_accepted" };
        }
        return {
          kind: "reserved",
          reservation: {
            sessionId,
            activeRunId: turnId,
            reservationId: Symbol(sessionId),
          },
        };
      },
      prepareChatRun: async (
        _userId,
        _workspaceId,
        sessionId,
        _content,
        turnId,
      ) => {
        observedTurnIds.push(turnId);
        acceptedTurnId = turnId;
        return {
          kind: "started",
          preparedRun: {
            ...createPreparedRun(sessionId ?? "session-1"),
            activeRunId: turnId,
          },
        };
      },
      admitChatRunStart: async (
        _userId,
        _workspaceId,
        _sessionId,
        turnId,
      ) => {
        observedTurnIds.push(turnId);
      },
      requireAcceptedChatTurn: async (
        _userId,
        _workspaceId,
        _sessionId,
        turnId,
      ) => {
        observedTurnIds.push(turnId);
        assert.equal(turnId, acceptedTurnId);
      },
      startPersistedChatRun: (params, reservation) => {
        observedTurnIds.push(params.activeRunId, reservation.activeRunId);
        runtimeStartCount += 1;
        return (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: "done" };
        })();
      },
    });
    const requestBody = {
      sessionId: "session-1",
      content: [{ type: "text" as const, text: "Hello" }],
      model: CHAT_MODEL_ID,
      timezone: "Europe/Madrid",
    };

    const firstResponse = await postChatRouteWithDeps(
      createChatRequest({ ...requestBody, turnId: uppercaseTurnId }),
      dependencies,
    );
    const retryResponse = await postChatRouteWithDeps(
      createChatRequest({ ...requestBody, turnId: canonicalTurnId }),
      dependencies,
    );

    assert.equal(firstResponse.status, 200);
    assert.equal(retryResponse.status, 202);
    assert.equal(acceptedTurnId, canonicalTurnId);
    assert.equal(runtimeStartCount, 1);
    assert.deepEqual(
      observedTurnIds,
      Array.from({ length: observedTurnIds.length }, () => canonicalTurnId),
    );
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
          return {
            kind: "reserved",
            reservation: createReservation(sessionId),
          };
        },
        prepareChatRun: async () => {
          prepareCallCount += 1;
          return {
            kind: "started",
            preparedRun: createPreparedRun("session-1"),
          };
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
            return {
              kind: "reserved",
              reservation: createReservation(sessionId),
            };
          },
          prepareChatRun: async () => {
            prepareCallCount += 1;
            return {
              kind: "started",
              preparedRun: createPreparedRun("session-1"),
            };
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

test("postChatRouteWithDeps does not allow the browser to request the fallback model", async (): Promise<void> => {
  const response = await postChatRouteWithDeps(
    createChatRequest({
      sessionId: "session-1",
      content: [{ type: "text", text: "Hello" }],
      model: CHAT_FALLBACK_MODEL_ID,
      timezone: "Europe/Madrid",
    }),
    createPostDependencies(),
  );

  assert.equal(response.status, 400);
  assert.equal(
    await response.text(),
    `Unsupported model: ${CHAT_FALLBACK_MODEL_ID}. Expected ${CHAT_MODEL_ID}`,
  );
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
        reserveChatRunStart: () => ({ kind: "conflict" }),
        prepareChatRun: async () => {
          prepareCalled = true;
          return {
            kind: "started" as const,
            preparedRun: createPreparedRun("session-1"),
          };
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(await response.text(), "Chat session already has an active response");
    assert.equal(prepareCalled, false);
  });
});

test("postChatRouteWithDeps reports same-turn pending as retryable acceptance-unknown", async (): Promise<void> => {
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
        reserveChatRunStart: () => ({ kind: "same_turn_pending" }),
        prepareChatRun: async () => {
          prepareCalled = true;
          return {
            kind: "started" as const,
            preparedRun: createPreparedRun("session-1"),
          };
        },
      }),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("X-Chat-Request-Acceptance"), "unknown");
    assert.equal(prepareCalled, false);
  });
});

test("postChatRouteWithDeps returns accepted for an already-running matching turn", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    let prepareCalled = false;
    let acceptedTurnChecked = false;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => ({ kind: "same_turn_accepted" }),
        prepareChatRun: async () => {
          prepareCalled = true;
          return {
            kind: "started" as const,
            preparedRun: createPreparedRun("session-1"),
          };
        },
        requireAcceptedChatTurn: async (
          userId,
          workspaceId,
          sessionId,
          turnId,
        ) => {
          assert.equal(userId, "user-1");
          assert.equal(workspaceId, "workspace-1");
          assert.equal(sessionId, "session-1");
          assert.equal(turnId, TURN_ID);
          acceptedTurnChecked = true;
        },
      }),
    );

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("X-Chat-Request-Acceptance"), "accepted");
    assert.equal(response.headers.get("X-Chat-Session-Id"), "session-1");
    assert.equal(prepareCalled, false);
    assert.equal(acceptedTurnChecked, true);
  });
});

test("postChatRouteWithDeps rejects a stopped same-turn retry while its local runtime entry remains", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    createActiveChatRunForTests("session-1", TURN_ID);
    try {
      assert.deepEqual(stopActiveChatRun("session-1", TURN_ID), {
        stopped: true,
        activeRunId: TURN_ID,
      });
      markActiveChatRunCancellationPersisted("session-1", TURN_ID);

      const response = await postChatRouteWithDeps(
        createChatRequest({
          sessionId: "session-1",
          content: [{ type: "text", text: "Hello" }],
          model: CHAT_MODEL_ID,
          timezone: "Europe/Madrid",
        }),
        createPostDependencies({
          reserveChatRunStart,
          requireAcceptedChatTurn: async (
            _userId,
            _workspaceId,
            sessionId,
            turnId,
          ) => {
            throw new ChatTurnCancelledError(sessionId, turnId);
          },
        }),
      );

      assert.equal(response.status, 409);
      assert.match(await response.text(), /Chat turn was cancelled/u);
    } finally {
      clearActiveChatRunForTests("session-1");
    }
  });
});

test("postChatRouteWithDeps suppresses a cross-instance duplicate after atomic persistence", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const reservation = createReservation("session-1");
    let releasedReservation: ChatRunStartReservation | null = null;
    let runtimeStartCount = 0;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Hello" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => ({
          kind: "reserved",
          reservation,
        }),
        releaseChatRunStartReservation: (released) => {
          releasedReservation = released;
        },
        prepareChatRun: async () => ({
          kind: "already_accepted",
          sessionId: "session-1",
        }),
        startPersistedChatRun: () => {
          runtimeStartCount += 1;
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("X-Chat-Request-Acceptance"), "accepted");
    assert.equal(releasedReservation, reservation);
    assert.equal(runtimeStartCount, 0);
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
        reserveChatRunStart: () => ({
          kind: "reserved",
          reservation,
        }),
        releaseChatRunStartReservation: (released) => {
          releasedReservation = released;
        },
        prepareChatRun: async () => {
          throw new ChatSessionConflictError("session-1");
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(await response.text(), "Chat session already has an active response");
    assert.equal(releasedReservation, reservation);
  });
});

test("postChatRouteWithDeps definitively rejects a tombstoned turn before runtime execution", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const reservation = createReservation("session-1");
    let releasedReservation: ChatRunStartReservation | null = null;
    let runtimeStartCount = 0;
    const response = await postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Cancelled request" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => ({
          kind: "reserved",
          reservation,
        }),
        releaseChatRunStartReservation: (released) => {
          releasedReservation = released;
        },
        prepareChatRun: async () => {
          throw new ChatTurnCancelledError("session-1", TURN_ID);
        },
        startPersistedChatRun: () => {
          runtimeStartCount += 1;
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.match(await response.text(), /Chat turn was cancelled/u);
    assert.equal(releasedReservation, reservation);
    assert.equal(runtimeStartCount, 0);
  });
});

test("postChatRouteWithDeps does not start runtime when remote Stop wins after prepare commits", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const prepareCommitted = Promise.withResolvers<void>();
    const releasePreparedRun = Promise.withResolvers<void>();
    const reservation = createReservation("session-1");
    let remoteStopCommitted = false;
    let releasedReservation: ChatRunStartReservation | null = null;
    let runtimeStartCount = 0;
    const responsePromise = postChatRouteWithDeps(
      createChatRequest({
        sessionId: "session-1",
        content: [{ type: "text", text: "Cancelled request" }],
        model: CHAT_MODEL_ID,
        timezone: "Europe/Madrid",
      }),
      createPostDependencies({
        reserveChatRunStart: () => ({
          kind: "reserved",
          reservation,
        }),
        releaseChatRunStartReservation: (released) => {
          releasedReservation = released;
        },
        prepareChatRun: async () => {
          prepareCommitted.resolve();
          await releasePreparedRun.promise;
          return {
            kind: "started",
            preparedRun: createPreparedRun("session-1"),
          };
        },
        admitChatRunStart: async (
          _userId,
          _workspaceId,
          sessionId,
          turnId,
        ) => {
          assert.equal(remoteStopCommitted, true);
          throw new ChatTurnCancelledError(sessionId, turnId);
        },
        startPersistedChatRun: () => {
          runtimeStartCount += 1;
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "done" };
          })();
        },
      }),
    );

    await prepareCommitted.promise;
    remoteStopCommitted = true;
    releasePreparedRun.resolve();
    const response = await responsePromise;

    assert.equal(response.status, 409);
    assert.match(await response.text(), /Chat turn was cancelled/u);
    assert.equal(releasedReservation, reservation);
    assert.equal(runtimeStartCount, 0);
  });
});

test("legacy Stop durably tombstones a prepared turn before admission and later retry", async (): Promise<void> => {
  await withOpenAiApiKey("test-key", async (): Promise<void> => {
    const prepareCommitted = Promise.withResolvers<void>();
    const releasePreparedRun = Promise.withResolvers<void>();
    let prepareCallCount = 0;
    let tombstoned = false;
    let runtimeStartCount = 0;
    const postDependencies = createPostDependencies({
      reserveChatRunStart: (sessionId, turnId) => ({
        kind: "reserved",
        reservation: {
          sessionId,
          activeRunId: turnId,
          reservationId: Symbol(sessionId),
        },
      }),
      prepareChatRun: async (
        _userId,
        _workspaceId,
        sessionId,
        _content,
        turnId,
      ) => {
        prepareCallCount += 1;
        if (prepareCallCount === 1) {
          prepareCommitted.resolve();
          await releasePreparedRun.promise;
        }
        if (tombstoned) {
          throw new ChatTurnCancelledError(sessionId ?? "session-1", turnId);
        }
        return {
          kind: "started",
          preparedRun: {
            ...createPreparedRun(sessionId ?? "session-1"),
            activeRunId: turnId,
          },
        };
      },
      admitChatRunStart: async (
        _userId,
        _workspaceId,
        sessionId,
        turnId,
      ) => {
        if (tombstoned) {
          throw new ChatTurnCancelledError(sessionId, turnId);
        }
      },
      startPersistedChatRun: () => {
        runtimeStartCount += 1;
        return (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: "done" };
        })();
      },
    });
    const requestBody = {
      sessionId: "session-1",
      content: [{ type: "text" as const, text: "Hello" }],
      model: CHAT_MODEL_ID,
      timezone: "Europe/Madrid",
    };
    const firstResponsePromise = postChatRouteWithDeps(
      createChatRequest(requestBody),
      postDependencies,
    );

    await prepareCommitted.promise;
    const stopResponse = await stopChatRouteWithDeps(
      new Request("http://localhost/api/chat/stop", {
        method: "POST",
        headers: createHeaders(),
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
      {
        getChatSessionSnapshot: async () => createSnapshot({
          runState: "running",
          activeRunId: TURN_ID,
          activeRunHeartbeatAt: 100,
        }),
        cancelChatTurnByUser: async (
          _userId,
          _workspaceId,
          _sessionId,
          turnId,
        ) => {
          assert.equal(turnId, TURN_ID);
          tombstoned = true;
          return "active_run_cancelled";
        },
        stopActiveChatRun: () => ({ stopped: false }),
        markActiveChatRunCancellationPersisted: () => undefined,
        hasActiveChatSessionRun: () => false,
        log: () => undefined,
      },
    );
    assert.equal(stopResponse.status, 200);
    assert.deepEqual(await stopResponse.json(), {
      ok: true,
      sessionId: "session-1",
      stopped: true,
      stillRunning: false,
    });

    releasePreparedRun.resolve();
    const firstResponse = await firstResponsePromise;
    const retryResponse = await postChatRouteWithDeps(
      createChatRequest(requestBody),
      postDependencies,
    );

    assert.equal(firstResponse.status, 409);
    assert.match(await firstResponse.text(), /Chat turn was cancelled/u);
    assert.equal(retryResponse.status, 409);
    assert.match(await retryResponse.text(), /Chat turn was cancelled/u);
    assert.equal(runtimeStartCount, 0);
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
        reserveChatRunStart: () => ({
          kind: "reserved",
          reservation,
        }),
        releaseChatRunStartReservation: () => {
          released = true;
        },
        prepareChatRun: async () => ({
          kind: "started",
          preparedRun: createPreparedRun("session-1"),
        }),
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
      activeRunId: TURN_ID,
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

test("getChatRouteWithDeps exposes exact active turn identity without internal heartbeat fields", async (): Promise<void> => {
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
    activeTurnId: "run-1",
    updatedAt: 100,
    mainContentInvalidationVersion: 0,
    messages: [{
      messageId: "assistant-1",
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
