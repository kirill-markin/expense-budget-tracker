import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAISafetyIdentifier } from "@/server/chat/openai/safetyIdentifier";

test("buildOpenAISafetyIdentifier hashes user IDs into stable non-PII identifiers", (): void => {
  assert.equal(
    buildOpenAISafetyIdentifier("user-1"),
    "v1_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs",
  );
  assert.equal(
    buildOpenAISafetyIdentifier("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
    "v1_j0AMJXYR7V0wwOZgesYQdDB9-iTPcKjpLD6BR9Z9LHA",
  );
});

test("buildOpenAISafetyIdentifier rejects empty user IDs", (): void => {
  assert.throws(
    () => buildOpenAISafetyIdentifier(""),
    /Cannot build OpenAI safety identifier from an empty userId/,
  );
});
