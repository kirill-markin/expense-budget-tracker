import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import type { StoredOpenAIReplayItem } from "@/server/chat/openai/replayItems";
import type { QueryFn } from "@/server/db/contextRunner";
import type { PersistedChatMessageItem } from "./store";
import {
  buildUserStoppedAssistantContent,
  buildUserStoppedChatRunUpdatePlan,
  cancelActiveChatRunByUserWithQuery,
  STOPPED_BY_USER_TOOL_OUTPUT,
} from "./store";

const createAssistantMessage = (
  params: Readonly<{
    itemId: string;
    state: PersistedChatMessageItem["state"];
    content: PersistedChatMessageItem["content"];
    openaiItems?: PersistedChatMessageItem["openaiItems"];
  }>,
): PersistedChatMessageItem => ({
  itemId: params.itemId,
  sessionId: "session-1",
  role: "assistant",
  content: params.content,
  openaiItems: params.openaiItems,
  state: params.state,
  isError: params.state === "error",
  isStopped: params.state === "cancelled",
  timestamp: 100,
  updatedAt: 100,
});

const createUserMessage = (): PersistedChatMessageItem => ({
  itemId: "user-1",
  sessionId: "session-1",
  role: "user",
  content: [{ type: "text", text: "continue" }],
  state: "completed",
  isError: false,
  isStopped: false,
  timestamp: 90,
  updatedAt: 90,
});

const createQueryResult = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const REPLAY_ITEMS: ReadonlyArray<StoredOpenAIReplayItem> = [{
  id: "msg_123",
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{
    type: "output_text",
    text: "Stored answer",
    annotations: [],
  }],
}];

test("buildUserStoppedAssistantContent finalizes started tool calls with a user-stopped output", () => {
  assert.deepEqual(
    buildUserStoppedAssistantContent([{
      type: "tool_call",
      id: "call-1",
      name: "query_database",
      status: "started",
      providerStatus: "running",
      input: "{\"sql\":\"SELECT 1\"}",
      output: null,
      streamPosition: {
        itemId: "tool-item-1",
        outputIndex: 0,
        contentIndex: null,
        sequenceNumber: 1,
      },
    }]),
    [{
      type: "tool_call",
      id: "call-1",
      name: "query_database",
      status: "completed",
      providerStatus: "incomplete",
      input: "{\"sql\":\"SELECT 1\"}",
      output: STOPPED_BY_USER_TOOL_OUTPUT,
      streamPosition: {
        itemId: "tool-item-1",
        outputIndex: 0,
        contentIndex: null,
        sequenceNumber: 1,
      },
    }],
  );
});

test("buildUserStoppedChatRunUpdatePlan keeps the current assistant visible and marks the run idle", () => {
  const plan = buildUserStoppedChatRunUpdatePlan([
    createUserMessage(),
    createAssistantMessage({
      itemId: "assistant-1",
      state: "in_progress",
      openaiItems: REPLAY_ITEMS,
      content: [{
        type: "tool_call",
        id: "call-1",
        name: "query_database",
        status: "started",
        providerStatus: "running",
        input: "{\"sql\":\"SELECT 1\"}",
        output: null,
        streamPosition: {
          itemId: "tool-item-1",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      }],
    }),
  ]);

  assert.equal(plan.sessionState, "idle");
  assert.equal(plan.assistantItem?.itemId, "assistant-1");
  assert.deepEqual(plan.assistantOpenAIItems, REPLAY_ITEMS);
  assert.deepEqual(plan.assistantContent, [{
    type: "tool_call",
    id: "call-1",
    name: "query_database",
    status: "completed",
    providerStatus: "incomplete",
    input: "{\"sql\":\"SELECT 1\"}",
    output: STOPPED_BY_USER_TOOL_OUTPUT,
    streamPosition: {
      itemId: "tool-item-1",
      outputIndex: 0,
      contentIndex: null,
      sequenceNumber: 1,
    },
  }]);
});

test("cancelActiveChatRunByUserWithQuery cancels a running session and finalizes pending tool calls", async () => {
  const updatedItems: Array<Readonly<Record<string, unknown>>> = [];
  const updatedSessions: Array<Readonly<Record<string, unknown>>> = [];

  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    if (text.includes("WHERE user_id = $1") && text.includes("session_id = $3")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_heartbeat_at: "2026-03-24T10:00:00.000Z",
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("WHERE session_id = $1") && text.includes("FOR UPDATE")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_heartbeat_at: "2026-03-24T10:00:00.000Z",
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("FROM public.chat_items") && text.includes("ORDER BY item_order ASC")) {
      return createQueryResult([{
        item_id: "assistant-1",
        session_id: "session-1",
        state: "in_progress",
        payload: {
          role: "assistant",
          openaiItems: REPLAY_ITEMS,
          content: [{
            type: "tool_call",
            id: "call-1",
            name: "query_database",
            status: "started",
            providerStatus: "in_progress",
            input: "{\"sql\":\"SELECT 1\"}",
            output: null,
            streamPosition: {
              itemId: "tool-item-1",
              outputIndex: 0,
              contentIndex: null,
              sequenceNumber: 1,
            },
          }],
        },
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("UPDATE public.chat_items")) {
      updatedItems.push({
        itemId: String(params[0]),
        payload: JSON.parse(String(params[1])),
        state: String(params[2]),
      });
      return createQueryResult([{
        item_id: "assistant-1",
        session_id: "session-1",
        state: "cancelled",
        payload: JSON.parse(String(params[1])),
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("UPDATE public.chat_sessions")) {
      updatedSessions.push({
        sessionId: String(params[0]),
        status: String(params[1]),
        heartbeatAt: params[2],
      });
      return createQueryResult([{
        session_id: "session-1",
        status: "idle",
        active_run_heartbeat_at: null,
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  const cancelled = await cancelActiveChatRunByUserWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
  );

  assert.equal(cancelled, true);
  assert.deepEqual(updatedItems, [{
    itemId: "assistant-1",
    payload: {
      role: "assistant",
      openaiItems: REPLAY_ITEMS,
      content: [{
        type: "tool_call",
        id: "call-1",
        name: "query_database",
        status: "completed",
        providerStatus: "incomplete",
        input: "{\"sql\":\"SELECT 1\"}",
        output: STOPPED_BY_USER_TOOL_OUTPUT,
        streamPosition: {
          itemId: "tool-item-1",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      }],
    },
    state: "cancelled",
  }]);
  assert.deepEqual(updatedSessions, [{
    sessionId: "session-1",
    status: "idle",
    heartbeatAt: null,
  }]);
});
