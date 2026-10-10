import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import {
  normalizeStoredOpenAIReplayItems,
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
