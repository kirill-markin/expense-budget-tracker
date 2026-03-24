import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOutputTextDelta,
  applyRawTextStreamEvent,
} from "./textStream";

test("applyOutputTextDelta keeps text state separate for different item IDs", () => {
  const firstUpdate = applyOutputTextDelta(
    new Map(),
    {
      text: "Hello",
      itemId: "msg-a",
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: 10,
    },
  );
  const secondUpdate = applyOutputTextDelta(
    firstUpdate.textStates,
    {
      text: "World",
      itemId: "msg-b",
      outputIndex: 1,
      contentIndex: 0,
      sequenceNumber: 20,
    },
  );

  assert.deepEqual(firstUpdate.emittedDelta, {
    text: "Hello",
    itemId: "msg-a",
    outputIndex: 0,
    contentIndex: 0,
    sequenceNumber: 10,
  });
  assert.deepEqual(secondUpdate.emittedDelta, {
    text: "World",
    itemId: "msg-b",
    outputIndex: 1,
    contentIndex: 0,
    sequenceNumber: 20,
  });
  assert.equal(secondUpdate.textStates.get("msg-a:0")?.assembledText, "Hello");
  assert.equal(secondUpdate.textStates.get("msg-b:0")?.assembledText, "World");
});

test("applyRawTextStreamEvent consumes only output_text_delta events", () => {
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
        sequence_number: 10,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.delta",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
        sequence_number: 10,
        delta: "First",
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
  ] as const;

  for (const event of sequence) {
    const update = applyRawTextStreamEvent(textStates, event);
    textStates = update.textStates;
    if (update.emittedDelta !== null) {
      emitted.push(update.emittedDelta.text);
    }
  }

  assert.deepEqual(emitted, ["First"]);
  assert.equal(textStates.get("msg-a:0")?.assembledText, "First");
});

test("applyRawTextStreamEvent handles multiple top-level text items without provider-specific replay", () => {
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
        sequence_number: 10,
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
        sequence_number: 20,
      },
    },
  ] as const;

  for (const event of sequence) {
    const update = applyRawTextStreamEvent(textStates, event);
    textStates = update.textStates;
    if (update.emittedDelta !== null) {
      emitted.push(update.emittedDelta.text);
    }
  }

  assert.deepEqual(emitted, ["First", "Second"]);
  assert.equal(textStates.get("msg-a:0")?.assembledText, "First");
  assert.equal(textStates.get("msg-b:0")?.assembledText, "Second");
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
        sequence_number: 20,
        delta: "{\"sql\":\"SELECT 1\"}",
      },
    },
  );

  assert.equal(update.emittedDelta, null);
  assert.equal(update.textStates.size, 0);
});
