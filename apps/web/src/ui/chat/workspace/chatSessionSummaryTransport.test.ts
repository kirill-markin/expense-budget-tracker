import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeChatSessionSummaries,
  parseChatSessionSummaryPage,
  readChatSessionSummaryPageResponse,
  type ChatSessionSummary,
} from "./chatSessionSummaryTransport";

const VALID_SERVER_CURSOR =
  "eyJsYXN0TWVzc2FnZUF0IjoiMjAyNi0wNy0yNlQxNjo0MjowMC4wMDAxMjNaIiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIn0";

const createSummary = (
  overrides: Readonly<Partial<ChatSessionSummary>>,
): ChatSessionSummary => ({
  sessionId: "session-1",
  title: "First chat",
  lastMessageAt: "2026-07-26T12:00:00.000Z",
  status: "idle",
  mainContentInvalidationVersion: 0,
  ...overrides,
});

test("parseChatSessionSummaryPage validates and returns the catalog contract", (): void => {
  const page = parseChatSessionSummaryPage({
    sessions: [
      {
        ...createSummary({ status: "running" }),
        unrelatedServerField: "ignored",
      },
    ],
    nextCursor: VALID_SERVER_CURSOR,
    unrelatedEnvelopeField: true,
  });

  assert.deepEqual(page, {
    sessions: [createSummary({ status: "running" })],
    nextCursor: VALID_SERVER_CURSOR,
  });
  assert.deepEqual(
    parseChatSessionSummaryPage({ sessions: [], nextCursor: null }),
    { sessions: [], nextCursor: null },
  );
});

test("parseChatSessionSummaryPage rejects noncanonical cursor encodings", (): void => {
  const invalidCursors = [
    "A",
    "AB",
    "YQ==",
    "++8",
  ];

  for (const nextCursor of invalidCursors) {
    assert.throws(
      () => parseChatSessionSummaryPage({
        sessions: [],
        nextCursor,
      }),
      /nextCursor must (?:be null or a non-empty base64url string|use canonical base64url encoding)/u,
    );
  }
});

test("parseChatSessionSummaryPage rejects every malformed catalog field", (): void => {
  const validSummary = createSummary({});
  const malformedResponses: ReadonlyArray<Readonly<{
    payload: unknown;
    expectedMessage: RegExp;
  }>> = [
    {
      payload: { sessions: [{ ...validSummary, sessionId: "" }], nextCursor: null },
      expectedMessage: /sessions\[0\]\.sessionId must contain 1-200 characters/u,
    },
    {
      payload: {
        sessions: [{ ...validSummary, lastMessageAt: "2026-07-26T12:00:00Z" }],
        nextCursor: null,
      },
      expectedMessage: /sessions\[0\]\.lastMessageAt must be a canonical UTC timestamp/u,
    },
    {
      payload: { sessions: [{ ...validSummary, status: "queued" }], nextCursor: null },
      expectedMessage: /sessions\[0\]\.status must be idle, running, or interrupted/u,
    },
    {
      payload: {
        sessions: [{ ...validSummary, mainContentInvalidationVersion: -1 }],
        nextCursor: null,
      },
      expectedMessage: /sessions\[0\]\.mainContentInvalidationVersion must be a non-negative safe integer/u,
    },
    {
      payload: { sessions: [validSummary], nextCursor: "not+a+cursor" },
      expectedMessage: /nextCursor must be null or a non-empty base64url string/u,
    },
  ];

  for (const malformedResponse of malformedResponses) {
    assert.throws(
      () => parseChatSessionSummaryPage(malformedResponse.payload),
      malformedResponse.expectedMessage,
    );
  }
});

test("parseChatSessionSummaryPage reports a malformed row instead of discarding it", (): void => {
  assert.throws(
    () => parseChatSessionSummaryPage({
      sessions: [createSummary({ sessionId: "session-1" }), null],
      nextCursor: null,
    }),
    /sessions\[1\] must be an object/u,
  );
});

test("mergeChatSessionSummaries preserves page order and deduplicates by session id", (): void => {
  const current = [
    createSummary({ sessionId: "session-1", title: "First" }),
    createSummary({ sessionId: "session-2", title: "Second" }),
    createSummary({ sessionId: "session-1", title: "First updated" }),
  ];
  const next = [
    createSummary({
      sessionId: "session-2",
      title: "Second updated",
      status: "running",
    }),
    createSummary({ sessionId: "session-3", title: "Third" }),
  ];

  const merged = mergeChatSessionSummaries(current, next);

  assert.deepEqual(
    merged.map((summary) => summary.sessionId),
    ["session-1", "session-2", "session-3"],
  );
  assert.equal(merged[0]?.title, "First updated");
  assert.equal(merged[1]?.title, "Second updated");
  assert.equal(merged[1]?.status, "running");
});

test("readChatSessionSummaryPageResponse exposes HTTP and JSON failures", async (): Promise<void> => {
  await assert.rejects(
    readChatSessionSummaryPageResponse(
      new Response("catalog unavailable", { status: 503 }),
    ),
    /status=503, responseBody=catalog unavailable/u,
  );
  await assert.rejects(
    readChatSessionSummaryPageResponse(
      new Response("not-json", { status: 200 }),
    ),
    /response was not valid JSON.*Response body: not-json/u,
  );
});
