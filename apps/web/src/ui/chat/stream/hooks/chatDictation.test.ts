import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeChatTranscriptionErrorText } from "./chatDictation";

const t = (key: string): string => {
  if (key === "chat.dictationFailed") {
    return "Audio transcription failed. Please try again.";
  }

  throw new Error(`Unexpected translation key: ${key}`);
};

test("sanitizeChatTranscriptionErrorText hides HTML edge responses", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "<html><head><title>403 Forbidden</title></head><body>blocked</body></html>",
    "text/html",
    t,
  );

  assert.equal(sanitizedMessage, "Audio transcription failed. Please try again.");
});

test("sanitizeChatTranscriptionErrorText hides HTML edge fragments", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "<h1>403 Forbidden</h1>",
    null,
    t,
  );

  assert.equal(sanitizedMessage, "Audio transcription failed. Please try again.");
});

test("sanitizeChatTranscriptionErrorText hides text/html edge responses without tags", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "403 Forbidden",
    "text/html; charset=utf-8",
    t,
  );

  assert.equal(sanitizedMessage, "Audio transcription failed. Please try again.");
});

test("sanitizeChatTranscriptionErrorText preserves plain route errors", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "Unsupported audio file type. Use m4a, wav, or webm.",
    "text/plain",
    t,
  );

  assert.equal(sanitizedMessage, "Unsupported audio file type. Use m4a, wav, or webm.");
});
