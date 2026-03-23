import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOutputItemDone,
  applyOutputTextDelta,
  applyOutputTextDone,
  applyRawTextStreamEvent,
} from "./textStream";

test("applyOutputTextDelta keeps text state separate for different item IDs", () => {
  const firstUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );
  const secondUpdate = applyOutputTextDelta(
    firstUpdate.textStates,
    {
      type: "response.output_text.delta",
      item_id: "msg-b",
      content_index: 0,
      output_index: 1,
    },
    "World",
  );

  assert.equal(firstUpdate.emittedDelta, "Hello");
  assert.equal(secondUpdate.emittedDelta, "World");
  assert.equal(secondUpdate.textStates.get("msg-a:0")?.assembledText, "Hello");
  assert.equal(secondUpdate.textStates.get("msg-b:0")?.assembledText, "World");
});

test("applyOutputTextDone validates assembled text for the same text part", () => {
  const deltaUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );
  const doneUpdate = applyOutputTextDone(
    deltaUpdate.textStates,
    {
      type: "response.output_text.done",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
      text: "Hello",
    },
  );

  assert.equal(doneUpdate.emittedDelta, null);
  assert.equal(doneUpdate.textStates.get("msg-a:0")?.doneText, "Hello");
  assert.equal(doneUpdate.textStates.get("msg-a:0")?.isDone, true);
});

test("applyOutputTextDone throws a contextual error on documented text mismatch", () => {
  const deltaUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );

  assert.throws(
    () => applyOutputTextDone(
      deltaUpdate.textStates,
      {
        type: "response.output_text.done",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
        text: "Hello!",
      },
    ),
    /OpenAI output_text\.done mismatch for item_id=msg-a content_index=0 output_index=0/,
  );
});

test("applyOutputItemDone requires text parts to be finalized before the message completes", () => {
  const deltaUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );

  assert.throws(
    () => applyOutputItemDone(
      deltaUpdate.textStates,
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg-a",
          type: "message",
        },
      },
    ),
    /OpenAI output_item\.done arrived before output_text\.done/,
  );
});

test("applyRawTextStreamEvent handles multiple text items in one run without prefix assumptions", () => {
  let textStates: ReturnType<typeof applyRawTextStreamEvent>["textStates"] = new Map();
  const emitted: Array<string> = [];

  const sequence = [
    {
      type: "output_text_delta",
      delta: "First",
      providerData: {
        type: "response.output_text.delta",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.done",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
        text: "First",
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg-a",
          type: "message",
        },
      },
    },
    {
      type: "output_text_delta",
      delta: "Second",
      providerData: {
        type: "response.output_text.delta",
        item_id: "msg-b",
        content_index: 0,
        output_index: 1,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.done",
        item_id: "msg-b",
        content_index: 0,
        output_index: 1,
        text: "Second",
      },
    },
    {
      type: "output_text_delta",
      delta: "Third",
      providerData: {
        type: "response.output_text.delta",
        item_id: "msg-c",
        content_index: 0,
        output_index: 2,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.done",
        item_id: "msg-c",
        content_index: 0,
        output_index: 2,
        text: "Third",
      },
    },
  ] as const;

  for (const event of sequence) {
    const update = applyRawTextStreamEvent(textStates, event);
    textStates = update.textStates;
    if (update.emittedDelta !== null) {
      emitted.push(update.emittedDelta);
    }
  }

  assert.deepEqual(emitted, ["First", "Second", "Third"]);
  assert.equal(textStates.get("msg-a:0")?.isDone, true);
  assert.equal(textStates.get("msg-b:0")?.isDone, true);
  assert.equal(textStates.get("msg-c:0")?.isDone, true);
});

test("applyRawTextStreamEvent ignores unrelated raw model events", () => {
  const update = applyRawTextStreamEvent(
    new Map(),
    {
      type: "model",
      event: {
        type: "response.function_call_arguments.delta",
        item_id: "fc_123",
        output_index: 1,
        delta: "{\"sql\":\"SELECT 1\"}",
      },
    },
  );

  assert.equal(update.emittedDelta, null);
  assert.equal(update.textStates.size, 0);
});
