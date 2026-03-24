import assert from "node:assert/strict";
import test from "node:test";

import type { StoredMessage } from "@/lib/chatHistory";
import { getOrderedMessageBlocks } from "./messageContentOrder";

test("getOrderedMessageBlocks inserts attachments immediately before the first text block", () => {
  const message: StoredMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: "tool-1",
        name: "query_database",
        status: "completed",
        providerStatus: "completed",
        input: "{\"sql\":\"SELECT 1\"}",
        output: "{\"rows\":[{\"value\":1}]}",
        streamPosition: {
          itemId: "tool-1",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      },
      { type: "file", mediaType: "text/csv", base64Data: "abc", fileName: "report.csv" },
      { type: "image", mediaType: "image/png", base64Data: "def" },
      { type: "text", text: "Summary after attachments." },
    ],
    timestamp: Date.UTC(2026, 2, 24, 15, 41, 0),
    isError: false,
    isStopped: false,
  };

  assert.deepEqual(getOrderedMessageBlocks(message), [
    {
      type: "tool_call",
      part: message.content[0],
    },
    {
      type: "attachments",
      names: ["report.csv", "[image]"],
    },
    {
      type: "text",
      text: "Summary after attachments.",
    },
  ]);
});

test("getOrderedMessageBlocks prepends attachments when the message has no text blocks", () => {
  const message: StoredMessage = {
    role: "assistant",
    content: [
      { type: "file", mediaType: "text/csv", base64Data: "abc", fileName: "balances.csv" },
      {
        type: "tool_call",
        id: "tool-2",
        name: "query_database",
        status: "completed",
        providerStatus: "completed",
        input: "{\"sql\":\"SELECT 2\"}",
        output: "{\"rows\":[{\"value\":2}]}",
        streamPosition: {
          itemId: "tool-2",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 1,
        },
      },
    ],
    timestamp: Date.UTC(2026, 2, 24, 15, 42, 0),
    isError: false,
    isStopped: false,
  };

  assert.deepEqual(getOrderedMessageBlocks(message), [
    {
      type: "attachments",
      names: ["balances.csv"],
    },
    {
      type: "tool_call",
      part: message.content[1],
    },
  ]);
});

test("getOrderedMessageBlocks self-heals scrambled assistant content into real stream chronology", () => {
  const message: StoredMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: "code-2",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('b')",
        output: "b",
        streamPosition: {
          itemId: "code-2-item",
          outputIndex: 5,
          contentIndex: null,
          sequenceNumber: 60,
        },
      },
      {
        type: "reasoning_summary",
        summary: "First thinking summary.",
        streamPosition: {
          itemId: "reasoning-1",
          outputIndex: 0,
          contentIndex: null,
          sequenceNumber: 10,
        },
      },
      {
        type: "tool_call",
        id: "db-2",
        name: "query_database",
        status: "completed",
        providerStatus: "completed",
        input: "{\"sql\":\"SELECT 2\"}",
        output: "{\"rows\":[2]}",
        streamPosition: {
          itemId: "db-2-item",
          outputIndex: 2,
          contentIndex: null,
          sequenceNumber: 30,
        },
      },
      {
        type: "tool_call",
        id: "code-1",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('a')",
        output: "a",
        streamPosition: {
          itemId: "code-1-item",
          outputIndex: 4,
          contentIndex: null,
          sequenceNumber: 50,
        },
      },
      {
        type: "reasoning_summary",
        summary: "Second thinking summary.",
        streamPosition: {
          itemId: "reasoning-2",
          outputIndex: 3,
          contentIndex: null,
          sequenceNumber: 40,
        },
      },
      {
        type: "tool_call",
        id: "db-1",
        name: "query_database",
        status: "completed",
        providerStatus: "completed",
        input: "{\"sql\":\"SELECT 1\"}",
        output: "{\"rows\":[1]}",
        streamPosition: {
          itemId: "db-1-item",
          outputIndex: 1,
          contentIndex: null,
          sequenceNumber: 20,
        },
      },
    ],
    timestamp: Date.UTC(2026, 2, 24, 15, 43, 0),
    isError: false,
    isStopped: false,
  };

  assert.deepEqual(
    getOrderedMessageBlocks(message).map((block) => {
      if (block.type === "reasoning_summary") {
        return block.part.summary;
      }
      if (block.type === "tool_call") {
        return block.part.id;
      }
      throw new Error(`Unexpected block type: ${block.type}`);
    }),
    [
      "First thinking summary.",
      "db-1",
      "db-2",
      "Second thinking summary.",
      "code-1",
      "code-2",
    ],
  );
});
