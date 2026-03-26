import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import type { StoredOpenAIReplayItem } from "@/server/chat/openai/replayItems";
import {
  buildUserStoppedAssistantContent,
  buildUserStoppedChatRunUpdatePlan,
  markChatSessionInterruptedWithQuery,
  persistAssistantTerminalErrorWithQuery,
  prepareChatRunWithQuery,
} from "./lifecycleStore";
import {
  ChatSessionConflictError,
  STOPPED_BY_USER_TOOL_OUTPUT,
} from "./shared";

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
  const plan = buildUserStoppedChatRunUpdatePlan([{
    itemId: "assistant-1",
    sessionId: "session-1",
    role: "assistant",
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
    openaiItems: REPLAY_ITEMS,
    state: "in_progress",
    isError: false,
    isStopped: false,
    timestamp: 100,
    updatedAt: 100,
  }]);

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

test("prepareChatRun creates assistant placeholder after persisting the new user turn", async () => {
  const writes: Array<Readonly<Record<string, unknown>>> = [];

  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    if (text.includes("ORDER BY created_at DESC") && text.includes("LIMIT 1")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "idle",
        active_run_heartbeat_at: null,
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("FOR UPDATE")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "idle",
        active_run_heartbeat_at: null,
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("INSERT INTO public.chat_items")) {
      writes.push({
        sessionId: String(params[0]),
        state: String(params[1]),
        payload: JSON.parse(String(params[2])),
      });

      const payload = JSON.parse(String(params[2])) as Readonly<Record<string, unknown>>;
      const role = String(payload.role);
      return createQueryResult([{
        item_id: role === "assistant" ? "assistant-1" : "user-1",
        session_id: "session-1",
        state: String(params[1]),
        payload,
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("FROM public.chat_items") && text.includes("ORDER BY item_order ASC")) {
      return createQueryResult([{
        item_id: "user-1",
        session_id: "session-1",
        state: "completed",
        payload: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("UPDATE public.chat_sessions")) {
      writes.push({
        sessionId: String(params[0]),
        status: String(params[1]),
      });
      return createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_heartbeat_at: String(params[2]),
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  const run = await prepareChatRunWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    undefined,
    [{ type: "text", text: "hello" }],
  );

  assert.equal(run.sessionId, "session-1");
  assert.equal(run.assistantItem.itemId, "assistant-1");
  assert.deepEqual(run.localMessages, [{
    role: "user",
    content: [{ type: "text", text: "hello" }],
  }]);
  assert.deepEqual(writes, [{
    sessionId: "session-1",
    state: "completed",
    payload: {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  }, {
    sessionId: "session-1",
    state: "in_progress",
    payload: {
      role: "assistant",
      content: [],
    },
  }, {
    sessionId: "session-1",
    status: "running",
  }]);
});

test("prepareChatRun throws ChatSessionConflictError when the locked session is already running", async () => {
  const queryFn = async (text: string): Promise<QueryResult> => {
    if (text.includes("ORDER BY created_at DESC") && text.includes("LIMIT 1")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "idle",
        active_run_heartbeat_at: null,
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    if (text.includes("FOR UPDATE")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_heartbeat_at: "2026-03-24T10:00:00.000Z",
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:00.000Z",
      }]);
    }

    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  await assert.rejects(
    () => prepareChatRunWithQuery(queryFn, "user-1", "workspace-1", undefined, [{ type: "text", text: "hello" }]),
    (error: unknown) =>
      error instanceof ChatSessionConflictError
      && error.message === "Chat session already has an active run: session-1",
  );
});

test("persistAssistantTerminalError replaces an empty assistant draft with the error message", async () => {
  const updatedItems: Array<Readonly<Record<string, unknown>>> = [];
  const insertedItems: Array<Readonly<Record<string, unknown>>> = [];
  const updatedSessions: Array<Readonly<Record<string, unknown>>> = [];

  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    if (text.includes("UPDATE public.chat_items")) {
      updatedItems.push({
        itemId: String(params[0]),
        payload: JSON.parse(String(params[1])),
        state: String(params[2]),
      });
      return createQueryResult([{
        item_id: "assistant-1",
        session_id: "session-1",
        state: String(params[2]),
        payload: JSON.parse(String(params[1])),
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("INSERT INTO public.chat_items")) {
      insertedItems.push({
        sessionId: String(params[0]),
        state: String(params[1]),
        payload: JSON.parse(String(params[2])),
      });
      return createQueryResult([]);
    }

    if (text.includes("UPDATE public.chat_sessions")) {
      updatedSessions.push({
        sessionId: String(params[0]),
        status: String(params[1]),
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

  await persistAssistantTerminalErrorWithQuery(queryFn, {
    sessionId: "session-1",
    assistantItemId: "assistant-1",
    assistantContent: [],
    errorMessage: "boom",
    sessionState: "idle",
  });

  assert.deepEqual(updatedItems, [{
    itemId: "assistant-1",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: "boom" }],
    },
    state: "error",
  }]);
  assert.deepEqual(insertedItems, []);
  assert.deepEqual(updatedSessions, [{
    sessionId: "session-1",
    status: "idle",
  }]);
});

test("persistAssistantTerminalError finalizes tool calls and appends a separate error item", async () => {
  const updatedItems: Array<Readonly<Record<string, unknown>>> = [];
  const insertedItems: Array<Readonly<Record<string, unknown>>> = [];

  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    if (text.includes("UPDATE public.chat_items")) {
      updatedItems.push({
        itemId: String(params[0]),
        payload: JSON.parse(String(params[1])),
        state: String(params[2]),
      });
      return createQueryResult([{
        item_id: "assistant-1",
        session_id: "session-1",
        state: String(params[2]),
        payload: JSON.parse(String(params[1])),
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("INSERT INTO public.chat_items")) {
      insertedItems.push({
        sessionId: String(params[0]),
        state: String(params[1]),
        payload: JSON.parse(String(params[2])),
      });
      return createQueryResult([{
        item_id: "assistant-2",
        session_id: "session-1",
        state: String(params[1]),
        payload: JSON.parse(String(params[2])),
        created_at: "2026-03-24T10:00:01.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("UPDATE public.chat_sessions")) {
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

  await persistAssistantTerminalErrorWithQuery(queryFn, {
    sessionId: "session-1",
    assistantItemId: "assistant-1",
    assistantContent: [{
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
    errorMessage: "boom",
    sessionState: "idle",
  });

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
        output: "Tool failed before returning output.",
        streamPosition: {
          itemId: "tool-item-1",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      }],
    },
    state: "completed",
  }]);
  assert.deepEqual(insertedItems, [{
    sessionId: "session-1",
    state: "error",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: "boom" }],
    },
  }]);
});

test("markChatSessionInterrupted replaces an empty in-progress assistant with an error item", async () => {
  const updatedItems: Array<Readonly<Record<string, unknown>>> = [];
  const insertedItems: Array<Readonly<Record<string, unknown>>> = [];
  const updatedSessions: Array<Readonly<Record<string, unknown>>> = [];

  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    if (text.includes("WHERE user_id = $1") && text.includes("session_id = $3")) {
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
          content: [],
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
        state: String(params[2]),
        payload: JSON.parse(String(params[1])),
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("INSERT INTO public.chat_items")) {
      insertedItems.push({
        sessionId: String(params[0]),
        state: String(params[1]),
      });
      return createQueryResult([]);
    }

    if (text.includes("UPDATE public.chat_sessions")) {
      updatedSessions.push({
        sessionId: String(params[0]),
        status: String(params[1]),
      });
      return createQueryResult([{
        session_id: "session-1",
        status: "interrupted",
        active_run_heartbeat_at: null,
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  await markChatSessionInterruptedWithQuery(queryFn, "user-1", "workspace-1", "session-1", "stream stopped");

  assert.deepEqual(updatedItems, [{
    itemId: "assistant-1",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: "stream stopped" }],
    },
    state: "error",
  }]);
  assert.deepEqual(insertedItems, []);
  assert.deepEqual(updatedSessions, [{
    sessionId: "session-1",
    status: "interrupted",
  }]);
});

test("markChatSessionInterrupted finalizes tool calls and appends a separate error item", async () => {
  const updatedItems: Array<Readonly<Record<string, unknown>>> = [];
  const insertedItems: Array<Readonly<Record<string, unknown>>> = [];

  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    if (text.includes("WHERE user_id = $1") && text.includes("session_id = $3")) {
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
        state: String(params[2]),
        payload: JSON.parse(String(params[1])),
        created_at: "2026-03-24T10:00:00.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("INSERT INTO public.chat_items")) {
      insertedItems.push({
        sessionId: String(params[0]),
        state: String(params[1]),
        payload: JSON.parse(String(params[2])),
      });
      return createQueryResult([{
        item_id: "assistant-2",
        session_id: "session-1",
        state: String(params[1]),
        payload: JSON.parse(String(params[2])),
        created_at: "2026-03-24T10:00:01.000Z",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    if (text.includes("UPDATE public.chat_sessions")) {
      return createQueryResult([{
        session_id: "session-1",
        status: "interrupted",
        active_run_heartbeat_at: null,
        main_content_invalidation_version: "0",
        updated_at: "2026-03-24T10:00:01.000Z",
      }]);
    }

    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  await markChatSessionInterruptedWithQuery(queryFn, "user-1", "workspace-1", "session-1", "stream stopped");

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
        output: "Interrupted before output was captured.",
        streamPosition: {
          itemId: "tool-item-1",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      }],
    },
    state: "completed",
  }]);
  assert.deepEqual(insertedItems, [{
    sessionId: "session-1",
    state: "error",
    payload: {
      role: "assistant",
      content: [{ type: "text", text: "stream stopped" }],
    },
  }]);
});
