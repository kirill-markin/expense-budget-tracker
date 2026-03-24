import assert from "node:assert/strict";
import test from "node:test";

import type { PersistedChatMessageItem } from "./store";
import { buildRecoveredChatConversationUpdatePlan } from "./store";

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
