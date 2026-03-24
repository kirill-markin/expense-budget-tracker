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
