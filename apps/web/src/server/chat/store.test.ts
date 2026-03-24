import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import type { QueryFn } from "@/server/db/contextRunner";
import type { PersistedChatMessageItem } from "./store";
import {
  buildRecoveredChatConversationUpdatePlan,
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
  }>,
): PersistedChatMessageItem => ({
  itemId: params.itemId,
  sessionId: "session-1",
  role: "assistant",
  content: params.content,
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

test("buildRecoveredChatConversationUpdatePlan patches matching tool calls and appends a note message", () => {
  const result = buildRecoveredChatConversationUpdatePlan(
    [
      createUserMessage(),
      createAssistantMessage({
        itemId: "assistant-1",
        state: "cancelled",
        content: [{
          type: "tool_call",
          id: "call-1",
          name: "query_database",
          status: "completed",
          providerStatus: "incomplete",
          input: "{\"sql\":\"UPDATE ledger_entries SET amount = 1\"}",
          output: null,
          streamPosition: {
            itemId: "tool-item-1",
            outputIndex: 0,
            contentIndex: null,
            sequenceNumber: 1,
          },
        }],
      }),
    ],
    "recovery-1",
    ["call-1"],
    "Recovered the interrupted database step.",
    "database tool output lost",
  );

  assert.equal(result.messageUpdates.length, 1);
  assert.deepEqual(result.messageUpdates[0], {
    itemId: "assistant-1",
    state: "cancelled",
    content: [{
      type: "tool_call",
      id: "call-1",
      name: "query_database",
      status: "completed",
      providerStatus: "completed",
      input: "{\"sql\":\"UPDATE ledger_entries SET amount = 1\"}",
      output: "database tool output lost",
      streamPosition: {
        itemId: "tool-item-1",
        outputIndex: 0,
        contentIndex: null,
        sequenceNumber: 1,
      },
    }],
  });
  assert.deepEqual(result.noteContent, [{
    type: "text",
    text: "Recovered the interrupted database step.",
    streamPosition: {
      itemId: "recovery-note-recovery-1",
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: 0,
    },
  }]);
});

test("buildRecoveredChatConversationUpdatePlan inserts synthetic tool calls when no local tool call exists", () => {
  const result = buildRecoveredChatConversationUpdatePlan(
    [createUserMessage()],
    "recovery-2",
    ["call-missing"],
    "Recovered the interrupted database step.",
    "database tool output lost",
  );

  assert.deepEqual(result.messageUpdates, []);
  assert.deepEqual(result.noteContent, [
    {
      type: "text",
      text: "Recovered the interrupted database step.",
      streamPosition: {
        itemId: "recovery-note-recovery-2",
        outputIndex: 0,
        contentIndex: 0,
        sequenceNumber: 0,
      },
    },
    {
      type: "tool_call",
      id: "call-missing",
      name: "query_database",
      status: "completed",
      providerStatus: "completed",
      input: null,
      output: "database tool output lost",
      streamPosition: {
        itemId: "recovery-tool-recovery-2-call-missing",
        outputIndex: 1,
        contentIndex: null,
        sequenceNumber: 1,
      },
    },
  ]);
});

test("buildRecoveredChatConversationUpdatePlan matches multiple call IDs across assistant messages from newest to oldest", () => {
  const result = buildRecoveredChatConversationUpdatePlan(
    [
      createAssistantMessage({
        itemId: "assistant-old",
        state: "completed",
        content: [{
          type: "tool_call",
          id: "call-1",
          name: "query_database",
          status: "completed",
          providerStatus: "incomplete",
          input: null,
          output: null,
          streamPosition: {
            itemId: "tool-old",
            outputIndex: 0,
            contentIndex: null,
            sequenceNumber: 1,
          },
        }],
      }),
      createAssistantMessage({
        itemId: "assistant-new",
        state: "error",
        content: [{
          type: "tool_call",
          id: "call-2",
          name: "query_database",
          status: "completed",
          providerStatus: "incomplete",
          input: null,
          output: null,
          streamPosition: {
            itemId: "tool-new",
            outputIndex: 0,
            contentIndex: null,
            sequenceNumber: 2,
          },
        }],
      }),
    ],
    "recovery-3",
    ["call-1", "call-2"],
    "Recovered the interrupted database step.",
    "database tool output lost",
  );

  assert.deepEqual(result.messageUpdates, [
    {
      itemId: "assistant-new",
      state: "error",
      content: [{
        type: "tool_call",
        id: "call-2",
        name: "query_database",
        status: "completed",
        providerStatus: "completed",
        input: null,
        output: "database tool output lost",
        streamPosition: {
          itemId: "tool-new",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 2,
        },
      }],
    },
    {
      itemId: "assistant-old",
      state: "completed",
      content: [{
        type: "tool_call",
        id: "call-1",
        name: "query_database",
        status: "completed",
        providerStatus: "completed",
        input: null,
        output: "database tool output lost",
        streamPosition: {
          itemId: "tool-old",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      }],
    },
  ]);
  assert.equal(result.noteContent?.length, 1);
});

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
      content: [{
        type: "tool_call",
        id: "call-1",
        name: "code_interpreter_call",
        status: "started",
        providerStatus: "interpreting",
        input: "print('hello')",
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
  assert.deepEqual(plan.assistantContent, [{
    type: "tool_call",
    id: "call-1",
    name: "code_interpreter_call",
    status: "completed",
    providerStatus: "incomplete",
    input: "print('hello')",
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
        openai_conversation_id: "conv-1",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("WHERE session_id = $1") && text.includes("FOR UPDATE")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_heartbeat_at: "2026-03-24T10:00:00.000Z",
        openai_conversation_id: "conv-1",
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
        openai_conversation_id: "conv-1",
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
