import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import {
  countWorkspaceUserMessagesSinceWithQuery,
  insertChatItemWithQuery,
  updateChatItemAndInvalidateMainContentWithQuery,
  updateChatItemWithQuery,
} from "@/server/chat/store/messageStore";
import type { QueryFn } from "@/server/db/contextRunner";

const createQueryResult = (
  role: "user" | "assistant",
  state: "in_progress" | "completed" | "error",
  content: ReadonlyArray<Readonly<{ type: "text"; text: string }>>,
  invalidationVersion: string | undefined,
): QueryResult => ({
  command: "SELECT",
  rowCount: 1,
  oid: 0,
  fields: [],
  rows: [{
    item_id: `${role}-1`,
    session_id: "session-1",
    state,
    payload: { role, content },
    created_at: "2026-05-02T13:00:00.000Z",
    updated_at: "2026-05-02T13:00:00.000Z",
    ...(invalidationVersion === undefined
      ? {}
      : { main_content_invalidation_version: invalidationVersion }),
  }],
});

test("insertChatItemWithQuery records user activity but not an empty assistant placeholder", async (): Promise<void> => {
  const recordedQueries: Array<Readonly<{
    text: string;
    params: ReadonlyArray<unknown>;
  }>> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    const payload = JSON.parse(String(params[3])) as Readonly<{
      role: "user" | "assistant";
      content: ReadonlyArray<Readonly<{ type: "text"; text: string }>>;
    }>;
    return createQueryResult(
      payload.role,
      String(params[2]) as "in_progress" | "completed",
      payload.content,
      undefined,
    );
  };

  await insertChatItemWithQuery(queryFn, {
    itemId: "turn-1",
    sessionId: "session-1",
    role: "user",
    state: "completed",
    content: [{ type: "text", text: "Hello" }],
  });
  await insertChatItemWithQuery(queryFn, {
    itemId: null,
    sessionId: "session-1",
    role: "assistant",
    state: "in_progress",
    content: [],
  });

  assert.match(recordedQueries[0].text, /last_message_at = CASE/);
  assert.equal(recordedQueries[0].params[0], "turn-1");
  assert.equal(recordedQueries[0].params[4], true);
  assert.equal(recordedQueries[1].params[0], null);
  assert.equal(recordedQueries[1].params[4], false);
  assert.equal(recordedQueries.some((query) => query.text.includes("title =")), false);
});

test("countWorkspaceUserMessagesSinceWithQuery includes the supplied rolling-window boundary", async (): Promise<void> => {
  const boundary = new Date("2026-05-01T13:00:00.000Z");
  const recordedQueries: Array<Readonly<{
    text: string;
    params: ReadonlyArray<unknown>;
  }>> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    return {
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ user_message_count: "30" }],
    };
  };

  const count = await countWorkspaceUserMessagesSinceWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    boundary,
  );

  assert.equal(count, 30);
  assert.match(recordedQueries[0]?.text ?? "", /item\.created_at >= \$3::timestamptz/u);
  assert.match(recordedQueries[0]?.text ?? "", /session\.user_id = \$1/u);
  assert.match(recordedQueries[0]?.text ?? "", /session\.workspace_id = \$2/u);
  assert.deepEqual(recordedQueries[0]?.params, ["user-1", "workspace-1", boundary]);
});

test("assistant progress and final updates advance visible session activity", async (): Promise<void> => {
  const activityFlags: Array<unknown> = [];
  const queryFn: QueryFn = async (_text, params): Promise<QueryResult> => {
    activityFlags.push(params[4]);
    const payload = JSON.parse(String(params[2])) as Readonly<{
      content: ReadonlyArray<Readonly<{ type: "text"; text: string }>>;
    }>;
    return createQueryResult(
      "assistant",
      String(params[3]) as "in_progress" | "completed",
      payload.content,
      undefined,
    );
  };

  await updateChatItemWithQuery(queryFn, {
    sessionId: "session-1",
    itemId: "assistant-1",
    content: [{ type: "text", text: "Working" }],
    state: "in_progress",
  });
  await updateChatItemWithQuery(queryFn, {
    sessionId: "session-1",
    itemId: "assistant-1",
    content: [{ type: "text", text: "Done" }],
    state: "completed",
  });

  assert.deepEqual(activityFlags, [true, true]);
});

test("assistant terminal errors and invalidating progress advance visible session activity", async (): Promise<void> => {
  const recordedQueries: Array<Readonly<{
    text: string;
    activityFlag: unknown;
  }>> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, activityFlag: params[4] });
    const payload = JSON.parse(String(params[2])) as Readonly<{
      content: ReadonlyArray<Readonly<{ type: "text"; text: string }>>;
    }>;
    return createQueryResult(
      "assistant",
      String(params[3]) as "in_progress" | "error",
      payload.content,
      text.includes("main_content_invalidation_version")
        ? "1"
        : undefined,
    );
  };

  await updateChatItemWithQuery(queryFn, {
    sessionId: "session-1",
    itemId: "assistant-1",
    content: [],
    state: "error",
  });
  await updateChatItemAndInvalidateMainContentWithQuery(queryFn, {
    sessionId: "session-1",
    itemId: "assistant-1",
    content: [{ type: "text", text: "Updated" }],
    state: "in_progress",
  });

  assert.deepEqual(
    recordedQueries.map((query) => query.activityFlag),
    [true, true],
  );
  assert.match(recordedQueries[0].text, /last_message_at = CASE/);
  assert.match(recordedQueries[1].text, /last_message_at = CASE/);
});

const createStoredAssistantRow = (
  storedReplayMeasurement: unknown,
): QueryResult => ({
  command: "SELECT",
  rowCount: 1,
  oid: 0,
  fields: [],
  rows: [{
    item_id: "assistant-1",
    session_id: "session-1",
    state: "completed",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      ...(storedReplayMeasurement === undefined
        ? {}
        : { replayMeasurement: storedReplayMeasurement }),
    },
    created_at: "2026-05-02T13:00:00.000Z",
    updated_at: "2026-05-02T13:00:00.000Z",
  }],
});

const createStoredAssistantQueryFn = (
  storedReplayMeasurement: unknown,
  persistedPayloads: Array<unknown>,
): QueryFn => async (_text, params): Promise<QueryResult> => {
  persistedPayloads.push(JSON.parse(String(params[2])));
  return createStoredAssistantRow(storedReplayMeasurement);
};

test("a completed assistant turn persists its replay measurement", async (): Promise<void> => {
  const persistedPayloads: Array<unknown> = [];
  const replayMeasurement = { inputTokens: 12_000, outputTokens: 800, replayedMessages: 6 };

  const item = await updateChatItemWithQuery(
    createStoredAssistantQueryFn(replayMeasurement, persistedPayloads),
    {
      sessionId: "session-1",
      itemId: "assistant-1",
      content: [{ type: "text", text: "Done" }],
      state: "completed",
      assistantReplayMeasurement: replayMeasurement,
    },
  );

  assert.deepEqual(persistedPayloads, [{
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    replayMeasurement,
  }]);
  assert.deepEqual(item.replayMeasurement, replayMeasurement);
});

test("an unusable stored replay measurement reads as absent", async (): Promise<void> => {
  // A JSONB row written by an older code path, and one whose counts did not
  // survive serialization: either must leave the turn unmeasured rather than
  // feed a non-number into every later history weight.
  const unusableMeasurements: ReadonlyArray<unknown> = [
    undefined,
    null,
    { inputTokens: 1_000 },
    { inputTokens: null, outputTokens: 200, replayedMessages: 1 },
    { inputTokens: 1_000.5, outputTokens: 200, replayedMessages: 1 },
    { inputTokens: "1000", outputTokens: 200, replayedMessages: 1 },
    { inputTokens: -1, outputTokens: 200, replayedMessages: 1 },
  ];

  for (const storedReplayMeasurement of unusableMeasurements) {
    const item = await updateChatItemWithQuery(
      createStoredAssistantQueryFn(storedReplayMeasurement, []),
      {
        sessionId: "session-1",
        itemId: "assistant-1",
        content: [{ type: "text", text: "Done" }],
        state: "completed",
      },
    );

    assert.equal(item.replayMeasurement, undefined);
  }
});
