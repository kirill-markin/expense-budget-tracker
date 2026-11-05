import assert from "node:assert/strict";
import test from "node:test";

import { getDurationParts, splitAssistantWorkBlock } from "./assistantWorkBlock";
import type { OrderedMessageBlock } from "./messageContentOrder";

const text = (value: string): OrderedMessageBlock => ({ type: "text", text: value });

const toolCall = (id: string): OrderedMessageBlock => ({
  type: "tool_call",
  part: {
    type: "tool_call",
    id,
    name: "sql_query",
    status: "completed",
    input: "{}",
    output: "{}",
  },
});

const reasoning = (summary: string): OrderedMessageBlock => ({
  type: "reasoning_summary",
  part: {
    type: "reasoning_summary",
    summary,
    streamPosition: { itemId: "rs-1", outputIndex: 0, contentIndex: 0, sequenceNumber: 0 },
  },
});

const attachments: OrderedMessageBlock = {
  type: "attachments",
  parts: [{
    type: "image",
    fileId: "file-1",
    path: "chat/file-1.png",
    mediaType: "image/png",
    sizeBytes: 1,
  }],
};

test("work runs through the last tool call or reasoning, the text after it is the answer", (): void => {
  const blocks = [
    reasoning("plan"),
    text("Checking accounts."),
    toolCall("tc-1"),
    text("Now the balances."),
    toolCall("tc-2"),
    text("Here is the answer."),
    text("And a footnote."),
  ];

  assert.deepEqual(splitAssistantWorkBlock(blocks), {
    attachments: [],
    work: blocks.slice(0, 5),
    answer: blocks.slice(5),
  });
});

test("a text-only reply has no work", (): void => {
  const blocks = [text("Hello."), text("Bye.")];

  assert.deepEqual(splitAssistantWorkBlock(blocks), {
    attachments: [],
    work: [],
    answer: blocks,
  });
});

test("a reply that ends on work has no answer", (): void => {
  const blocks = [text("Looking."), toolCall("tc-1"), reasoning("next step")];

  assert.deepEqual(splitAssistantWorkBlock(blocks), {
    attachments: [],
    work: blocks,
    answer: [],
  });
});

test("attachments stay outside the work and the answer", (): void => {
  const blocks = [attachments, toolCall("tc-1"), text("Done.")];

  assert.deepEqual(splitAssistantWorkBlock(blocks), {
    attachments: [attachments],
    work: [blocks[1]],
    answer: [blocks[2]],
  });
});

test("duration parts floor to whole seconds, minutes, and hours", (): void => {
  assert.deepEqual(getDurationParts(0), { hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(getDurationParts(59_999), { hours: 0, minutes: 0, seconds: 59 });
  assert.deepEqual(getDurationParts(61_000), { hours: 0, minutes: 1, seconds: 1 });
  assert.deepEqual(getDurationParts(3_725_500), { hours: 1, minutes: 2, seconds: 5 });
});

test("a negative duration is rejected with its value", (): void => {
  assert.throws(() => getDurationParts(-1), /got -1\./);
});
