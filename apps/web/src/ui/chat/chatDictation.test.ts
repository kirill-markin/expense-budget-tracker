import assert from "node:assert/strict";
import test from "node:test";
import { insertDictationTranscriptIntoDraft } from "./chatDictation";

test("insertDictationTranscriptIntoDraft inserts text into an empty draft", () => {
  assert.deepEqual(
    insertDictationTranscriptIntoDraft("", "hello world", null),
    {
      text: "hello world",
      selection: {
        start: 11,
        end: 11,
      },
    },
  );
});

test("insertDictationTranscriptIntoDraft inserts text into the current selection", () => {
  assert.deepEqual(
    insertDictationTranscriptIntoDraft("before after", "middle", {
      start: 6,
      end: 6,
    }),
    {
      text: "before middle after",
      selection: {
        start: 13,
        end: 13,
      },
    },
  );
});

test("insertDictationTranscriptIntoDraft preserves whitespace around inserted text", () => {
  assert.deepEqual(
    insertDictationTranscriptIntoDraft("beforeafter", "middle", {
      start: 6,
      end: 6,
    }),
    {
      text: "before middle after",
      selection: {
        start: 14,
        end: 14,
      },
    },
  );
});
