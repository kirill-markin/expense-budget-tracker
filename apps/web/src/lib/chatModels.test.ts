import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_MODEL,
  CHAT_MODEL_BADGE_LABEL,
  CHAT_MODEL_ID,
  CHAT_MODEL_LABEL,
  CHAT_MODEL_REASONING_EFFORT,
  CHAT_MODEL_REASONING_LABEL,
  CHAT_PROVIDER_LABEL,
  CHAT_VENDOR,
} from "./chatModels";

test("chat model config is pinned to GPT-5.4 with medium reasoning", () => {
  assert.deepEqual(CHAT_MODEL, {
    id: CHAT_MODEL_ID,
    label: CHAT_MODEL_LABEL,
    vendor: CHAT_VENDOR,
  });
  assert.equal(CHAT_MODEL_REASONING_EFFORT, "medium");
  assert.equal(CHAT_MODEL_REASONING_LABEL, "Medium");
  assert.equal(CHAT_PROVIDER_LABEL, "OpenAI");
  assert.equal(CHAT_MODEL_BADGE_LABEL, "GPT-5.4 · Medium");
});
