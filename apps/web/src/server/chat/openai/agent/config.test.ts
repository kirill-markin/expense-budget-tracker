import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import { buildOpenAIModelSettings } from "./config";

test("buildOpenAIModelSettings requests code interpreter outputs in responses", () => {
  assert.deepEqual(buildOpenAIModelSettings(null), {
    reasoning: { effort: CHAT_MODEL_REASONING_EFFORT, summary: "auto" },
    store: true,
    providerData: {
      extraBody: {
        include: ["code_interpreter_call.outputs"],
      },
    },
  });
});

test("buildOpenAIModelSettings preserves forced tool choice", () => {
  assert.deepEqual(buildOpenAIModelSettings("code_interpreter"), {
    reasoning: { effort: CHAT_MODEL_REASONING_EFFORT, summary: "auto" },
    store: true,
    providerData: {
      extraBody: {
        include: ["code_interpreter_call.outputs"],
      },
    },
    toolChoice: "code_interpreter",
  });
});
