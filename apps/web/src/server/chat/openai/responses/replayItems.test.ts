import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import {
  buildChatFileViewReplayItem,
  listStoredChatFileViewCalls,
  normalizeStoredOpenAIReplayItems,
  toPersistedOpenAIReplayItems,
  toReplayedOpenAIResponseInputItem,
  type StoredOpenAIReplayCompactionItem,
  type StoredOpenAIReplayItem,
  toStoredOpenAIReplayItems,
} from "@/server/chat/openai/responses/replayItems";

const ASSISTANT_REPLAY_ITEM: StoredOpenAIReplayItem = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{
    type: "output_text",
    text: "Answer",
    annotations: [],
  }],
};

/** Missing `encrypted_content` leaves the item unreplayable. */
const UNREPLAYABLE_COMPACTION_ITEM: StoredOpenAIReplayCompactionItem = {
  type: "compaction",
  id: "compaction-1",
  encrypted_content: "",
};

const UNREPLAYABLE_COMPACTION_OUTPUT_ITEM = UNREPLAYABLE_COMPACTION_ITEM as unknown as
  OpenAI.Responses.ResponseOutputItem;

const ASSISTANT_OUTPUT_ITEM = {
  id: "msg-1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{
    type: "output_text",
    text: "Answer",
    annotations: [],
  }],
} as unknown as OpenAI.Responses.ResponseOutputItem;

test("toStoredOpenAIReplayItems drops an unreplayable compaction item instead of throwing", (): void => {
  const result = toStoredOpenAIReplayItems([
    UNREPLAYABLE_COMPACTION_OUTPUT_ITEM,
    ASSISTANT_OUTPUT_ITEM,
  ]);

  assert.equal(result.droppedCompactionItems, 1);
  assert.deepEqual(result.items, [ASSISTANT_REPLAY_ITEM]);
});

test("normalizeStoredOpenAIReplayItems counts a dropped stored compaction item", (): void => {
  const result = normalizeStoredOpenAIReplayItems([
    UNREPLAYABLE_COMPACTION_ITEM,
    ASSISTANT_REPLAY_ITEM,
  ]);

  assert.equal(result.droppedCompactionItems, 1);
  assert.equal(result.droppedReasoningItems, 0);
  assert.deepEqual(result.items, [ASSISTANT_REPLAY_ITEM]);
});

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

const outputPartsOf = (
  item: OpenAI.Responses.ResponseInputItem,
): ReadonlyArray<OpenAI.Responses.ResponseFunctionCallOutputItem> => {
  assert.equal(item.type, "function_call_output");
  const { output } = item as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
  assert.ok(typeof output !== "string");

  return output;
};

const VIEW_REFERENCE = {
  fileId: "11111111-1111-4111-8111-111111111111",
  path: "/files/receipt.png",
  sha256: "a".repeat(64),
  page: null,
} as const;

const VIEWED_IMAGE_ITEM = buildChatFileViewReplayItem(
  "call-view-1",
  '"/files/receipt.png", image/png, 16 bytes. The image follows this line.',
  { type: "input_image", detail: "auto", image_url: IMAGE_DATA_URL },
  VIEW_REFERENCE,
);

/**
 * The whole point of the reference: a native image costs around 1,600 tokens and
 * the same bytes as stored text cost 15,000-25,000, and the row is what every
 * later turn is sized from.
 */
test("a persisted view_file result keeps its text and its reference and never its bytes", (): void => {
  const [persisted] = toPersistedOpenAIReplayItems([VIEWED_IMAGE_ITEM]);

  assert.equal(JSON.stringify(persisted).includes("base64"), false);
  assert.deepEqual(persisted, {
    type: "function_call_output",
    call_id: "call-view-1",
    output: [{
      type: "input_text",
      text: '"/files/receipt.png", image/png, 16 bytes. The image follows this line.',
    }],
    chatFileView: VIEW_REFERENCE,
  });
  assert.deepEqual(
    listStoredChatFileViewCalls([{
      role: "assistant",
      content: [],
      openaiItems: toPersistedOpenAIReplayItems([VIEWED_IMAGE_ITEM]),
    }]),
    [{ callId: "call-view-1", reference: VIEW_REFERENCE }],
  );
});

test("replay rebuilds the native part from the reference, and says so when it cannot", (): void => {
  const [persisted] = toPersistedOpenAIReplayItems([VIEWED_IMAGE_ITEM]);
  assert.ok(persisted !== undefined);

  const rebuilt = toReplayedOpenAIResponseInputItem(
    persisted,
    new Map([["call-view-1", {
      type: "input_image",
      detail: "auto",
      image_url: IMAGE_DATA_URL,
    }]]),
  );
  assert.deepEqual(
    outputPartsOf(rebuilt),
    [
      {
        type: "input_text",
        text: '"/files/receipt.png", image/png, 16 bytes. The image follows this line.',
      },
      { type: "input_image", detail: "auto", image_url: IMAGE_DATA_URL },
    ],
  );

  // An output dropped for a call that is still replayed is answered with
  // `400 No tool call found for function call output`, so the result keeps its
  // text and the model is told the bytes are not here.
  const parts = outputPartsOf(
    toReplayedOpenAIResponseInputItem(persisted, new Map()),
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[1]?.type, "input_text");
  assert.match(
    parts[1]?.type === "input_text" ? parts[1].text : "",
    /Call view_file again/u,
  );
});

test("an incomplete stored reference leaves the result its text instead of a lookup", (): void => {
  const storedWith = (chatFileView: unknown): StoredOpenAIReplayItem => ({
    type: "function_call_output",
    call_id: "call-view-1",
    output: [{ type: "input_text", text: "A file" }],
    chatFileView,
  } as unknown as StoredOpenAIReplayItem);

  for (const chatFileView of [
    { fileId: "f-1", path: "/files/a.png", page: null },
    { fileId: "f-1", path: "/files/a.png", sha256: "a".repeat(64), page: "3" },
  ]) {
    const { items } = normalizeStoredOpenAIReplayItems([storedWith(chatFileView)]);

    assert.deepEqual(items, [{
      type: "function_call_output",
      call_id: "call-view-1",
      output: [{ type: "input_text", text: "A file" }],
    }]);
  }
});
